// Hermes 多 Tab Group 管理：每个 session 独立 group，agent 操作互不干扰
// 学自 Claude in Chrome：单 group create + 多 update({groupId}) adopt 新 tab
// 升级：支持多 group 共存（mainTabId → groupId），每个 session 一个 group

const HERMES_GROUP_TITLE = 'Hermes';
// 每开新 group 用不同颜色，方便用户视觉区分多个并行任务
const COLORS: chrome.tabGroups.ColorEnum[] = ['orange', 'blue', 'cyan', 'purple', 'pink', 'green', 'red', 'yellow'];
let colorRotation = 0;

// sessionId → groupId
const sessionToGroup = new Map<string, number>();
// tabId → sessionId（含 main tab + agent 自己开的 tab）
const tabToSession = new Map<number, string>();

/** 给 session 创建专属 Group（首次绑定 main tab）。
 * 注意：chrome://newtab/ 等内置页可能不能进 group，这种情况下：
 *  - 仍然记录 tabToSession 映射
 *  - 不创建 groupId（返回 -1），等 agent 第一次 navigate 后再补建 group
 */
export async function createGroupForSession(sessionId: string, seedTabId: number): Promise<number> {
  // 已有 group → 直接返回
  const existing = sessionToGroup.get(sessionId);
  if (existing != null) {
    try {
      await chrome.tabGroups.get(existing);
      tabToSession.set(seedTabId, sessionId);
      return existing;
    } catch {
      sessionToGroup.delete(sessionId);
    }
  }
  // 先记录 session ownership（即使 group 没建成）
  tabToSession.set(seedTabId, sessionId);
  try {
    const color = COLORS[colorRotation++ % COLORS.length];
    const groupId = await chrome.tabs.group({ tabIds: seedTabId });
    await chrome.tabGroups.update(groupId, { title: HERMES_GROUP_TITLE, color });
    sessionToGroup.set(sessionId, groupId);
    return groupId;
  } catch (e) {
    // chrome://newtab/ 等可能拒绝加 group；后续 navigate 后会自动 retry
    console.warn('[Hermes] 暂时无法 group 这个 tab（可能是 chrome:// 内置页）：', e);
    return -1;
  }
}

/** 尝试给已绑定 session 但还没 group 的 tab 补建 group（agent navigate 后调用） */
export async function ensureGroupForSession(sessionId: string): Promise<number | null> {
  const existing = sessionToGroup.get(sessionId);
  if (existing != null) return existing;
  // 找该 session 拥有的任一 tab 当 seed
  for (const [tabId, sid] of tabToSession.entries()) {
    if (sid === sessionId) {
      try {
        const color = COLORS[colorRotation++ % COLORS.length];
        const groupId = await chrome.tabs.group({ tabIds: tabId });
        await chrome.tabGroups.update(groupId, { title: HERMES_GROUP_TITLE, color });
        sessionToGroup.set(sessionId, groupId);
        return groupId;
      } catch {}
    }
  }
  return null;
}

/** 把 tab 加进 session 的 group（agent 用 open_tab 时） */
export async function addTabToSessionGroup(sessionId: string, tabId: number): Promise<void> {
  let groupId = sessionToGroup.get(sessionId);
  // 没 group 就尝试现在建（之前因 chrome:// 失败的可能现在能成）
  if (groupId == null) {
    const g = await ensureGroupForSession(sessionId);
    if (g == null) {
      // 还是建不了 group，但仍然记录 ownership
      tabToSession.set(tabId, sessionId);
      return;
    }
    groupId = g;
  }
  try {
    await chrome.tabs.group({ tabIds: tabId, groupId });
    tabToSession.set(tabId, sessionId);
  } catch (e) {
    console.warn('[Hermes] addTabToSessionGroup 失败', e);
    tabToSession.set(tabId, sessionId); // 至少记录 ownership
  }
}

export function getSessionGroup(sessionId: string): number | undefined {
  return sessionToGroup.get(sessionId);
}

/** 把一个 session 绑定到已存在的 Chrome tab group，并让该 group 当前归这个 session 控制。 */
export async function adoptExistingGroupForSession(sessionId: string, groupId: number, seedTabId: number): Promise<void> {
  sessionToGroup.set(sessionId, groupId);
  tabToSession.set(seedTabId, sessionId);
  try {
    const tabs = await chrome.tabs.query({ groupId });
    for (const tab of tabs) {
      if (tab.id != null) tabToSession.set(tab.id, sessionId);
    }
  } catch {}
}

export function getSessionByTab(tabId: number): string | undefined {
  return tabToSession.get(tabId);
}

export function getAllSessions(): string[] {
  return Array.from(sessionToGroup.keys());
}

export function getSessionsByGroup(groupId: number): string[] {
  return Array.from(sessionToGroup.entries())
    .filter(([, gid]) => gid === groupId)
    .map(([sid]) => sid);
}

export function forgetGroup(groupId: number): string[] {
  const sessionIds = getSessionsByGroup(groupId);
  for (const sid of sessionIds) sessionToGroup.delete(sid);
  for (const [tabId, sid] of Array.from(tabToSession.entries())) {
    if (sessionIds.includes(sid)) tabToSession.delete(tabId);
  }
  return sessionIds;
}

/** 列出 session group 下所有 tab id */
export async function listSessionTabs(sessionId: string): Promise<number[]> {
  const groupId = sessionToGroup.get(sessionId);
  if (groupId == null) return [];
  const tabs = await chrome.tabs.query({ groupId });
  return tabs.map((t) => t.id!).filter((id) => id != null);
}

/** 解散 session（关闭 group，但不杀 tab） */
export async function dissolveSession(sessionId: string): Promise<void> {
  const groupId = sessionToGroup.get(sessionId);
  sessionToGroup.delete(sessionId);
  // 清掉 tabToSession 中属于这个 session 的条目
  for (const [tabId, sid] of Array.from(tabToSession.entries())) {
    if (sid === sessionId) tabToSession.delete(tabId);
  }
  if (groupId == null) return;
  try {
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length > 0) {
      await chrome.tabs.ungroup(tabs.map((t) => t.id!).filter((id) => id != null));
    }
  } catch {}
}

// tab 关闭时：从 tabToSession 移除；若是 main tab 且 group 空了，清 session
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sid = tabToSession.get(tabId);
  if (!sid) return;
  tabToSession.delete(tabId);
  // 如果该 session 的 group 已经没 tab 了，清 sessionToGroup
  try {
    const groupId = sessionToGroup.get(sid);
    if (groupId != null) {
      const remaining = await chrome.tabs.query({ groupId });
      if (remaining.length === 0) sessionToGroup.delete(sid);
    }
  } catch {}
});
