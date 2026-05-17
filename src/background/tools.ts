// 工具分发器：per-session 工具上下文（每个 agent session 独立 currentTabId）

import * as cdp from './debugger';
import * as tg from './tabGroup';
import type { ToolName } from '../types/messages';

interface SessionToolState {
  currentTabId: number; // agent 当前操作的 tab（navigate/open_tab 会变）
}

const sessionStates = new Map<string, SessionToolState>();
type A11yTree = { pageContent: string; viewport?: { width: number; height: number }; error?: string };
type BatchAction = { tool?: ToolName; name?: ToolName; args?: Record<string, unknown>; input?: Record<string, unknown> };

/** 把 session 绑定到一个 tab（首次发消息时调用） */
export function bindSessionToTab(sessionId: string, tabId: number): void {
  sessionStates.set(sessionId, { currentTabId: tabId });
}

export function getSessionTab(sessionId: string): number | undefined {
  return sessionStates.get(sessionId)?.currentTabId;
}

export function clearSession(sessionId: string): void {
  sessionStates.delete(sessionId);
}

async function getCurrentTab(sessionId: string): Promise<number> {
  const state = sessionStates.get(sessionId);
  if (!state) throw new Error(`Session ${sessionId} 未初始化（请先 bindSessionToTab）`);
  try {
    await chrome.tabs.get(state.currentTabId);
    return state.currentTabId;
  } catch {
    throw new Error(`Session ${sessionId} 的 tab ${state.currentTabId} 已关闭`);
  }
}

// === a11y-tree 注入辅助 ===
async function ensureA11yInjected(tabId: number): Promise<void> {
  const exists = await runInPage<boolean>(tabId, () => typeof window.__hermesGenerateA11yTree === 'function').catch(() => false);
  if (exists) return;
  const cs = chrome.runtime.getManifest().content_scripts?.[0];
  const files = cs?.js as string[] | undefined;
  if (!files || files.length === 0) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
  } catch (e) {
    console.warn('[Hermes] 注入 a11y-tree 失败', e);
  }
}

async function runInPage<T>(tabId: number, func: (...args: any[]) => T, args: unknown[] = []): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    injectImmediately: true,
    func,
    args,
  });
  if (!results.length) throw new Error('页面脚本没有返回结果');
  return results[0].result as T;
}

async function waitForTabComplete(tabId: number, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        await new Promise((r) => setTimeout(r, 600));
        return true;
      }
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// === 工具实现 ===

async function readPage(sessionId: string, args: { ref_id?: string; depth?: number; filter?: 'all' | 'interactive' }) {
  const tabId = await getCurrentTab(sessionId);
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || '';
  if (/^(chrome|edge|brave|chrome-extension|devtools|view-source|about):/.test(url)) {
    return {
      error: `当前页面 (${url}) 是浏览器内部页，无法读取。请先 navigate 到普通网页。`,
      pageContent: '',
      url,
    };
  }
  if (tab.status !== 'complete') await waitForTabComplete(tabId, 8000);
  await ensureA11yInjected(tabId);

  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const parsed = await runInPage<A11yTree>(
        tabId,
        (filter, depth, refId) => {
          if (typeof window.__hermesGenerateA11yTree !== 'function') {
            return { error: 'a11y tree script 未注入', pageContent: '', viewport: { width: window.innerWidth, height: window.innerHeight } };
          }
          return window.__hermesGenerateA11yTree(filter, depth, null, refId);
        },
        [args.filter ?? 'all', args.depth ?? 15, args.ref_id ?? null],
      );
      if (parsed && (parsed.pageContent || parsed.error)) return { ...parsed, url: tab.url, title: tab.title };
      lastErr = 'executeScript 返回空结果';
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  const parsedDebug = await runInPage<Record<string, unknown>>(tabId, () => ({
    has_a11y_func: typeof window.__hermesGenerateA11yTree === 'function',
    ready_state: document.readyState,
    body_size: document.body ? document.body.outerHTML.length : 0,
    link_count: document.querySelectorAll('a').length,
    title: document.title,
    url: location.href,
  })).catch(() => ({}));
  return {
    error: `read_page 失败（尝试 3 次）：${lastErr}。如果只是要读公开网页内容，建议改用 fetch_url。`,
    pageContent: '',
    url: tab.url,
    debug: parsedDebug,
  };
}

async function refIdToCoords(tabId: number, refId: string): Promise<{ x: number; y: number }> {
  await ensureA11yInjected(tabId);
  const coords = await runInPage<{ x: number; y: number } | null>(
    tabId,
    (targetRef) => {
      const el = window.__hermesElementMap && window.__hermesElementMap[targetRef];
      if (!el) return null;
      const node = el.deref ? el.deref() : el;
      if (!(node instanceof Element)) return null;
      const clickable = node.closest('button,a,[role="button"],[role="link"],input,textarea,select,[contenteditable="true"]') || node;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      const r = clickable.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
    [refId],
  );
  if (!coords) throw new Error(`ref_id ${refId} 不存在或元素已移除`);
  return coords;
}

async function clickRef(sessionId: string, args: { ref_id: string }) {
  const tabId = await getCurrentTab(sessionId);
  const { x, y } = await refIdToCoords(tabId, args.ref_id);
  await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PHANTOM_CURSOR', x, y }).catch(() => {});
  await new Promise((r) => setTimeout(r, 220));
  await cdp.mouseClick(tabId, x, y);
  return { clicked: args.ref_id, x, y };
}

async function typeText(sessionId: string, args: { ref_id?: string; text: string; submit?: boolean }) {
  const tabId = await getCurrentTab(sessionId);
  if (args.ref_id) {
    const { x, y } = await refIdToCoords(tabId, args.ref_id);
    await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PHANTOM_CURSOR', x, y }).catch(() => {});
    await new Promise((r) => setTimeout(r, 220));
    await cdp.mouseClick(tabId, x, y);
    await runInPage(tabId, (targetRef) => {
      try {
        const ref = window.__hermesElementMap[targetRef];
        const n = ref && ref.deref ? ref.deref() : null;
        if (!n) return;
        if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement) {
          n.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (setter && setter.set) setter.set.call(n, '');
          else n.value = '';
          n.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (n instanceof HTMLElement && n.isContentEditable) {
          n.focus();
          n.textContent = '';
          n.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch(e) {}
    }, [args.ref_id]);
  }
  await cdp.insertText(tabId, args.text);
  if (args.submit) await cdp.pressKey(tabId, 'Enter');
  return { typed_chars: args.text.length, submitted: !!args.submit };
}

async function scroll(sessionId: string, args: { direction: 'up' | 'down' | 'top' | 'bottom'; amount?: number }) {
  const tabId = await getCurrentTab(sessionId);
  const tab = await chrome.tabs.get(tabId);
  const w = tab.width ?? 1280, h = tab.height ?? 800;
  const cx = Math.round(w / 2), cy = Math.round(h / 2);
  const amt = args.amount ?? Math.round(h * 0.7);
  if (args.direction === 'down') await cdp.mouseWheel(tabId, cx, cy, 0, amt);
  else if (args.direction === 'up') await cdp.mouseWheel(tabId, cx, cy, 0, -amt);
  else if (args.direction === 'top') await cdp.evaluate(tabId, 'window.scrollTo({top:0})');
  else if (args.direction === 'bottom') await cdp.evaluate(tabId, 'window.scrollTo({top:document.body.scrollHeight})');
  return { direction: args.direction };
}

async function navigate(sessionId: string, args: { url: string }) {
  const state = sessionStates.get(sessionId);
  if (!state) throw new Error(`Session ${sessionId} 未初始化`);
  const tabId = state.currentTabId;
  await chrome.tabs.update(tabId, { url: args.url });
  const ready = await waitForTabComplete(tabId);
  // 如果之前 group 没建成（比如 chrome://newtab/ 不能 group），现在跳到普通页可以补建
  await tg.ensureGroupForSession(sessionId).catch(() => {});
  return { tabId, url: args.url, ready };
}

async function openTab(sessionId: string, args: { url: string }) {
  const state = sessionStates.get(sessionId);
  if (!state) throw new Error(`Session ${sessionId} 未初始化`);
  const tab = await chrome.tabs.create({ url: args.url, active: false });
  if (tab.id == null) throw new Error('chrome.tabs.create 没返回 id');
  await tg.addTabToSessionGroup(sessionId, tab.id);
  state.currentTabId = tab.id; // 切到新 tab 上操作
  const ready = await waitForTabComplete(tab.id);
  return { tabId: tab.id, url: args.url, group_id: tg.getSessionGroup(sessionId), ready };
}

async function screenshotTool(sessionId: string, _args: Record<string, unknown>) {
  const tabId = await getCurrentTab(sessionId);
  const shot = await cdp.screenshot(tabId, 'jpeg');
  return shot;
}

async function fetchUrl(_sessionId: string, args: { url: string }) {
  if (!args.url) return { error: 'url 参数缺失' };
  try {
    const r = await fetch(args.url, {
      redirect: 'follow',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const ct = r.headers.get('content-type') || '';
    const html = await r.text();
    return { url: r.url, status: r.status, content_type: ct, html: html.slice(0, 100_000) };
  } catch (e) {
    return { error: `fetch 失败: ${e instanceof Error ? e.message : String(e)}`, url: args.url };
  }
}

async function wait(_sessionId: string, args: { ms: number }) {
  const ms = Math.max(0, Math.min(10_000, Math.floor(args.ms || 0)));
  await new Promise((r) => setTimeout(r, ms));
  return { waited_ms: ms };
}

async function scrollTo(sessionId: string, args: { ref_id: string }) {
  const tabId = await getCurrentTab(sessionId);
  await ensureA11yInjected(tabId);
  return runInPage(tabId, (targetRef) => {
    const ref = window.__hermesElementMap[targetRef];
    const n = ref && ref.deref ? ref.deref() : null;
    if (!(n instanceof Element)) return { error: 'ref_id not found' };
    n.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    const r = n.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, [args.ref_id]);
}

async function pressKey(sessionId: string, args: { key: string }) {
  const tabId = await getCurrentTab(sessionId);
  const parts = args.key.split('+');
  const mainKey = parts[parts.length - 1];
  let modifiers = 0;
  for (const p of parts.slice(0, -1)) {
    if (p === 'Alt') modifiers |= 1;
    if (p === 'Ctrl' || p === 'Control') modifiers |= 2;
    if (p === 'Meta' || p === 'Cmd' || p === 'Command') modifiers |= 4;
    if (p === 'Shift') modifiers |= 8;
  }
  await cdp.pressKey(tabId, mainKey, undefined, modifiers);
  return { pressed: args.key };
}

async function getConsoleLogs(sessionId: string, args: { level?: string; limit?: number }) {
  const tabId = await getCurrentTab(sessionId);
  const lvl = args.level ?? 'all';
  const lim = Math.max(1, Math.min(100, args.limit ?? 30));
  const logs = await runInPage<unknown[]>(tabId, (level, limit) => {
    const buf = (window as any).__hermesConsoleBuffer || [];
    const filtered = level === 'all' ? buf : buf.filter((x: any) => x.level === level);
    return filtered.slice(-limit);
  }, [lvl, lim]).catch(() => []);
  return { logs, filter: lvl };
}

async function tabsContext(sessionId: string, _args: Record<string, unknown>) {
  const currentTabId = await getCurrentTab(sessionId);
  const groupId = tg.getSessionGroup(sessionId);
  const tabIds = await tg.listSessionTabs(sessionId);
  const ids = tabIds.length > 0 ? tabIds : [currentTabId];
  const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
  return {
    currentTabId,
    groupId,
    tabCount: tabs.filter(Boolean).length,
    availableTabs: tabs
      .filter((tab): tab is chrome.tabs.Tab => !!tab && tab.id != null)
      .map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || '', active: !!tab.active, status: tab.status })),
  };
}

function scoreA11yLine(line: string, terms: string[]): number {
  const lower = line.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? term.length : 0), 0);
}

async function findElement(sessionId: string, args: { query: string; tabId?: number; limit?: number }) {
  if (!args.query?.trim()) return { error: 'query 参数缺失' };
  const prevTabId = getSessionTab(sessionId);
  if (args.tabId != null) bindSessionToTab(sessionId, args.tabId);
  try {
    const page = await readPage(sessionId, { filter: 'all', depth: 15 }) as A11yTree & { url?: string; title?: string };
    if (page.error) return page;
    const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.max(1, Math.min(20, args.limit ?? 20));
    const matches = (page.pageContent || '')
      .split('\n')
      .map((line) => ({ line, score: scoreA11yLine(line, terms), ref_id: line.match(/\[(ref_\d+)\]/)?.[1] }))
      .filter((m) => m.ref_id && m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ line, ref_id, score }) => ({ ref_id, score, line: line.trim() }));
    return { query: args.query, count: matches.length, matches, url: page.url, title: page.title };
  } finally {
    if (args.tabId != null && prevTabId != null) bindSessionToTab(sessionId, prevTabId);
  }
}

async function browserBatch(sessionId: string, args: { actions?: BatchAction[] }) {
  const actions = args.actions || [];
  if (!Array.isArray(actions) || actions.length === 0) return { error: 'actions 参数缺失' };
  if (actions.length > 20) return { error: '一次 browser_batch 最多执行 20 个动作' };
  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const tool = action.tool || action.name;
    const input = action.args || action.input || {};
    if (!tool) {
      results.push({ index: i, ok: false, error: 'tool/name 缺失' });
      break;
    }
    if (tool === 'browser_batch') {
      results.push({ index: i, tool, ok: false, error: 'browser_batch 不能嵌套调用自身' });
      break;
    }
    try {
      const data = await execute(sessionId, tool, input);
      results.push({ index: i, tool, ok: true, data });
    } catch (e) {
      results.push({ index: i, tool, ok: false, error: e instanceof Error ? e.message : String(e) });
      break;
    }
  }
  return { results, completed: results.filter((r) => r.ok).length, total: actions.length };
}

const TOOLS: Record<ToolName, (sessionId: string, args: any) => Promise<unknown>> = {
  fetch_url: fetchUrl,
  tabs_context: tabsContext,
  read_page: readPage,
  find: findElement,
  click: clickRef,
  type: typeText,
  scroll,
  scroll_to: scrollTo,
  navigate,
  open_tab: openTab,
  screenshot: screenshotTool,
  wait,
  browser_batch: browserBatch,
  get_console_logs: getConsoleLogs,
  key: pressKey,
};

export async function execute(sessionId: string, tool: ToolName, args: Record<string, unknown>) {
  const fn = TOOLS[tool];
  if (!fn) throw new Error(`未知工具: ${tool}`);
  return fn(sessionId, args);
}
