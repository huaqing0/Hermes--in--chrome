// Service Worker：多 Group 多 session 路由 + WebSocket + 工具执行

import { ws } from './ws';
import * as tools from './tools';
import * as tg from './tabGroup';
import type { ProviderRequest, ProviderStatus, SidepanelMessage, SwToSidepanelMessage } from '../types/messages';
import { HISTORY_STORAGE_KEY, type StoredConversationMap } from '../types/history';

// === per-session 运行状态 ===
type SessionMeta = { isRunning: boolean; mainTabId: number };
const sessionsMeta = new Map<string, SessionMeta>();
const providerRequests = new Map<string, (status: ProviderStatus) => void>();

// === 兼容旧 sidepanel：保留 currentSession，但严格按 active tab 派生 ===
let currentSession: string | null = null;

const TAB_SESSION_KEY = 'hermes_session_by_tab';

function createSessionId(tabId: number): string {
  return `sess_${tabId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function createRequestId(): string {
  return `provider_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sendProviderRequest(
  type: 'provider_status' | 'provider_validate' | 'provider_auth_start' | 'provider_auth_poll' | 'provider_logout',
  request: ProviderRequest,
): Promise<ProviderStatus> {
  if (!ws.isConnected()) {
    return Promise.resolve({
      provider: request.provider,
      ok: false,
      connected: false,
      message: 'Hermes 后端未连接',
      hint: '请先启动 Hermes gateway。',
    });
  }
  const requestId = createRequestId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      providerRequests.delete(requestId);
      resolve({
        provider: request.provider,
        ok: false,
        connected: false,
        message: '连接检查超时',
        hint: '请检查 Hermes gateway 是否仍在运行。',
      });
    }, 15000);
    providerRequests.set(requestId, (status) => {
      clearTimeout(timer);
      resolve(status);
    });
    const sent = ws.send({ type, request_id: requestId, request });
    if (!sent) {
      clearTimeout(timer);
      providerRequests.delete(requestId);
      resolve({
        provider: request.provider,
        ok: false,
        connected: false,
        message: 'Hermes 后端未连接',
      });
    }
  });
}

function tabGroupId(tab: chrome.tabs.Tab): number | null {
  return typeof tab.groupId === 'number' && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
    ? tab.groupId
    : null;
}

function contentScriptWorld(cs: object): chrome.scripting.ExecutionWorld {
  return (cs as { world?: string }).world === 'MAIN' ? 'MAIN' : 'ISOLATED';
}

async function getTabSessionMap(): Promise<Record<string, string>> {
  const stored = await chrome.storage.session.get(TAB_SESSION_KEY);
  return (stored[TAB_SESSION_KEY] as Record<string, string> | undefined) || {};
}
async function setTabSessionMap(m: Record<string, string>): Promise<void> {
  await chrome.storage.session.set({ [TAB_SESSION_KEY]: m });
}

async function bindStoredGroupTabs(groupId: number, sessionId: string, map: Record<string, string>) {
  try {
    const tabs = await chrome.tabs.query({ groupId });
    for (const tab of tabs) {
      if (tab.id != null) map[String(tab.id)] = sessionId;
    }
  } catch {}
}

/**
 * 解析当前 active tab 应使用哪个 session：
 * 1. 这个 tab 已经属于某个 session 的 group → 复用那个 session
 * 2. tabId → sessionId 持久化映射里有 → 复用
 * 3. 都没有 → 新建 session + 新 group（场景 2：用户在新 tab 开新任务）
 */
async function resolveSessionForTab(tabId: number, options?: { createIfMissing?: boolean }): Promise<string | null> {
  // 检查 tab 是否已绑定某个 session 的 group
  const ownerSid = tg.getSessionByTab(tabId);
  if (ownerSid) {
    currentSession = ownerSid;
    tools.bindSessionToTab(ownerSid, tabId); // 同步给 tools
    return ownerSid;
  }
  // 持久化映射
  const map = await getTabSessionMap();
  if (map[String(tabId)]) {
    const sid = map[String(tabId)];
    currentSession = sid;
    // 没 group 就建（重启后状态丢失场景）
    if (tg.getSessionGroup(sid) == null) {
      try {
        await tg.createGroupForSession(sid, tabId);
      } catch {}
    }
    tools.bindSessionToTab(sid, tabId);
    sessionsMeta.set(sid, { isRunning: false, mainTabId: tabId });
    return sid;
  }
  if (!options?.createIfMissing) return null;
  // 新建
  const sid = createSessionId(tabId);
  map[String(tabId)] = sid;
  await setTabSessionMap(map);
  await tg.createGroupForSession(sid, tabId);
  tools.bindSessionToTab(sid, tabId);
  sessionsMeta.set(sid, { isRunning: false, mainTabId: tabId });
  currentSession = sid;
  return sid;
}

async function createFreshSessionForTab(tab: chrome.tabs.Tab, options?: { reuseExistingGroup?: boolean }): Promise<{ sessionId: string; groupId: number | null }> {
  if (tab.id == null) throw new Error('missing tab id');
  const sid = createSessionId(tab.id);
  const map = await getTabSessionMap();
  map[String(tab.id)] = sid;

  const existingGroupId = options?.reuseExistingGroup ? tabGroupId(tab) : null;
  if (existingGroupId != null) {
    await tg.adoptExistingGroupForSession(sid, existingGroupId, tab.id);
    await bindStoredGroupTabs(existingGroupId, sid, map);
  } else {
    await tg.createGroupForSession(sid, tab.id);
  }
  await setTabSessionMap(map);

  const groupId = tg.getSessionGroup(sid) ?? tabGroupId(tab);
  tools.bindSessionToTab(sid, tab.id);
  sessionsMeta.set(sid, { isRunning: false, mainTabId: tab.id });
  currentSession = sid;
  return { sessionId: sid, groupId: groupId ?? null };
}

async function selectSessionForTab(sessionId: string, tab: chrome.tabs.Tab): Promise<{ sessionId: string; groupId: number | null }> {
  if (tab.id == null) throw new Error('missing tab id');
  const map = await getTabSessionMap();
  map[String(tab.id)] = sessionId;

  const existingGroupId = tg.getSessionGroup(sessionId) ?? tabGroupId(tab);
  if (existingGroupId != null) {
    await tg.adoptExistingGroupForSession(sessionId, existingGroupId, tab.id);
    await bindStoredGroupTabs(existingGroupId, sessionId, map);
  } else {
    await tg.createGroupForSession(sessionId, tab.id);
  }
  await setTabSessionMap(map);

  const groupId = tg.getSessionGroup(sessionId) ?? existingGroupId;
  tools.bindSessionToTab(sessionId, tab.id);
  sessionsMeta.set(sessionId, { isRunning: false, mainTabId: tab.id });
  currentSession = sessionId;
  return { sessionId, groupId: groupId ?? null };
}

async function deleteStoredHistoriesForGroup(groupId: number, sessionIds: string[]) {
  const stored = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
  const conversations = (stored[HISTORY_STORAGE_KEY] as StoredConversationMap | undefined) || {};
  let changed = false;
  for (const [sid, conversation] of Object.entries(conversations)) {
    if (conversation.groupId === groupId || sessionIds.includes(sid)) {
      delete conversations[sid];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: conversations });
}

async function deleteStoredTabMappingsForSessions(sessionIds: string[]) {
  if (sessionIds.length === 0) return;
  const map = await getTabSessionMap();
  let changed = false;
  for (const [tabId, sid] of Object.entries(map)) {
    if (sessionIds.includes(sid)) {
      delete map[tabId];
      changed = true;
    }
  }
  if (changed) await setTabSessionMap(map);
}

// tab 关闭：清理 session 映射 + tools 缓存
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await getTabSessionMap();
  const sid = map[String(tabId)];
  if (sid) {
    delete map[String(tabId)];
    await setTabSessionMap(map);
    tools.clearSession(sid);
    sessionsMeta.delete(sid);
    if (currentSession === sid) currentSession = null;
  }
});

chrome.tabGroups.onRemoved.addListener((group) => {
  (async () => {
    const sessionIds = tg.forgetGroup(group.id);
    for (const sid of sessionIds) {
      tools.clearSession(sid);
      sessionsMeta.delete(sid);
      if (currentSession === sid) currentSession = null;
    }
    await deleteStoredTabMappingsForSessions(sessionIds);
    await deleteStoredHistoriesForGroup(group.id, sessionIds);
  })().catch((e) => console.warn('[Hermes SW] 清理 group 历史失败', e));
});

/** SW 启动时给所有已打开 tab 注入 content scripts */
async function injectAllContentScriptsToExistingTabs() {
  const allCs = chrome.runtime.getManifest().content_scripts || [];
  if (allCs.length === 0) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (/^(chrome|chrome-extension|edge|brave|devtools|view-source|about):/.test(tab.url)) continue;
    for (const cs of allCs) {
      const files = (cs.js || []) as string[];
      if (files.length === 0) continue;
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: cs.all_frames === true },
          files,
          world: contentScriptWorld(cs),
        })
        .catch(() => {});
    }
  }
}

// === 启动 ===
ws.start();
ensureOffscreen();
injectAllContentScriptsToExistingTabs();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
  console.warn('[Hermes SW] setPanelBehavior 失败', e);
});

// === 用户切 tab：只更新 currentSession 让 sidepanel 显示对应历史，不动任何 session 的 currentTabId ===
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    // 仅当这个 tab 已经属于某 session 才切 currentSession（不主动新建）
    // 注意：包括 chrome://newtab/ 也允许（用户可能在新标签页要 agent 跳转）
    const sid = await resolveSessionForTab(tabId, { createIfMissing: false });
    if (sid) currentSession = sid;
    else currentSession = null; // 这个 tab 没 session，sidepanel 显示空
  } catch {}
});

// === 点 H 图标（onClicked 在 setPanelBehavior=true 时不触发，但保留作为 fallback） ===
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  await resolveSessionForTab(tab.id, { createIfMissing: true });
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== 'toggle-side-panel') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
    if (tab?.id == null) return;
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    await resolveSessionForTab(tab.id, { createIfMissing: true });
  });
});

// === Sidepanel → SW ===
chrome.runtime.onMessage.addListener((msg: SidepanelMessage, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'SP_SUBMIT') {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab?.id == null) {
        const errMsg = '没有找到 active tab';
        relayToSidepanel({ type: 'SW_ERROR', error: errMsg });
        relayToSidepanel({ type: 'SW_COMPLETE' });
        sendResponse({ ok: false, error: errMsg });
        return;
      }
      // 拿/建 session（首次发消息时绑定）
      const sid = (await resolveSessionForTab(activeTab.id, { createIfMissing: true }))!;
      const meta = sessionsMeta.get(sid);
      if (meta) meta.isRunning = true;
      // 从 sidepanel 传来的消息里直接拿 settings（per-session）
      const settings = msg.settings || {};
      ws.send({
        type: 'user_message',
        session_id: sid,
        text: msg.text,
        context: { url: activeTab.url, title: activeTab.title },
        settings,
      });
      // 只给该 session 的 group 显示 indicators
      broadcastToSessionGroup(sid, { type: 'SHOW_AGENT_INDICATORS' });
      sendResponse({ ok: true, session: sid, groupId: tg.getSessionGroup(sid) ?? tabGroupId(activeTab) });
    } else if (msg.type === 'SP_PROVIDER_STATUS') {
      const status = await sendProviderRequest('provider_status', msg.request);
      sendResponse({ ok: true, status });
    } else if (msg.type === 'SP_PROVIDER_VALIDATE') {
      const status = await sendProviderRequest('provider_validate', msg.request);
      sendResponse({ ok: true, status });
    } else if (msg.type === 'SP_PROVIDER_AUTH_START') {
      const status = await sendProviderRequest('provider_auth_start', msg.request);
      sendResponse({ ok: true, status });
    } else if (msg.type === 'SP_PROVIDER_AUTH_POLL') {
      const status = await sendProviderRequest('provider_auth_poll', msg.request);
      sendResponse({ ok: true, status });
    } else if (msg.type === 'SP_PROVIDER_LOGOUT') {
      const status = await sendProviderRequest('provider_logout', msg.request);
      sendResponse({ ok: true, status });
    } else if (msg.type === 'SP_STOP') {
      // 停当前 sidepanel 显示的 session
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      let sid: string | null = currentSession;
      if (activeTab?.id != null) {
        sid = (await resolveSessionForTab(activeTab.id, { createIfMissing: false })) ?? sid;
      }
      if (sid) {
        ws.send({ type: 'stop', session_id: sid });
        const meta = sessionsMeta.get(sid);
        if (meta) meta.isRunning = false;
        broadcastToSessionGroup(sid, { type: 'HIDE_AGENT_INDICATORS' });
      }
      sendResponse({ ok: true });
    } else if (msg.type === 'SP_SWITCH_TAB') {
      const sid = await resolveSessionForTab(msg.tabId, { createIfMissing: false });
      sendResponse({ ok: true, sessionId: sid, groupId: sid ? tg.getSessionGroup(sid) : undefined });
    } else if (msg.type === 'SP_NEW_CHAT') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id != null) {
        const created = await createFreshSessionForTab(tab, { reuseExistingGroup: true });
        sendResponse({ ok: true, sessionId: created.sessionId, groupId: created.groupId });
        return;
      }
      sendResponse({ ok: false, error: '没有找到 active tab' });
    } else if (msg.type === 'SP_SELECT_SESSION') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id != null) {
        const selected = await selectSessionForTab(msg.sessionId, tab);
        sendResponse({ ok: true, sessionId: selected.sessionId, groupId: selected.groupId });
        return;
      }
      sendResponse({ ok: false, error: '没有找到 active tab' });
    } else if (msg.type === 'SP_TOOL_APPROVAL') {
      ws.send({ type: 'tool_approval', id: msg.id, approved: msg.approved, session_id: msg.session_id });
      sendResponse({ ok: true });
    } else if (msg.type === 'SP_GET_STATUS') {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id != null && tab.url && /^https?:/.test(tab.url)) {
          // 注入 content scripts（旧 tab）
          const allCs = chrome.runtime.getManifest().content_scripts || [];
          for (const cs of allCs) {
            const files = (cs.js || []) as string[];
            if (files.length === 0) continue;
            chrome.scripting
              .executeScript({
                target: { tabId: tab.id, allFrames: cs.all_frames === true },
                files,
                world: contentScriptWorld(cs),
              })
              .catch(() => {});
          }
          // 解析当前 tab 的 session（不强建）
          await resolveSessionForTab(tab.id, { createIfMissing: false });
          if (currentSession) {
            broadcastToSessionGroup(currentSession, { type: 'SHOW_STATIC_INDICATOR' });
          }
        }
      } catch (e) {
        console.warn('[Hermes SW] sidepanel 启动注入失败', e);
      }
      sendResponse({
        ok: true,
        connected: ws.isConnected(),
        sessionId: currentSession,
        groupId: currentSession ? tg.getSessionGroup(currentSession) : undefined,
      });
    }
  })();
  return true;
});

// === Backend → SW ===
ws.on(async (msg) => {
  if (
    msg.type === 'provider_status_result' ||
    msg.type === 'provider_validate_result' ||
    msg.type === 'provider_auth_start_result' ||
    msg.type === 'provider_auth_poll_result' ||
    msg.type === 'provider_logout_result'
  ) {
    const resolve = providerRequests.get(msg.request_id);
    if (resolve) {
      providerRequests.delete(msg.request_id);
      resolve(msg.status);
    }
  } else if (msg.type === 'thinking_delta' || msg.type === 'text_delta') {
    relayToSidepanel({
      type: 'SW_DELTA',
      channel: msg.type === 'thinking_delta' ? 'thinking' : 'text',
      text: msg.text,
      session_id: msg.session_id,
    });
  } else if (msg.type === 'tool_approval_request') {
    // 转发给 sidepanel，让用户审批
    relayToSidepanel({
      type: 'SW_TOOL_APPROVAL_REQUEST',
      id: msg.id,
      tool: msg.tool,
      args: msg.args,
      session_id: msg.session_id,
    });
  } else if (msg.type === 'tool_call') {
    const sid = msg.session_id;
    relayToSidepanel({ type: 'SW_TOOL_CALL', id: msg.id, tool: msg.tool, args: msg.args, session_id: sid });
    try {
      const data = await tools.execute(sid, msg.tool, msg.args);
      ws.send({ type: 'tool_result', id: msg.id, ok: true, data, session_id: sid });
      relayToSidepanel({ type: 'SW_TOOL_RESULT', id: msg.id, ok: true, data, session_id: sid });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      ws.send({ type: 'tool_error', id: msg.id, ok: false, error: err, session_id: sid });
      relayToSidepanel({ type: 'SW_TOOL_RESULT', id: msg.id, ok: false, error: err, session_id: sid });
    }
  } else if (msg.type === 'message_complete') {
    relayToSidepanel({ type: 'SW_COMPLETE', session_id: msg.session_id });
    if (msg.session_id) {
      const meta = sessionsMeta.get(msg.session_id);
      if (meta) meta.isRunning = false;
      broadcastToSessionGroup(msg.session_id, { type: 'HIDE_AGENT_INDICATORS' });
    }
  } else if (msg.type === 'error') {
    relayToSidepanel({ type: 'SW_ERROR', error: msg.error, session_id: msg.session_id });
    if (msg.session_id) {
      const meta = sessionsMeta.get(msg.session_id);
      if (meta) meta.isRunning = false;
      broadcastToSessionGroup(msg.session_id, { type: 'HIDE_AGENT_INDICATORS' });
    }
  }
});

// === 浮动 Stop 按钮 / 静态指示器消息处理 ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'STOP_AGENT') {
    // Stop 来自具体 tab → 找到该 tab 的 session
    const tabId = sender.tab?.id;
    let sid: string | null = null;
    if (tabId != null) sid = tg.getSessionByTab(tabId) ?? null;
    if (!sid) sid = currentSession;
    if (sid) {
      ws.send({ type: 'stop', session_id: sid });
      const meta = sessionsMeta.get(sid);
      if (meta) meta.isRunning = false;
      broadcastToSessionGroup(sid, { type: 'HIDE_AGENT_INDICATORS' });
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'STATIC_INDICATOR_HEARTBEAT') {
    (async () => {
      const tabId = sender.tab?.id;
      if (tabId == null) return sendResponse({ alive: false });
      const sid = tg.getSessionByTab(tabId);
      sendResponse({ alive: !!sid, sessionId: sid });
    })();
    return true;
  }
  if (msg?.type === 'STATIC_OPEN_SIDEPANEL') {
    if (sender.tab?.id != null) chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

function relayToSidepanel(msg: SwToSidepanelMessage) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/** 给某 session 的 group 内所有 tab 广播指示器消息 */
async function broadcastToSessionGroup(sessionId: string, msg: { type: string; [k: string]: unknown }) {
  const ids = await tg.listSessionTabs(sessionId);
  for (const id of ids) chrome.tabs.sendMessage(id, msg).catch(() => {});
}

// === Offscreen document（SW keepalive）===
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument?.();
  if (exists) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Service Worker 心跳保活',
    });
  } catch (e) {
    console.warn('[Hermes SW] offscreen 创建失败', e);
  }
}
