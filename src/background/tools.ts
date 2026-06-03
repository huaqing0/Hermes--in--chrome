// 工具分发器：per-session 工具上下文（每个 agent session 独立 currentTabId）

import * as cdp from './debugger';
import * as tg from './tabGroup';
import type { ToolName, ClipboardSnapshot, ClipboardRestoreResult } from '../types/messages';

interface SessionToolState {
  currentTabId: number; // agent 当前操作的 tab（navigate/open_tab 会变）
}

const sessionStates = new Map<string, SessionToolState>();
const richTextDirtyTabs = new Map<number, { sessionId: string; url?: string; reason: string; ts: number }>();
type A11yTree = { pageContent: string; viewport?: { width: number; height: number }; error?: string };
type BatchAction = { tool?: ToolName; name?: ToolName; args?: Record<string, unknown>; input?: Record<string, unknown> };
type TypeResult = {
  typed_chars: number;
  submitted: boolean;
  verified: true;
  strategy: string;
  target_kind: string;
  scope_kind: string;
  submit_button_disabled: boolean;
  actual_text_preview: string;
  tabId?: number;
  url?: string;
  title?: string;
  submit_method?: string;
  submit_button_ref?: string;
  submit_button_label?: string;
  post_submit_text_still_present?: boolean;
  candidate_submit_buttons?: SubmitCandidate[];
  attempted_submit_buttons?: SubmitCandidate[];
  clipboard_restore_mode?: 'full' | 'text' | 'failed';
  clipboard_restore_error?: string;
};
type TabContext = { tabId: number; url: string; title: string; status?: string };
type RectInfo = { x: number; y: number; width: number; height: number };
type DomTarget = {
  ref_id: string;
  kind: 'editable' | 'clickable';
  tag: string;
  role: string;
  label: string;
  text: string;
  placeholder: string;
  rect: RectInfo;
  disabled?: boolean;
  hasSvg?: boolean;
  nearestEditableRef?: string;
  nearestEditableDistance?: number;
  notes?: string[];
};
type SubmitCandidate = {
  ref_id: string;
  label: string;
  tag: string;
  role: string;
  score: number;
  x: number;
  y: number;
  disabled?: boolean;
  hasSvg?: boolean;
  same_row?: boolean;
  right_of_editor?: boolean;
  distance?: number;
};
type SubmitAttempt = {
  submitted: boolean;
  method: string;
  button?: SubmitCandidate;
  candidates: SubmitCandidate[];
  attempted_buttons?: SubmitCandidate[];
  post_submit_text_still_present?: boolean;
  post_submit_text_preview?: string;
};
type EditableStatus = {
  ok: boolean;
  target_kind: string;
  scope_kind: string;
  actual_text: string;
  residue_preview: string;
  placeholder_visible: boolean;
  submit_button_label?: string;
  submit_button_disabled?: boolean;
  error?: string;
  rollback?: boolean;
  tried: string[];
};
type EditableSnapshot = { index: number; text: string; target: boolean };
type AtomicTypePreparation = {
  ok: boolean;
  token: string;
  target_kind: string;
  scope_kind: string;
  actual_text: string;
  snapshots: EditableSnapshot[];
  tried: string[];
  error?: string;
};
type DraftInspection = {
  empty: boolean;
  target_kind: string;
  scope_kind: string;
  target_text: string;
  all_text: string;
  residue_preview: string;
  tried: string[];
  error?: string;
};
type VisualInspectArgs = {
  question?: string;
  ref_id?: string;
  scope?: 'viewport' | 'element';
};
type NetworkArgs = {
  tabId?: number;
  limit?: number;
  filter?: string;
  includeHeaders?: boolean;
  includeFailed?: boolean;
  includeBody?: boolean;
};
type HoverArgs = {
  tabId?: number;
  x?: number;
  y?: number;
  ref_id?: string;
};
type DragArgs = {
  tabId?: number;
  from_ref_id?: string;
  to_ref_id?: string;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
};
type CloseTabArgs = {
  tabId?: number;
  force?: boolean;
};

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

chrome.tabs.onRemoved.addListener((tabId) => richTextDirtyTabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) richTextDirtyTabs.delete(tabId);
});

async function getRichTextDirtyState(tabId: number) {
  const dirty = richTextDirtyTabs.get(tabId);
  if (!dirty) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || (dirty.url && tab.url && dirty.url !== tab.url)) {
    richTextDirtyTabs.delete(tabId);
    return null;
  }
  return dirty;
}

async function markRichTextDirty(tabId: number, sessionId: string, reason: string): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  richTextDirtyTabs.set(tabId, { sessionId, url: tab?.url, reason, ts: Date.now() });
}

function richTextDirtyError(dirty: { reason: string }): string {
  return `Previous rich-text input failed; the page may still have hidden X/YouTube draft residue. Further input/submit is blocked. To recover, call navigate(url=<current url>) or close+reopen the tab — the lock auto-clears on page load. Reason: ${dirty.reason}`;
}

async function getCurrentTab(sessionId: string): Promise<number> {
  const state = sessionStates.get(sessionId);
  if (!state) throw new Error(`Session ${sessionId} not initialized (call bindSessionToTab first)`);
  try {
    await chrome.tabs.get(state.currentTabId);
    return state.currentTabId;
  } catch {
    throw new Error(`Session ${sessionId} tab ${state.currentTabId} has been closed`);
  }
}

async function getTabContext(tabId: number): Promise<TabContext> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return {
    tabId,
    url: tab?.url || '',
    title: tab?.title || '',
    status: tab?.status,
  };
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

async function runInPage<T>(tabId: number, func: (...args: any[]) => T, args: unknown[] = [], world: chrome.scripting.ExecutionWorld = 'ISOLATED'): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    injectImmediately: true,
    func,
    args,
    world,
  });
  if (!results.length) throw new Error('Page script returned no result');
  return results[0].result as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureClipboardOffscreen(): Promise<void> {
  const exists = await chrome.offscreen.hasDocument?.();
  if (exists) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Rich-text input needs temporary clipboard write/restore',
    });
  } catch (e) {
    if (await chrome.offscreen.hasDocument?.()) return;
    throw e;
  }
}

async function clipboardReadSnapshot(): Promise<ClipboardSnapshot> {
  await ensureClipboardOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: 'HERMES_CLIPBOARD_READ' }) as { ok?: boolean; snapshot?: ClipboardSnapshot; error?: string };
  if (!resp?.ok) throw new Error(resp?.error || 'Failed to read clipboard');
  if (!resp.snapshot) throw new Error('Clipboard read returned empty snapshot');
  return resp.snapshot;
}

async function clipboardWriteText(text: string): Promise<void> {
  await ensureClipboardOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: 'HERMES_CLIPBOARD_WRITE_TEXT', text }) as { ok?: boolean; error?: string };
  if (!resp?.ok) throw new Error(resp?.error || 'Failed to write to clipboard');
}

async function restoreClipboardSnapshot(snapshot: ClipboardSnapshot): Promise<ClipboardRestoreResult> {
  await ensureClipboardOffscreen();
  const resp = await chrome.runtime.sendMessage({ type: 'HERMES_CLIPBOARD_RESTORE', snapshot }) as ClipboardRestoreResult & { ok?: boolean };
  if (!resp?.ok) return { mode: 'failed', error: resp?.error || 'Failed to restore clipboard' };
  return { mode: resp.mode, error: resp.error };
}

async function withTemporaryClipboard<T>(text: string, run: () => Promise<T>): Promise<{ result: T; clipboardRestore: ClipboardRestoreResult }> {
  let original: ClipboardSnapshot;
  try {
    original = await clipboardReadSnapshot();
  } catch (e) {
    throw new Error(`Failed to snapshot original clipboard; rich-text input aborted to avoid overwriting user clipboard: ${e instanceof Error ? e.message : String(e)}`);
  }

  await clipboardWriteText(text);

  let result: T | undefined;
  let caught: unknown;
  try {
    result = await run();
  } catch (e) {
    caught = e;
  }

  const clipboardRestore = await restoreClipboardSnapshot(original);

  if (caught) {
    if (caught instanceof Error) {
      (caught as Error & { clipboardRestore?: ClipboardRestoreResult }).clipboardRestore = clipboardRestore;
    }
    throw caught;
  }

  return { result: result as T, clipboardRestore };
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
      error: `Current page (${url}) is a browser-internal URL and cannot be read. Navigate to a normal web page first.`,
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
            return { error: 'a11y tree script not injected', pageContent: '', viewport: { width: window.innerWidth, height: window.innerHeight } };
          }
          return window.__hermesGenerateA11yTree(filter, depth, null, refId);
        },
        [args.filter ?? 'all', args.depth ?? 15, args.ref_id ?? null],
      );
      if (parsed && (parsed.pageContent || parsed.error)) return { ...parsed, url: tab.url, title: tab.title };
      lastErr = 'executeScript returned an empty result';
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
    error: `read_page failed after 3 attempts: ${lastErr}. If you just need the public page content, use fetch_url instead.`,
    pageContent: '',
    url: tab.url,
    debug: parsedDebug,
  };
}

async function scanInteractiveTargets(tabId: number, limit = 60): Promise<{ editables: DomTarget[]; clickables: DomTarget[]; active?: DomTarget | null; viewport: { width: number; height: number } }> {
  await ensureA11yInjected(tabId);
  return runInPage(
    tabId,
    (maxItems) => {
      type PageRect = { x: number; y: number; width: number; height: number };
      type PageTarget = {
        ref_id: string;
        kind: 'editable' | 'clickable';
        tag: string;
        role: string;
        label: string;
        text: string;
        placeholder: string;
        rect: PageRect;
        disabled?: boolean;
        hasSvg?: boolean;
        nearestEditableRef?: string;
        nearestEditableDistance?: number;
        notes?: string[];
      };

      const w = window as any;
      if (!w.__hermesElementMap) w.__hermesElementMap = {};
      if (!w.__hermesRefCounter) w.__hermesRefCounter = 0;

      function getOrCreateRef(el: Element): string {
        for (const key in w.__hermesElementMap) {
          if (w.__hermesElementMap[key]?.deref?.() === el) return key;
        }
        const ref = `ref_${++w.__hermesRefCounter}`;
        w.__hermesElementMap[ref] = new WeakRef(el);
        return ref;
      }

      function roleOf(el: Element): string {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit.trim().toLowerCase();
        const tag = el.tagName.toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a') return 'link';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        if (tag === 'input') {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (['button', 'submit', 'file'].includes(type)) return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          return 'textbox';
        }
        const editable = el.getAttribute('contenteditable');
        if (editable === 'true' || editable === 'plaintext-only') return 'textbox';
        return 'generic';
      }

      function rectOf(el: Element): PageRect {
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }

      function isVisible(el: Element): boolean {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el as HTMLElement);
        return r.width > 0
          && r.height > 0
          && r.bottom > 0
          && r.right > 0
          && r.top < window.innerHeight
          && r.left < window.innerWidth
          && s.display !== 'none'
          && s.visibility !== 'hidden'
          && parseFloat(s.opacity || '1') > 0.05;
      }

      function elementText(el: Element): string {
        return ((el as HTMLInputElement).value || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      }

      function labelOf(el: Element): string {
        const svgTitle = el.querySelector('svg title,title')?.textContent?.trim();
        return [
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('placeholder'),
          el.getAttribute('alt'),
          svgTitle,
          elementText(el),
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      }

      function elementContextSignature(el: Element): string {
        const parts: string[] = [];
        let node: Element | null = el;
        for (let depth = 0; node && node !== document.body && depth < 7; depth += 1) {
          const html = node as HTMLElement;
          const className = typeof html.className === 'string' ? html.className : '';
          parts.push(
            node.tagName,
            node.id || '',
            className,
            node.getAttribute('role') || '',
            node.getAttribute('aria-label') || '',
            node.getAttribute('title') || '',
            node.getAttribute('placeholder') || '',
            node.getAttribute('aria-placeholder') || '',
            node.getAttribute('data-e2e') || '',
            node.getAttribute('data-testid') || '',
            node.getAttribute('data-test-id') || '',
          );
          if (depth <= 2) parts.push((node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180));
          node = node.parentElement;
        }
        return parts.filter(Boolean).join(' ').toLowerCase();
      }

      function isBulletScreenControl(el: Element): boolean {
        const host = location.hostname.toLowerCase();
        if (!/(^|\.)douyin\.com$|(^|\.)bilibili\.com$|(^|\.)b23\.tv$/.test(host)) return false;
        const signature = elementContextSignature(el);
        const ownText = [
          labelOf(el),
          el.getAttribute('placeholder'),
          el.getAttribute('aria-placeholder'),
          elementText(el),
        ].filter(Boolean).join(' ').toLowerCase();
        if (/(弹幕|发弹幕|发送弹幕|danmu|danmaku|barrage|bullet[-_ ]?screen)/i.test(signature)) return true;
        const playerLike = /(xgplayer|bpx[-_]?player|bilibili[-_]?player|web[-_]?player|video[-_]?controls?|controlbar|controller|播放器)/i.test(signature);
        const commentLike = /(评论|回复|comment|reply)/i.test(ownText);
        const rect = el.getBoundingClientRect();
        return playerLike && !commentLike && rect.top > window.innerHeight * 0.55;
      }

      function isEditable(el: Element): boolean {
        if (el instanceof HTMLTextAreaElement) return true;
        if (el instanceof HTMLInputElement) {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          return !['hidden', 'button', 'submit', 'checkbox', 'radio', 'file', 'range', 'color'].includes(type);
        }
        if (el instanceof HTMLElement && el.isContentEditable) return true;
        return el.getAttribute('role') === 'textbox';
      }

      function clickableRoot(el: Element): Element | null {
        if (el.closest('[contenteditable="true"],[contenteditable="plaintext-only"],textarea,input,[role="textbox"]')) return null;
        return el.closest('button,[role="button"],a,[role="link"],summary,[tabindex]') || el;
      }

      function isDisabled(el: Element): boolean {
        const s = window.getComputedStyle(el as HTMLElement);
        return (el instanceof HTMLButtonElement && el.disabled)
          || (el instanceof HTMLInputElement && el.disabled)
          || el.getAttribute('disabled') != null
          || el.getAttribute('aria-disabled') === 'true'
          || s.pointerEvents === 'none';
      }

      function isClickable(el: Element): boolean {
        const tag = el.tagName.toLowerCase();
        const role = roleOf(el);
        const style = window.getComputedStyle(el as HTMLElement);
        if (['button', 'a', 'summary'].includes(tag)) return true;
        if (['button', 'link', 'menuitem', 'tab', 'option'].includes(role)) return true;
        if (el.hasAttribute('tabindex')) return true;
        if ((el.getAttribute('aria-label') || el.getAttribute('title')) && style.cursor === 'pointer') return true;
        if (style.cursor === 'pointer' && !!el.querySelector('svg,path')) return true;
        return false;
      }

      function collect(root: ParentNode, out: Element[], seen: Set<Element>) {
        for (const el of Array.from(root.children || [])) {
          if (seen.has(el)) continue;
          seen.add(el);
          out.push(el);
          const shadow = (el as HTMLElement).shadowRoot;
          if (shadow) collect(shadow, out, seen);
          collect(el, out, seen);
        }
      }

      function distance(a: PageRect, b: PageRect): number {
        return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
      }

      const all: Element[] = [];
      collect(document.body, all, new Set<Element>());
      const editables = all.filter((el) => isEditable(el) && isVisible(el));
      const editableTargets: PageTarget[] = editables.map((el) => ({
        ref_id: getOrCreateRef(el),
        kind: 'editable',
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        label: labelOf(el),
        text: elementText(el),
        placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || '',
        rect: rectOf(el),
        disabled: isDisabled(el),
        hasSvg: !!el.querySelector('svg,path'),
        notes: isBulletScreenControl(el) ? ['blocked-danmu-player-control'] : [],
      }));
      const eligibleEditableTargets = editableTargets.filter((target) => !target.notes?.includes('blocked-danmu-player-control'));

      const clickSeen = new Set<Element>();
      const clickableTargets: PageTarget[] = [];
      for (const el of all) {
        if (!isClickable(el) || !isVisible(el)) continue;
        const root = clickableRoot(el);
        if (!root || clickSeen.has(root) || !isVisible(root)) continue;
        clickSeen.add(root);
        const rect = rectOf(root);
        let nearest: PageTarget | undefined;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const editable of eligibleEditableTargets) {
          const d = distance(rect, editable.rect);
          if (d < nearestDistance) {
            nearestDistance = d;
            nearest = editable;
          }
        }
        const notes: string[] = [];
        if (isBulletScreenControl(root)) notes.push('blocked-danmu-player-control');
        if (!labelOf(root) && root.querySelector('svg,path')) notes.push('icon-only');
        if (nearest && nearestDistance < 260) notes.push('near-editable');
        clickableTargets.push({
          ref_id: getOrCreateRef(root),
          kind: 'clickable',
          tag: root.tagName.toLowerCase(),
          role: roleOf(root),
          label: labelOf(root),
          text: elementText(root),
          placeholder: root.getAttribute('placeholder') || '',
          rect,
          disabled: isDisabled(root),
          hasSvg: !!root.querySelector('svg,path'),
          nearestEditableRef: nearest?.ref_id,
          nearestEditableDistance: Number.isFinite(nearestDistance) ? nearestDistance : undefined,
          notes,
        });
      }

      const activeEl = document.activeElement instanceof Element ? document.activeElement : null;
      const active = activeEl && isVisible(activeEl)
        ? {
          ref_id: getOrCreateRef(activeEl),
          kind: isEditable(activeEl) ? 'editable' as const : 'clickable' as const,
          tag: activeEl.tagName.toLowerCase(),
          role: roleOf(activeEl),
          label: labelOf(activeEl),
          text: elementText(activeEl),
          placeholder: activeEl.getAttribute('placeholder') || activeEl.getAttribute('aria-placeholder') || '',
          rect: rectOf(activeEl),
          disabled: isDisabled(activeEl),
          hasSvg: !!activeEl.querySelector('svg,path'),
        }
        : null;

      return {
        editables: eligibleEditableTargets.slice(0, maxItems),
        clickables: clickableTargets
          .filter((target) => !target.notes?.includes('blocked-danmu-player-control'))
          .sort((a, b) => (a.nearestEditableDistance ?? 9999) - (b.nearestEditableDistance ?? 9999))
          .slice(0, maxItems),
        active,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    },
    [Math.max(1, Math.min(120, Math.floor(limit)))],
  );
}

async function inspectTargets(sessionId: string, args: { limit?: number }) {
  const tabId = await getCurrentTab(sessionId);
  const context = await getTabContext(tabId);
  const inspected = await scanInteractiveTargets(tabId, args.limit ?? 60);
  return { ...context, ...inspected };
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
  if (!coords) throw new Error(`ref_id ${refId} not found or element removed`);
  return coords;
}

function parsePoint(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return Math.round(value);
}

async function resolvePoint(tabId: number, input: HoverArgs, label: string): Promise<{ x: number; y: number }> {
  if (typeof input.ref_id === 'string' && input.ref_id.trim()) {
    return refIdToCoords(tabId, input.ref_id.trim());
  }
  if (input.x != null || input.y != null) {
    if (input.x == null || input.y == null) {
      throw new Error(`${label}: both x and y are required when ref_id is not provided`);
    }
    return { x: parsePoint(input.x, `${label}.x`), y: parsePoint(input.y, `${label}.y`) };
  }
  throw new Error(`${label}: provide ref_id or x/y`);
}

async function withTabId<T>(sessionId: string, requestedTabId: number | undefined, handler: (tabId: number) => Promise<T>): Promise<T> {
  const prevTab = getSessionTab(sessionId);
  if (requestedTabId != null) bindSessionToTab(sessionId, requestedTabId);
  try {
    const tabId = await getCurrentTab(sessionId);
    return await handler(tabId);
  } finally {
    if (prevTab != null) bindSessionToTab(sessionId, prevTab);
  }
}

async function clickRef(sessionId: string, args: { ref_id: string }) {
  const tabId = await getCurrentTab(sessionId);
  const dirty = await getRichTextDirtyState(tabId);
  if (dirty && await refIdLooksLikeSubmitButton(tabId, args.ref_id)) {
    throw new Error(richTextDirtyError(dirty));
  }
  const { x, y } = await refIdToCoords(tabId, args.ref_id);
  await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PHANTOM_CURSOR', x, y }).catch(() => {});
  await new Promise((r) => setTimeout(r, 220));
  await cdp.mouseClick(tabId, x, y);
  return { clicked: args.ref_id, x, y, ...(await getTabContext(tabId)) };
}

async function hover(sessionId: string, args: HoverArgs & { tool?: string }) {
  return withTabId(sessionId, args.tabId, async (tabId) => {
    const { x, y } = await resolvePoint(tabId, args, 'hover');
    await cdp.mouseMove(tabId, x, y);
    return { action: 'hover', tabId, x, y };
  });
}

async function rightClick(sessionId: string, args: HoverArgs) {
  return withTabId(sessionId, args.tabId, async (tabId) => {
    const { x, y } = await resolvePoint(tabId, args, 'right_click');
    await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PHANTOM_CURSOR', x, y }).catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
    await cdp.mouseClick(tabId, x, y, 'right', 1);
    return { action: 'right_click', tabId, x, y };
  });
}

async function doubleClick(sessionId: string, args: HoverArgs) {
  return withTabId(sessionId, args.tabId, async (tabId) => {
    const { x, y } = await resolvePoint(tabId, args, 'double_click');
    await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PHANTOM_CURSOR', x, y }).catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
    await cdp.mouseClick(tabId, x, y, 'left', 2);
    return { action: 'double_click', tabId, x, y };
  });
}

async function drag(sessionId: string, args: DragArgs) {
  return withTabId(sessionId, args.tabId, async (tabId) => {
    const fromPoint = await resolvePoint(tabId, { ref_id: args.from_ref_id, x: args.from_x, y: args.from_y }, 'drag.from');
    const toPoint = await resolvePoint(tabId, { ref_id: args.to_ref_id, x: args.to_x, y: args.to_y }, 'drag.to');

    await cdp.mouseMove(tabId, fromPoint.x, fromPoint.y);
    await cdp.mouseDown(tabId, fromPoint.x, fromPoint.y, 'left');

    await cdp.mouseMove(tabId, toPoint.x, toPoint.y);
    await cdp.mouseUp(tabId, toPoint.x, toPoint.y, 'left');

    return { action: 'drag', tabId, from: fromPoint, to: toPoint };
  });
}

async function refIdLooksLikeSubmitButton(tabId: number, refId: string): Promise<boolean> {
  await ensureA11yInjected(tabId);
  return runInPage<boolean>(
    tabId,
    (targetRef) => {
      const ref = window.__hermesElementMap?.[targetRef];
      const node = ref && ref.deref ? ref.deref() : null;
      if (!(node instanceof Element)) return false;
      const target = node.closest('button,[role="button"]') || node;
      const label = [target.getAttribute('aria-label'), target.getAttribute('title'), target.textContent]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      function contextSignature(el: Element): string {
        const parts: string[] = [];
        let current: Element | null = el;
        for (let depth = 0; current && current !== document.body && depth < 7; depth += 1) {
          const html = current as HTMLElement;
          const className = typeof html.className === 'string' ? html.className : '';
          parts.push(
            current.tagName,
            current.id || '',
            className,
            current.getAttribute('aria-label') || '',
            current.getAttribute('title') || '',
            current.getAttribute('placeholder') || '',
          );
          if (depth <= 2) parts.push((current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180));
          current = current.parentElement;
        }
        return parts.filter(Boolean).join(' ').toLowerCase();
      }
      const host = location.hostname.toLowerCase();
      if (/(^|\.)douyin\.com$|(^|\.)bilibili\.com$|(^|\.)b23\.tv$/.test(host)
        && /(弹幕|发弹幕|发送弹幕|danmu|danmaku|barrage|bullet[-_ ]?screen)/i.test(contextSignature(target))) {
        return false;
      }
      const positive = /(发帖|发布|发送|评论|回复|post|tweet|send|comment|reply)/i;
      const negative = /(添加|add|gif|emoji|media|图片|照片|投票|schedule|日程|draft|草稿|下一步|next|弹幕|danmu|danmaku|barrage)/i;
      return Boolean(label && positive.test(label) && !negative.test(label));
    },
    [refId],
  ).catch(() => false);
}

function normalizedEquals(actual: string, expected: string): boolean {
  const a = (actual || '').replace(/\s+/g, ' ').trim();
  const b = (expected || '').replace(/\s+/g, ' ').trim();
  return b.length === 0 || a === b;
}

function repeatedExpectedCount(actual: string, expected: string): number {
  const a = (actual || '').replace(/\s+/g, ' ').trim();
  const b = (expected || '').replace(/\s+/g, ' ').trim();
  if (!a || !b) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = a.indexOf(b, index);
    if (next === -1) return count;
    count += 1;
    index = next + b.length;
  }
}

function isRichTextTarget(kind: string): boolean {
  return kind === 'contenteditable' || kind === 'role=textbox';
}

function typedTextError(status: Pick<EditableStatus, 'actual_text'>, expected: string): string | undefined {
  if (normalizedEquals(status.actual_text, expected)) return undefined;
  const repeats = repeatedExpectedCount(status.actual_text, expected);
  if (repeats > 1) return `Input text appears ${repeats} times in the editor; submission blocked`;
  return 'Target editor content does not match the text to input';
}

async function prepareAtomicType(tabId: number, refId: string | undefined, token: string): Promise<AtomicTypePreparation> {
  return runInPage<AtomicTypePreparation>(
    tabId,
    (targetRef, markerToken) => {
      const tried: string[] = ['resolve_editable'];
      const editableSelector = [
        'textarea',
        'input:not([type])',
        'input[type="text"]',
        'input[type="search"]',
        'input[type="email"]',
        'input[type="url"]',
        'input[type="tel"]',
        '[contenteditable="true"]',
        '[contenteditable="plaintext-only"]',
        '[role="textbox"]',
      ].join(',');

      function isVisible(node: Element): boolean {
        const rect = (node as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(node as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity || '1') > 0.05;
      }

      function refElement(): Element | null {
        if (!targetRef) return document.activeElement instanceof Element ? document.activeElement : null;
        const ref = window.__hermesElementMap?.[targetRef];
        const node = ref && ref.deref ? ref.deref() : null;
        return node instanceof Element ? node : null;
      }

      function weakRef(el: Element) {
        return typeof WeakRef === 'function' ? new WeakRef(el) : { deref: () => el };
      }

      function isEditable(el: Element | null): el is HTMLElement | HTMLInputElement | HTMLTextAreaElement {
        if (!el) return false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
        if (el instanceof HTMLElement && el.isContentEditable) return true;
        return el.getAttribute('role') === 'textbox';
      }

      function targetKind(el: Element | null): string {
        if (!el) return 'none';
        if (el instanceof HTMLTextAreaElement) return 'textarea';
        if (el instanceof HTMLInputElement) return `input:${el.type || 'text'}`;
        if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable';
        if (el.getAttribute('role') === 'textbox') return 'role=textbox';
        return el.tagName.toLowerCase();
      }

      function readText(el: Element | null): string {
        if (!el) return '';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || '';
        return (el as HTMLElement).innerText || el.textContent || '';
      }

      function buttonText(button: Element): string {
        return [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function isSubmitButton(button: Element): boolean {
        const label = buttonText(button);
        const positive = /(发帖|发布|发送|评论|回复|post|tweet|send|comment|reply)/i;
        const negative = /(添加|add|gif|emoji|media|图片|照片|投票|schedule|日程|draft|草稿|下一步|next|弹幕|danmu|danmaku|barrage)/i;
        return Boolean(label && positive.test(label) && !negative.test(label));
      }

      function elementContextSignature(el: Element): string {
        const parts: string[] = [];
        let node: Element | null = el;
        for (let depth = 0; node && node !== document.body && depth < 7; depth += 1) {
          const html = node as HTMLElement;
          const className = typeof html.className === 'string' ? html.className : '';
          parts.push(
            node.tagName,
            node.id || '',
            className,
            node.getAttribute('role') || '',
            node.getAttribute('aria-label') || '',
            node.getAttribute('title') || '',
            node.getAttribute('placeholder') || '',
            node.getAttribute('aria-placeholder') || '',
            node.getAttribute('data-e2e') || '',
            node.getAttribute('data-testid') || '',
            node.getAttribute('data-test-id') || '',
          );
          if (depth <= 2) parts.push((node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180));
          node = node.parentElement;
        }
        return parts.filter(Boolean).join(' ').toLowerCase();
      }

      function isBulletScreenControl(el: Element): boolean {
        const host = location.hostname.toLowerCase();
        if (!/(^|\.)douyin\.com$|(^|\.)bilibili\.com$|(^|\.)b23\.tv$/.test(host)) return false;
        const signature = elementContextSignature(el);
        const ownText = [
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('placeholder'),
          el.getAttribute('aria-placeholder'),
          readText(el),
        ].filter(Boolean).join(' ').toLowerCase();
        if (/(弹幕|发弹幕|发送弹幕|danmu|danmaku|barrage|bullet[-_ ]?screen)/i.test(signature)) return true;
        const playerLike = /(xgplayer|bpx[-_]?player|bilibili[-_]?player|web[-_]?player|video[-_]?controls?|controlbar|controller|播放器)/i.test(signature);
        const commentLike = /(评论|回复|comment|reply)/i.test(ownText);
        const rect = el.getBoundingClientRect();
        return playerLike && !commentLike && rect.top > window.innerHeight * 0.55;
      }

      function scoreCandidate(el: Element, base: Element | null): number {
        let score = 0;
        if (el instanceof HTMLTextAreaElement) score += 30;
        else if (el instanceof HTMLInputElement) score += 25;
        else if (el instanceof HTMLElement && el.isContentEditable) score += 20;
        else if (el.getAttribute('role') === 'textbox') score += 18;
        if (base && el === base) score += 100;
        if (base && base.contains(el)) score += 50;
        if (el.closest('[role="dialog"],[aria-modal="true"]')) score += 25;
        if (document.activeElement === el) score += 10;
        return score;
      }

      function resolveEditable(): Element | null {
        const base = refElement();
        if (isEditable(base)) return base;
        const candidates: Element[] = [];
        if (base) {
          candidates.push(...Array.from(base.querySelectorAll(editableSelector)));
          const closest = base.closest(editableSelector);
          if (closest) candidates.push(closest);
        }
        if (document.activeElement instanceof Element) {
          if (isEditable(document.activeElement)) candidates.push(document.activeElement);
          candidates.push(...Array.from(document.activeElement.querySelectorAll?.(editableSelector) || []));
        }
        candidates.push(...Array.from(document.querySelectorAll(editableSelector)));
        return candidates
          .filter((el, index, arr) => arr.indexOf(el) === index)
          .filter(isVisible)
          .sort((a, b) => scoreCandidate(b, base) - scoreCandidate(a, base))[0] || null;
      }

      function resolveScope(target: Element): Element {
        let node: Element | null = target;
        while (node && node !== document.body) {
          if (Array.from(node.querySelectorAll('button,[role="button"]')).some((button) => isVisible(button) && isSubmitButton(button))) {
            return node;
          }
          node = node.parentElement;
        }
        return target.closest('[role="dialog"],[aria-modal="true"],form,[role="group"],article,section') || target.parentElement || target;
      }

      function scopeKind(scope: Element): string {
        if (scope.getAttribute('role')) return `role=${scope.getAttribute('role')}`;
        if (scope.tagName) return scope.tagName.toLowerCase();
        return 'scope';
      }

      function dispatchInputEvents(el: Element, inputType = 'deleteContentBackward') {
        try {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
        } catch {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function clearTarget(el: Element) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, '');
          else el.value = '';
          dispatchInputEvents(el);
          return;
        }
        if (el instanceof HTMLElement) {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel?.removeAllRanges();
          sel?.addRange(range);
          if (!document.execCommand('delete')) el.textContent = '';
          dispatchInputEvents(el);
        }
      }

      function collectDeep(root: Document | ShadowRoot, selector: string, out: Element[] = []): Element[] {
        out.push(...Array.from(root.querySelectorAll(selector)));
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          const shadow = (node as HTMLElement).shadowRoot;
          if (shadow) collectDeep(shadow, selector, out);
          node = walker.nextNode();
        }
        return out;
      }

      collectDeep(document, '[data-hermes-type-target],[data-hermes-type-scope],[data-hermes-editable-index]')
        .forEach((node) => {
          node.removeAttribute('data-hermes-type-target');
          node.removeAttribute('data-hermes-type-scope');
          node.removeAttribute('data-hermes-editable-index');
        });

      const target = resolveEditable();
      if (!target) {
        return { ok: false, token: markerToken, target_kind: 'none', scope_kind: 'none', actual_text: '', snapshots: [], tried, error: 'No editable target found' };
      }
      const scope = resolveScope(target);
      if (isBulletScreenControl(target)) {
        return {
          ok: false,
          token: markerToken,
          target_kind: targetKind(target),
          scope_kind: scopeKind(scope),
          actual_text: readText(target),
          snapshots: [],
          tried: [...tried, 'blocked_danmu_player_input'],
          error: 'Target appears to be a bullet-screen/danmu input in the video player, not a normal comment editor. Open/scroll to the comment area and choose a 评论/回复 textbox instead.',
        };
      }
      (target as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center' });
      (target as HTMLElement).focus?.();
      const richTextTarget = target instanceof HTMLElement
        && !(target instanceof HTMLInputElement)
        && !(target instanceof HTMLTextAreaElement)
        && (target.isContentEditable || target.getAttribute('role') === 'textbox');
      if (richTextTarget) {
        tried.push('defer_rich_text_clear_to_trusted_keys');
      } else {
        clearTarget(target);
        tried.push('clear_target');
      }

      const targetText = readText(target);
      if (!richTextTarget && targetText.replace(/\s+/g, ' ').trim()) {
        return {
          ok: false,
          token: markerToken,
          target_kind: targetKind(target),
          scope_kind: scopeKind(scope),
          actual_text: targetText,
          snapshots: [],
          tried,
          error: 'Failed to clear target editor; input not executed',
        };
      }

      target.setAttribute('data-hermes-type-target', markerToken);
      scope.setAttribute('data-hermes-type-scope', markerToken);
      const w = window as any;
      if (!w.__hermesTypeTargets) w.__hermesTypeTargets = {};
      if (!w.__hermesTypeScopes) w.__hermesTypeScopes = {};
      w.__hermesTypeTargets[markerToken] = weakRef(target);
      w.__hermesTypeScopes[markerToken] = weakRef(scope);
      const editables = Array.from(scope.querySelectorAll(editableSelector)).filter(isVisible);
      if (!editables.includes(target)) editables.unshift(target);
      const snapshots = editables
        .filter((el, index, arr) => arr.indexOf(el) === index)
        .map((el, index) => {
          el.setAttribute('data-hermes-editable-index', String(index));
          return { index, text: readText(el), target: el === target };
        });
      return {
        ok: true,
        token: markerToken,
        target_kind: targetKind(target),
        scope_kind: scopeKind(scope),
        actual_text: targetText,
        snapshots,
        tried,
      };
    },
    [refId ?? null, token],
  );
}

async function inspectAtomicType(tabId: number, token: string, expected: string, snapshots: EditableSnapshot[], requireSubmitEnabled: boolean): Promise<EditableStatus> {
  return runInPage<EditableStatus>(
    tabId,
    (markerToken, inputText, previousSnapshots, shouldRequireSubmitEnabled) => {
      const tried: string[] = ['inspect_atomic_type'];
      const editableSelector = 'textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]';

      function queryDeep(root: Document | ShadowRoot, selector: string): Element | null {
        const direct = root.querySelector(selector);
        if (direct) return direct;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          const shadow = (node as HTMLElement).shadowRoot;
          if (shadow) {
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          node = walker.nextNode();
        }
        return null;
      }

      function tokenElement(mapName: string, attrName: string): Element | null {
        const ref = (window as any)[mapName]?.[markerToken];
        const node = ref && ref.deref ? ref.deref() : null;
        if (node instanceof Element && node.isConnected) return node;
        return queryDeep(document, `[${attrName}="${markerToken}"]`);
      }

      const target = tokenElement('__hermesTypeTargets', 'data-hermes-type-target');
      const scope = tokenElement('__hermesTypeScopes', 'data-hermes-type-scope') || target?.parentElement || null;

      function normalize(value: string | null | undefined): string {
        return (value || '').replace(/\s+/g, ' ').trim();
      }

      function readText(el: Element | null): string {
        if (!el) return '';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || '';
        return (el as HTMLElement).innerText || el.textContent || '';
      }

      function targetKind(el: Element | null): string {
        if (!el) return 'none';
        if (el instanceof HTMLTextAreaElement) return 'textarea';
        if (el instanceof HTMLInputElement) return `input:${el.type || 'text'}`;
        if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable';
        if (el.getAttribute('role') === 'textbox') return 'role=textbox';
        return el.tagName.toLowerCase();
      }

      function scopeKind(el: Element | null): string {
        if (!el) return 'none';
        if (el.getAttribute('role')) return `role=${el.getAttribute('role')}`;
        return el.tagName.toLowerCase();
      }

      function repeatedCount(actual: string): number {
        const a = normalize(actual);
        const b = normalize(inputText);
        if (!a || !b) return 0;
        let count = 0;
        let index = 0;
        while (true) {
          const next = a.indexOf(b, index);
          if (next === -1) return count;
          count += 1;
          index = next + b.length;
        }
      }

      function isVisible(node: Element): boolean {
        const rect = (node as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(node as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity || '1') > 0.05;
      }

      function isPlaceholderVisible(root: Element): boolean {
        const selectors = [
          '[data-placeholder]',
          '[aria-placeholder]:not([contenteditable])',
          '.public-DraftEditorPlaceholder-root',
          '.public-DraftEditorPlaceholder-inner',
          '[data-slate-placeholder]',
          '[data-lexical-text-placeholder]',
          '.ProseMirror-placeholder',
        ];
        const rootScope = scope || root.parentElement || root;
        for (const sel of selectors) {
          for (const node of Array.from(rootScope.querySelectorAll(sel))) {
            if (isVisible(node)) return true;
          }
        }
        return false;
      }

      function buttonText(button: Element): string {
        return [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function submitButtonState(root: Element | null): { label?: string; disabled?: boolean } {
        if (!root) return {};
        const positive = /(发帖|发布|发送|评论|回复|post|tweet|send|comment|reply)/i;
        const negative = /(添加|add|gif|emoji|media|图片|照片|投票|schedule|日程|draft|草稿|下一步|next)/i;
        for (const button of Array.from(root.querySelectorAll('button,[role="button"]')).filter(isVisible)) {
          const label = buttonText(button);
          if (!label || !positive.test(label) || negative.test(label)) continue;
          const style = window.getComputedStyle(button as HTMLElement);
          return {
            label,
            disabled: (button instanceof HTMLButtonElement && button.disabled)
              || button.getAttribute('aria-disabled') === 'true'
              || button.getAttribute('disabled') != null
              || style.pointerEvents === 'none',
          };
        }
        return {};
      }

      const snapshotByIndex = new Map(
        (previousSnapshots as EditableSnapshot[]).map((item) => [String(item.index), normalize(item.text)]),
      );
      const expectedText = normalize(inputText);
      if (!target) {
        return { ok: false, target_kind: 'none', scope_kind: scopeKind(scope), actual_text: '', residue_preview: '', placeholder_visible: false, error: 'Target editor marker lost', tried };
      }

      const actual = readText(target);
      const editables = scope ? Array.from(scope.querySelectorAll(editableSelector)).filter(isVisible) : [target];
      if (!editables.includes(target)) editables.unshift(target);
      const uniqueEditables = editables.filter((el, index, arr) => arr.indexOf(el) === index);
      const otherConflicts = uniqueEditables
        .filter((el) => el !== target)
        .map((el) => {
          const index = el.getAttribute('data-hermes-editable-index');
          const text = readText(el);
          return { text, previous: index != null ? snapshotByIndex.get(index) ?? '' : '' };
        })
        .filter((item) => {
          const current = normalize(item.text);
          if (!expectedText || !current || current === item.previous) return false;
          return current.includes(expectedText);
        })
        .map((item) => item.text);
      const targetRepeats = repeatedCount(actual);
      const submit = submitButtonState(scope);
      const placeholderVisible = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? false
        : !normalize(actual) && isPlaceholderVisible(target);
      let error: string | undefined;
      if (!expectedText || normalize(actual) !== expectedText) {
        error = targetRepeats > 1
          ? `Input text repeated ${targetRepeats} times in the editor; submission blocked`
          : 'Target editor content does not match the text to input';
      } else if (otherConflicts.length > 0) {
        error = 'Input text also appeared in another editor in the same form; submission blocked';
      } else if (placeholderVisible) {
        error = 'Editor placeholder still visible; the page did not accept this rich-text input';
      } else if (shouldRequireSubmitEnabled && submit.disabled) {
        error = `"${submit.label}" button still disabled after input; the page did not accept this rich-text input`;
      }

      const residuePreview = otherConflicts.concat(targetRepeats > 1 ? [actual] : []).join(' | ').slice(0, 180);
      return {
        ok: !error,
        target_kind: targetKind(target),
        scope_kind: scopeKind(scope),
        actual_text: actual,
        residue_preview: residuePreview,
        placeholder_visible: placeholderVisible,
        submit_button_label: submit.label,
        submit_button_disabled: submit.disabled,
        error,
        tried,
      };
    },
    [token, expected, snapshots, requireSubmitEnabled],
  );
}

async function inspectAtomicDraft(tabId: number, token: string): Promise<DraftInspection> {
  return runInPage<DraftInspection>(
    tabId,
    (markerToken) => {
      const tried: string[] = ['inspect_atomic_draft'];

      function queryDeep(root: Document | ShadowRoot, selector: string): Element | null {
        const direct = root.querySelector(selector);
        if (direct) return direct;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          const shadow = (node as HTMLElement).shadowRoot;
          if (shadow) {
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          node = walker.nextNode();
        }
        return null;
      }

      function tokenElement(mapName: string, attrName: string): Element | null {
        const ref = (window as any)[mapName]?.[markerToken];
        const node = ref && ref.deref ? ref.deref() : null;
        if (node instanceof Element && node.isConnected) return node;
        return queryDeep(document, `[${attrName}="${markerToken}"]`);
      }

      const target = tokenElement('__hermesTypeTargets', 'data-hermes-type-target');
      const scope = tokenElement('__hermesTypeScopes', 'data-hermes-type-scope') || target?.parentElement || null;

      function normalize(value: string | null | undefined): string {
        return (value || '').replace(/\s+/g, ' ').trim();
      }

      function readText(el: Element | null): string {
        if (!el) return '';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || '';
        return (el as HTMLElement).innerText || el.textContent || '';
      }

      function targetKind(el: Element | null): string {
        if (!el) return 'none';
        if (el instanceof HTMLTextAreaElement) return 'textarea';
        if (el instanceof HTMLInputElement) return `input:${el.type || 'text'}`;
        if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable';
        if (el.getAttribute('role') === 'textbox') return 'role=textbox';
        return el.tagName.toLowerCase();
      }

      function scopeKind(el: Element | null): string {
        if (!el) return 'none';
        if (el.getAttribute('role')) return `role=${el.getAttribute('role')}`;
        return el.tagName.toLowerCase();
      }

      if (!target) {
        return {
          empty: false,
          target_kind: 'none',
          scope_kind: scopeKind(scope),
          target_text: '',
          all_text: '',
          residue_preview: '',
          tried,
          error: 'Target editor marker lost',
        };
      }

      // Only the target editor's content matters here. Other editables in the
      // same scope (placeholder overlays, sibling compose boxes, decorative
      // contenteditables — e.g. YouTube's `添加评论…` placeholder inside
      // `ytd-comment-simplebox-renderer`) used to be read via innerText and
      // mis-classified as draft residue, which then tripped the dirty lock
      // and made every subsequent type() call fail.
      const targetText = readText(target);
      const targetNormalized = normalize(targetText);
      return {
        empty: targetNormalized.length === 0,
        target_kind: targetKind(target),
        scope_kind: scopeKind(scope),
        target_text: targetText,
        all_text: targetNormalized,
        residue_preview: targetNormalized.slice(0, 180),
        tried,
        error: targetNormalized ? 'Target editor not empty before input' : undefined,
      };
    },
    [token],
  );
}

async function submitCurrentEditor(tabId: number, token: string, tried: string[]): Promise<SubmitAttempt> {
  tried.push('submit_discover_candidates');
  const discovery = await runInPage<{ target_text: string; candidates: SubmitCandidate[] }>(
    tabId,
    (markerToken) => {
      const host = location.hostname.toLowerCase();
      const w = window as any;
      if (!w.__hermesElementMap) w.__hermesElementMap = {};
      if (!w.__hermesRefCounter) w.__hermesRefCounter = 0;

      function queryDeep(root: Document | ShadowRoot, selector: string): Element | null {
        const direct = root.querySelector(selector);
        if (direct) return direct;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          const shadow = (node as HTMLElement).shadowRoot;
          if (shadow) {
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          node = walker.nextNode();
        }
        return null;
      }

      function tokenElement(mapName: string, attrName: string): Element | null {
        const ref = w[mapName]?.[markerToken];
        const node = ref && ref.deref ? ref.deref() : null;
        if (node instanceof Element && node.isConnected) return node;
        return queryDeep(document, `[${attrName}="${markerToken}"]`);
      }

      const target = tokenElement('__hermesTypeTargets', 'data-hermes-type-target');
      const scope = tokenElement('__hermesTypeScopes', 'data-hermes-type-scope') || target?.parentElement || null;

      function getOrCreateRef(el: Element): string {
        for (const key in w.__hermesElementMap) {
          if (w.__hermesElementMap[key]?.deref?.() === el) return key;
        }
        const ref = `ref_${++w.__hermesRefCounter}`;
        w.__hermesElementMap[ref] = new WeakRef(el);
        return ref;
      }

      function isVisible(el: Element): boolean {
        const r = (el as HTMLElement).getBoundingClientRect();
        const s = window.getComputedStyle(el as HTMLElement);
        return r.width > 0
          && r.height > 0
          && r.bottom > 0
          && r.right > 0
          && r.top < window.innerHeight
          && r.left < window.innerWidth
          && s.display !== 'none'
          && s.visibility !== 'hidden'
          && parseFloat(s.opacity || '1') > 0.05;
      }

      function readText(el: Element | null): string {
        if (!el) return '';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || '';
        return (el as HTMLElement).innerText || el.textContent || '';
      }

      function labelOf(el: Element): string {
        const svgTitle = el.querySelector('svg title,title')?.textContent?.trim();
        return [
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('placeholder'),
          svgTitle,
          el.textContent,
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      }

      function elementContextSignature(el: Element): string {
        const parts: string[] = [];
        let node: Element | null = el;
        for (let depth = 0; node && node !== document.body && depth < 7; depth += 1) {
          const html = node as HTMLElement;
          const className = typeof html.className === 'string' ? html.className : '';
          parts.push(
            node.tagName,
            node.id || '',
            className,
            node.getAttribute('role') || '',
            node.getAttribute('aria-label') || '',
            node.getAttribute('title') || '',
            node.getAttribute('placeholder') || '',
            node.getAttribute('aria-placeholder') || '',
            node.getAttribute('data-e2e') || '',
            node.getAttribute('data-testid') || '',
            node.getAttribute('data-test-id') || '',
          );
          if (depth <= 2) parts.push((node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180));
          node = node.parentElement;
        }
        return parts.filter(Boolean).join(' ').toLowerCase();
      }

      function isBulletScreenControl(el: Element): boolean {
        if (!/(^|\.)douyin\.com$|(^|\.)bilibili\.com$|(^|\.)b23\.tv$/.test(host)) return false;
        const signature = elementContextSignature(el);
        const ownText = [
          labelOf(el),
          el.getAttribute('placeholder'),
          el.getAttribute('aria-placeholder'),
          readText(el),
        ].filter(Boolean).join(' ').toLowerCase();
        if (/(弹幕|发弹幕|发送弹幕|danmu|danmaku|barrage|bullet[-_ ]?screen)/i.test(signature)) return true;
        const playerLike = /(xgplayer|bpx[-_]?player|bilibili[-_]?player|web[-_]?player|video[-_]?controls?|controlbar|controller|播放器)/i.test(signature);
        const commentLike = /(评论|回复|comment|reply)/i.test(ownText);
        const rect = el.getBoundingClientRect();
        return playerLike && !commentLike && rect.top > window.innerHeight * 0.55;
      }

      function roleOf(el: Element): string {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit.trim().toLowerCase();
        const tag = el.tagName.toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a') return 'link';
        return 'generic';
      }

      function disabled(el: Element): boolean {
        const s = window.getComputedStyle(el as HTMLElement);
        return (el instanceof HTMLButtonElement && el.disabled)
          || el.getAttribute('disabled') != null
          || el.getAttribute('aria-disabled') === 'true'
          || s.pointerEvents === 'none';
      }

      function clickableRoot(el: Element): Element | null {
        if (target && (el.contains(target) || target.contains(el))) return null;
        if (el.closest('[contenteditable="true"],[contenteditable="plaintext-only"],textarea,input,[role="textbox"]')) return null;
        return el.closest('button,[role="button"],a,[role="link"],summary,[tabindex]') || el;
      }

      function collect(root: ParentNode, out: Element[], seen: Set<Element>) {
        for (const el of Array.from(root.children || [])) {
          if (seen.has(el)) continue;
          seen.add(el);
          out.push(el);
          const shadow = (el as HTMLElement).shadowRoot;
          if (shadow) collect(shadow, out, seen);
          collect(el, out, seen);
        }
      }

      function distance(a: DOMRect, b: DOMRect): number {
        return Math.hypot((a.left + a.width / 2) - (b.left + b.width / 2), (a.top + a.height / 2) - (b.top + b.height / 2));
      }

      if (!(target instanceof Element)) return { target_text: '', candidates: [] };
      const targetRect = target.getBoundingClientRect();
      const roots: ParentNode[] = [];
      const addRoot = (root: ParentNode | null | undefined) => {
        if (root && !roots.includes(root)) roots.push(root);
      };
      addRoot(scope);
      const rootNode = target.getRootNode();
      if (rootNode instanceof ShadowRoot) {
        addRoot(rootNode);
        addRoot(rootNode.host);
        let hostAncestor: Element | null = rootNode.host.parentElement;
        for (let i = 0; hostAncestor && hostAncestor !== document.body && i < 5; i += 1) {
          addRoot(hostAncestor);
          hostAncestor = hostAncestor.parentElement;
        }
      }
      const dialog = target.closest('[role="dialog"],[aria-modal="true"],form,article,section');
      if (dialog && dialog !== scope) addRoot(dialog);
      let ancestor: Element | null = target.parentElement;
      for (let i = 0; ancestor && ancestor !== document.body && i < 7; i += 1) {
        addRoot(ancestor);
        ancestor = ancestor.parentElement;
      }

      if (target && isBulletScreenControl(target)) {
        return { target_text: readText(target), candidates: [] };
      }

      const elements: Element[] = [];
      const seen = new Set<Element>();
      for (const root of roots) collect(root, elements, seen);
      const clickables = new Set<Element>();
      for (const el of elements) {
        const tag = el.tagName.toLowerCase();
        const role = roleOf(el);
        const style = window.getComputedStyle(el as HTMLElement);
        const clickable = ['button', 'a', 'summary'].includes(tag)
          || ['button', 'link', 'menuitem'].includes(role)
          || el.hasAttribute('tabindex')
          || ((el.getAttribute('aria-label') || el.getAttribute('title')) && style.cursor === 'pointer')
          || (style.cursor === 'pointer' && !!el.querySelector('svg,path'));
        if (!clickable || !isVisible(el)) continue;
        const root = clickableRoot(el);
        if (root && isVisible(root)) clickables.add(root);
      }

      const positive = /(发帖|发布|发送|提交|评论|回复|post|tweet|send|submit|comment|reply)/i;
      const negative = /(添加|add|gif|emoji|表情|media|图片|照片|投票|schedule|日程|draft|草稿|下一步|next|搜索|search|展开|更多|more|分享|share|点赞|like|收藏|favorite|关闭|close|弹幕|danmu|danmaku|barrage)/i;
      const candidates: SubmitCandidate[] = [];
      for (const button of Array.from(clickables)) {
        if (isBulletScreenControl(button)) continue;
        const r = button.getBoundingClientRect();
        const label = labelOf(button);
        const tag = button.tagName.toLowerCase();
        const role = roleOf(button);
        const hasSvg = !!button.querySelector('svg,path');
        const targetCenterX = targetRect.left + targetRect.width / 2;
        const targetCenterY = targetRect.top + targetRect.height / 2;
        const buttonCenterX = r.left + r.width / 2;
        const buttonCenterY = r.top + r.height / 2;
        const sameRow = Math.abs(buttonCenterY - targetCenterY) < Math.max(targetRect.height, r.height) + 32;
        const rightOfEditor = buttonCenterX > targetCenterX;
        let score = 0;
        if (positive.test(label)) score += 80;
        if (negative.test(label)) score -= 120;
        if (tag === 'button') score += 25;
        if (role === 'button') score += 20;
        if (hasSvg) score += 18;
        if (!label && hasSvg) score += 12;
        if (r.width <= 96 && r.height <= 96) score += 10;
        if (r.width > 220 || r.height > 120) score -= 25;
        if (r.left >= targetRect.left - 8) score += 10;
        if (rightOfEditor) score += 18;
        if (sameRow) score += 20;
        // Icon-only send buttons are often on the same row at the far right of
        // the comment editor. Existing comment "reply" actions can also score
        // high by label, but they sit below the editor. Prefer the row-aligned
        // icon and strongly down-rank reply controls below the input slot.
        if (sameRow && rightOfEditor && hasSvg) score += 70;
        if (/(回复|reply)/i.test(label) && !sameRow) score -= 95;
        if (/(回复|reply)/i.test(label) && buttonCenterY > targetRect.bottom + 48) score -= 80;
        const d = distance(r, targetRect);
        if (d < 300) score += Math.round(30 - d / 12);
        if (host.includes('douyin.com')) {
          if (sameRow && rightOfEditor && hasSvg) score += 120;
          if (sameRow && buttonCenterX > targetRect.right) score += 80;
          if (buttonCenterX > targetRect.right + 160) score += 25;
          if (/(回复|reply)/i.test(label)) score -= 220;
          if (!sameRow) score -= 70;
          if (!rightOfEditor) score -= 90;
        }
        if (disabled(button)) score -= 140;
        if (button.contains(target) || target.contains(button)) score -= 200;
        if (score <= 0) continue;
        candidates.push({
          ref_id: getOrCreateRef(button),
          label,
          tag,
          role,
          score,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          disabled: disabled(button),
          hasSvg,
          same_row: sameRow,
          right_of_editor: rightOfEditor,
          distance: Math.round(d),
        });
      }
      return {
        target_text: readText(target),
        candidates: candidates.sort((a, b) => (
          b.score - a.score
          || Number(Boolean(b.same_row)) - Number(Boolean(a.same_row))
          || Number(Boolean(b.right_of_editor)) - Number(Boolean(a.right_of_editor))
          || b.x - a.x
          || (a.distance ?? 0) - (b.distance ?? 0)
        )).slice(0, 8),
      };
    },
    [token],
  ).catch(() => ({ target_text: '', candidates: [] }));

  const inspectPostSubmitDraft = () => inspectAtomicDraft(tabId, token).catch((e) => ({
    empty: true,
    target_kind: 'none',
    scope_kind: 'none',
    target_text: '',
    all_text: '',
    residue_preview: '',
    tried: ['inspect_atomic_draft_after_submit_failed'],
    error: e instanceof Error ? e.message : String(e),
  }));

  const candidates = discovery.candidates.filter((candidate) => !candidate.disabled && candidate.score >= 25).slice(0, 5);
  const attempted: SubmitCandidate[] = [];
  let button: SubmitCandidate | undefined;
  let method = 'none';
  let post: DraftInspection = {
    empty: false,
    target_kind: 'none',
    scope_kind: 'none',
    target_text: discovery.target_text || '',
    all_text: discovery.target_text || '',
    residue_preview: '',
    tried: [],
  };

  for (const candidate of candidates) {
    attempted.push(candidate);
    button = candidate;
    method = 'button';
    tried.push(`submit_click_candidate:${candidate.ref_id}:${candidate.score}`);
    await cdp.mouseClick(tabId, candidate.x, candidate.y);
    await sleep(850);
    post = await inspectPostSubmitDraft();
    tried.push(...post.tried);
    if (!post.target_text?.replace(/\s+/g, ' ').trim()) {
      break;
    }
    tried.push(`submit_candidate_left_text:${candidate.ref_id}`);
  }

  if (attempted.length === 0) {
    method = 'enter';
    tried.push('submit_fallback_enter');
    await cdp.pressKey(tabId, 'Enter');
    await sleep(650);
    post = await inspectPostSubmitDraft();
    tried.push(...post.tried);
  }

  const textStillPresent = !!post.target_text?.replace(/\s+/g, ' ').trim();
  return {
    submitted: !textStillPresent,
    method,
    button,
    candidates: discovery.candidates,
    attempted_buttons: attempted,
    post_submit_text_still_present: textStillPresent,
    post_submit_text_preview: (post.target_text || '').slice(0, 160),
  };
}

async function rollbackAtomicType(tabId: number, token: string, expected: string, snapshots: EditableSnapshot[]): Promise<EditableStatus> {
  return runInPage<EditableStatus>(
    tabId,
    (markerToken, inputText, previousSnapshots) => {
      const tried: string[] = ['rollback_atomic_type'];
      const editableSelector = 'textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]';

      function queryDeep(root: Document | ShadowRoot, selector: string): Element | null {
        const direct = root.querySelector(selector);
        if (direct) return direct;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          const shadow = (node as HTMLElement).shadowRoot;
          if (shadow) {
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          node = walker.nextNode();
        }
        return null;
      }

      function tokenElement(mapName: string, attrName: string): Element | null {
        const ref = (window as any)[mapName]?.[markerToken];
        const node = ref && ref.deref ? ref.deref() : null;
        if (node instanceof Element && node.isConnected) return node;
        return queryDeep(document, `[${attrName}="${markerToken}"]`);
      }

      const scope = tokenElement('__hermesTypeScopes', 'data-hermes-type-scope');
      const target = tokenElement('__hermesTypeTargets', 'data-hermes-type-target');

      function normalize(value: string | null | undefined): string {
        return (value || '').replace(/\s+/g, ' ').trim();
      }

      function readText(el: Element | null): string {
        if (!el) return '';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || '';
        return (el as HTMLElement).innerText || el.textContent || '';
      }

      function targetKind(el: Element | null): string {
        if (!el) return 'none';
        if (el instanceof HTMLTextAreaElement) return 'textarea';
        if (el instanceof HTMLInputElement) return `input:${el.type || 'text'}`;
        if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable';
        if (el.getAttribute('role') === 'textbox') return 'role=textbox';
        return el.tagName.toLowerCase();
      }

      function scopeKind(el: Element | null): string {
        if (!el) return 'none';
        if (el.getAttribute('role')) return `role=${el.getAttribute('role')}`;
        return el.tagName.toLowerCase();
      }

      function dispatchInputEvents(el: Element) {
        try {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        } catch {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function restoreText(el: Element, value: string) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
        } else {
          el.textContent = value;
        }
        dispatchInputEvents(el);
      }

      let rollback = false;
      const snapshotByIndex = new Map((previousSnapshots as EditableSnapshot[]).map((item) => [String(item.index), item.text]));
      const editables = scope ? Array.from(scope.querySelectorAll(editableSelector)) : target ? [target] : [];
      for (const editable of editables) {
        const current = readText(editable);
        const index = editable.getAttribute('data-hermes-editable-index');
        const previous = index != null ? snapshotByIndex.get(index) ?? '' : '';
        if (normalize(current).includes(normalize(inputText)) || normalize(current) !== normalize(previous)) {
          restoreText(editable, previous);
          rollback = true;
        }
      }

      const actual = readText(target);
      const residue = editables.map(readText).filter((text) => Boolean(normalize(text))).join(' | ').slice(0, 180);
      return {
        ok: false,
        target_kind: targetKind(target),
        scope_kind: scopeKind(scope),
        actual_text: actual,
        residue_preview: residue,
        placeholder_visible: false,
        error: 'Input verification failed; residue has been rolled back',
        rollback,
        tried,
      };
    },
    [token, expected, snapshots],
  );
}

async function clearFocusedEditableWithTrustedKeys(tabId: number, tried: string[]): Promise<void> {
  tried.push('cdp_select_all_backspace');
  const platform = await chrome.runtime.getPlatformInfo().catch(() => ({ os: 'mac' as chrome.runtime.PlatformOs }));
  const modifier = platform.os === 'mac' ? 4 : 2;
  await cdp.pressKey(tabId, 'a', 'KeyA', modifier);
  await new Promise((r) => setTimeout(r, 80));
  await cdp.pressKey(tabId, 'Backspace', 'Backspace');
  await new Promise((r) => setTimeout(r, 320));
}

async function refocusAtomicTarget(tabId: number, token: string, tried: string[]): Promise<void> {
  tried.push('refocus_atomic_target');
  await runInPage<void>(
    tabId,
    (markerToken) => {
      function queryDeep(root: Document | ShadowRoot, selector: string): Element | null {
        const direct = root.querySelector(selector);
        if (direct) return direct;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          const shadow = (node as HTMLElement).shadowRoot;
          if (shadow) {
            const found = queryDeep(shadow, selector);
            if (found) return found;
          }
          node = walker.nextNode();
        }
        return null;
      }

      const ref = (window as any).__hermesTypeTargets?.[markerToken];
      const node = ref && ref.deref ? ref.deref() : null;
      const target = node instanceof Element && node.isConnected
        ? node
        : queryDeep(document, `[data-hermes-type-target="${markerToken}"]`);
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: 'center', inline: 'center' });
        target.focus();
      }
    },
    [token],
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 160));
}

async function pasteClipboardIntoFocusedEditable(tabId: number, tried: string[]): Promise<void> {
  tried.push('cdp_paste_command');
  await cdp.paste(tabId);
  await sleep(320);
}

async function typeText(sessionId: string, args: { ref_id?: string; text: string; submit?: boolean }) {
  if (typeof args.text !== 'string' || !args.text.trim()) {
    throw new Error('text argument must be a non-empty string');
  }

  const tabId = await getCurrentTab(sessionId);
  const dirty = await getRichTextDirtyState(tabId);
  if (dirty) throw new Error(richTextDirtyError(dirty));
  const tried: string[] = [];
  let lastStatus: EditableStatus | null = null;
  let lastPreparation: AtomicTypePreparation | null = null;
  let richTextUnsafeFailure = false;

  if (args.ref_id) {
    const { x, y } = await refIdToCoords(tabId, args.ref_id);
    await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PHANTOM_CURSOR', x, y }).catch(() => {});
    await new Promise((r) => setTimeout(r, 220));
    await cdp.mouseClick(tabId, x, y);
  }

  const plainTextStrategies: Array<{ name: string; run: () => Promise<void> }> = [
    { name: 'cdp_insertText', run: () => cdp.insertText(tabId, args.text) },
    { name: 'cdp_key_events_per_char', run: () => cdp.typeTextByKeyEvents(tabId, args.text) },
  ];

  for (let attempt = 0; attempt < plainTextStrategies.length; attempt += 1) {
    const token = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const preparation = await prepareAtomicType(tabId, args.ref_id, token);
    lastPreparation = preparation;
    const richTextTarget = isRichTextTarget(preparation.target_kind);
    const strategy = plainTextStrategies[attempt];
    tried.push(...preparation.tried, richTextTarget ? 'rich_text_clipboard_path' : strategy.name);
    if (!preparation.ok) {
      lastStatus = {
        ok: false,
        target_kind: preparation.target_kind,
        scope_kind: preparation.scope_kind,
        actual_text: preparation.actual_text,
        residue_preview: '',
        placeholder_visible: false,
        error: preparation.error,
        tried,
      };
      break;
    }

    if (richTextTarget) {
      await clearFocusedEditableWithTrustedKeys(tabId, tried);
      const emptyStatus = await inspectAtomicDraft(tabId, token);
      tried.push(...emptyStatus.tried);
      if (!emptyStatus.empty) {
        if (normalizedEquals(emptyStatus.target_text, args.text)) {
          const submit = args.submit ? await submitCurrentEditor(tabId, token, tried) : null;
          const context = await getTabContext(tabId);
          return {
            typed_chars: 0,
            submitted: submit ? submit.submitted && !submit.post_submit_text_still_present : false,
            verified: true,
            strategy: 'existing_text_verified',
            target_kind: emptyStatus.target_kind,
            scope_kind: emptyStatus.scope_kind,
            submit_button_disabled: submit?.button?.disabled ?? false,
            actual_text_preview: (emptyStatus.target_text || '').slice(0, 160),
            ...context,
            submit_method: submit?.method,
            submit_button_ref: submit?.button?.ref_id,
            submit_button_label: submit?.button?.label,
            post_submit_text_still_present: submit?.post_submit_text_still_present,
            candidate_submit_buttons: submit?.candidates.slice(0, 5),
            attempted_submit_buttons: submit?.attempted_buttons?.slice(0, 5),
          } satisfies TypeResult;
        }
        lastStatus = {
          ok: false,
          target_kind: emptyStatus.target_kind,
          scope_kind: emptyStatus.scope_kind,
          actual_text: emptyStatus.target_text,
          residue_preview: emptyStatus.residue_preview,
          placeholder_visible: false,
          error: 'Target editor already contains different text; input not executed',
          rollback: false,
          tried,
        };
        break;
      }
      await refocusAtomicTarget(tabId, token, tried);

      let status: EditableStatus;
      let clipboardRestore: ClipboardRestoreResult = { mode: 'failed', error: 'Clipboard restore was not performed' };
      try {
        const pasted = await withTemporaryClipboard(args.text, async () => {
          await pasteClipboardIntoFocusedEditable(tabId, tried);
          let inspect = await inspectAtomicType(tabId, token, args.text, preparation.snapshots, !!args.submit);
          // X/YouTube 的富文本 paste 可能异步落盘；只等待和复查，
          // 绝不再次粘贴，避免同一段文本被页面接收两次。
          for (const delay of [280, 560, 900]) {
            if (inspect.ok) break;
            tried.push(`clipboard_paste_verify_wait_${delay}`);
            await sleep(delay);
            inspect = await inspectAtomicType(tabId, token, args.text, preparation.snapshots, !!args.submit);
          }
          return inspect;
        });
        status = pasted.result;
        clipboardRestore = pasted.clipboardRestore;
      } catch (e) {
        richTextUnsafeFailure = true;
        await clearFocusedEditableWithTrustedKeys(tabId, tried);
        const afterClear = await inspectAtomicDraft(tabId, token);
        tried.push(...afterClear.tried);
        lastStatus = {
          ok: false,
          target_kind: afterClear.target_kind,
          scope_kind: afterClear.scope_kind,
          actual_text: afterClear.target_text,
          residue_preview: afterClear.residue_preview,
          placeholder_visible: false,
          error: e instanceof Error ? e.message : String(e),
          rollback: afterClear.empty,
          tried,
        };
        break;
      }

      status.tried = [...tried, ...status.tried];
      if (status.ok) {
        const submit = args.submit ? await submitCurrentEditor(tabId, token, tried) : null;
        const context = await getTabContext(tabId);
        const result: TypeResult = {
          typed_chars: args.text.length,
          submitted: submit ? submit.submitted && !submit.post_submit_text_still_present : false,
          verified: true,
          strategy: 'clipboard_paste',
          target_kind: status.target_kind,
          scope_kind: status.scope_kind,
          submit_button_disabled: submit?.button?.disabled ?? status.submit_button_disabled ?? false,
          actual_text_preview: (status.actual_text || '').slice(0, 160),
          ...context,
          submit_method: submit?.method,
          submit_button_ref: submit?.button?.ref_id,
          submit_button_label: submit?.button?.label,
          post_submit_text_still_present: submit?.post_submit_text_still_present,
          candidate_submit_buttons: submit?.candidates.slice(0, 5),
          attempted_submit_buttons: submit?.attempted_buttons?.slice(0, 5),
        };
        if (clipboardRestore.mode !== 'full' || clipboardRestore.error) {
          result.clipboard_restore_mode = clipboardRestore.mode;
          result.clipboard_restore_error = clipboardRestore.error;
        }
        return result;
      }

      richTextUnsafeFailure = true;
      await clearFocusedEditableWithTrustedKeys(tabId, tried);
      const afterClear = await inspectAtomicDraft(tabId, token);
      tried.push(...afterClear.tried);
      lastStatus = {
        ...status,
        rollback: afterClear.empty,
        residue_preview: afterClear.residue_preview || status.residue_preview,
        tried,
      };
      break;
    }

    await strategy.run();
    await new Promise((r) => setTimeout(r, 180));
    let status = await inspectAtomicType(tabId, token, args.text, preparation.snapshots, !!args.submit);
    status.tried = [...tried, ...status.tried];

    if (status.ok) {
      const submit = args.submit ? await submitCurrentEditor(tabId, token, tried) : null;
      const context = await getTabContext(tabId);
      return {
        typed_chars: args.text.length,
        submitted: submit ? submit.submitted && !submit.post_submit_text_still_present : false,
        verified: true,
        strategy: strategy.name,
        target_kind: status.target_kind,
        scope_kind: status.scope_kind,
        submit_button_disabled: submit?.button?.disabled ?? status.submit_button_disabled ?? false,
        actual_text_preview: (status.actual_text || '').slice(0, 160),
        ...context,
        submit_method: submit?.method,
        submit_button_ref: submit?.button?.ref_id,
        submit_button_label: submit?.button?.label,
        post_submit_text_still_present: submit?.post_submit_text_still_present,
        candidate_submit_buttons: submit?.candidates.slice(0, 5),
        attempted_submit_buttons: submit?.attempted_buttons?.slice(0, 5),
      } satisfies TypeResult;
    }

    const rollback = await rollbackAtomicType(tabId, token, args.text, preparation.snapshots);
    let rollbackResidue = rollback.residue_preview || status.residue_preview;
    let rollbackOk = !!rollback.rollback;
    lastStatus = {
      ...status,
      rollback: rollbackOk,
      residue_preview: rollbackResidue,
      tried,
    };
    if (!rollbackOk) break;
  }

  const status = lastStatus;
  const preview = (status?.actual_text || lastPreparation?.actual_text || '').slice(0, 160);
  const residue = (status?.residue_preview || '').slice(0, 160);
  if (richTextUnsafeFailure) {
    await markRichTextDirty(tabId, sessionId, status?.error || 'Rich-text input validation failed');
  }
  throw new Error(
    `Type failed: ${status?.error || typedTextError({ actual_text: preview }, args.text) || 'target editor does not contain the text to input'}. target=${status?.target_kind || lastPreparation?.target_kind || 'none'}; scope=${status?.scope_kind || lastPreparation?.scope_kind || 'none'}; rollback=${status?.rollback ?? false}; residue="${residue}"; tried=${tried.join(', ')}; actual="${preview}"`,
  );
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
  if (!state) throw new Error(`Session ${sessionId} not initialized`);
  const tabId = state.currentTabId;
  await chrome.tabs.update(tabId, { url: args.url });
  const ready = await waitForTabComplete(tabId);
  // 如果之前 group 没建成（比如 chrome://newtab/ 不能 group），现在跳到普通页可以补建
  await tg.ensureGroupForSession(sessionId).catch(() => {});
  return { tabId, url: args.url, ready };
}

async function openTab(sessionId: string, args: { url: string }) {
  const state = sessionStates.get(sessionId);
  if (!state) throw new Error(`Session ${sessionId} not initialized`);
  const tab = await chrome.tabs.create({ url: args.url, active: false });
  if (tab.id == null) throw new Error('chrome.tabs.create returned no id');
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

async function visualInspect(sessionId: string, args: VisualInspectArgs) {
  const tabId = await getCurrentTab(sessionId);
  const tab = await chrome.tabs.get(tabId);
  const scope = args.scope || (args.ref_id ? 'element' : 'viewport');
  const question = args.question?.trim() || 'Describe the visible browser page. Include visible text, UI state, and anything important for deciding the next browser action.';
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;

  if (scope === 'element') {
    if (!args.ref_id) throw new Error('visual_inspect scope="element" requires ref_id');
    await ensureA11yInjected(tabId);
    const clipResult = await runInPage<{
      ok?: boolean;
      error?: string;
      clip?: { x: number; y: number; width: number; height: number; scale: number };
    }>(
      tabId,
      (targetRef) => {
        const ref = window.__hermesElementMap[targetRef];
        const node = ref && ref.deref ? ref.deref() : null;
        if (!(node instanceof Element)) return { ok: false, error: 'ref_id not found' };
        node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { ok: false, error: 'target element has no visible box' };
        const pad = 12;
        const doc = document.documentElement;
        const maxWidth = Math.max(doc.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth);
        const maxHeight = Math.max(doc.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight);
        const x = Math.max(0, window.scrollX + rect.left - pad);
        const y = Math.max(0, window.scrollY + rect.top - pad);
        const width = Math.min(maxWidth - x, rect.width + pad * 2);
        const height = Math.min(maxHeight - y, rect.height + pad * 2);
        return {
          ok: true,
          clip: {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
            scale: 1,
          },
        };
      },
      [args.ref_id],
    );
    if (!clipResult.ok || !clipResult.clip) throw new Error(clipResult.error || 'failed to resolve visual_inspect element clip');
    clip = clipResult.clip;
    await sleep(200);
  }

  const shot = await cdp.screenshot(tabId, 'jpeg', clip);
  return {
    ...shot,
    question,
    scope,
    ref_id: args.ref_id,
    clip,
    tabId,
    url: tab.url || '',
    title: tab.title || '',
  };
}

async function fetchUrl(_sessionId: string, args: { url: string }) {
  if (!args.url) return { error: 'url argument is required' };
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
    return { error: `fetch failed: ${e instanceof Error ? e.message : String(e)}`, url: args.url };
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
  const dirty = await getRichTextDirtyState(tabId);
  if (dirty && /\bEnter\b/i.test(args.key)) {
    throw new Error(richTextDirtyError(dirty));
  }
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
  return { pressed: args.key, ...(await getTabContext(tabId)) };
}

async function getConsoleLogs(sessionId: string, args: { tabId?: number; level?: string; limit?: number }) {
  const current = getSessionTab(sessionId);
  if (args.tabId != null) bindSessionToTab(sessionId, args.tabId);
  try {
    const tabId = await getCurrentTab(sessionId);
    const lim = Math.max(1, Math.min(200, args.limit ?? 30));
    const level = typeof args.level === 'string' ? args.level.toLowerCase() : 'all';
    const normalizedLevel = (['log', 'info', 'warn', 'error', 'debug', 'all'] as const).includes(level as any)
      ? (level as 'log' | 'info' | 'warn' | 'error' | 'debug' | 'all')
      : 'all';
    const cdpLogs = await cdp.readConsoleLogs(tabId, normalizedLevel, lim).catch(() => []);

    const fallback = await runInPage<unknown[]>(tabId, (fallbackLevel, fallbackLimit) => {
      const buf = (window as any).__hermesConsoleBufferMain || [];
      const filtered = fallbackLevel === 'all' ? buf : buf.filter((x: any) => x.level === fallbackLevel);
      return filtered.slice(-fallbackLimit);
    }, [normalizedLevel, lim], 'MAIN').catch(() => []);
    const fallbackLogs = Array.isArray(fallback)
      ? fallback.map((item: any) => ({
          timestamp: typeof item?.ts === 'number' ? item.ts : Date.now(),
          level: typeof item?.level === 'string' ? item.level : 'log',
          source: 'fallback-main',
          text: String(item?.msg ?? item?.message ?? ''),
          argsPreview: String(item?.msg ?? item?.message ?? ''),
        }))
      : [];
    const logs = [...cdpLogs, ...fallbackLogs]
      .sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0))
      .slice(-lim);
    const source = cdpLogs.length && fallbackLogs.length
      ? 'cdp+fallback'
      : cdpLogs.length
        ? 'cdp'
        : 'fallback';
    return { logs, tabId, filter: normalizedLevel, source };
  } finally {
    if (current != null) bindSessionToTab(sessionId, current);
  }
}

async function readNetworkRequests(sessionId: string, args: NetworkArgs) {
  const current = getSessionTab(sessionId);
  if (args.tabId != null) bindSessionToTab(sessionId, args.tabId);
  try {
    const tabId = await getCurrentTab(sessionId);
    const logs = await cdp.readNetworkRequests(tabId, {
      filter: args.filter,
      limit: args.limit,
      includeHeaders: args.includeHeaders,
      includeFailed: args.includeFailed,
      includeBody: args.includeBody,
    });
    return { tabId, requests: logs };
  } finally {
    if (current != null) bindSessionToTab(sessionId, current);
  }
}

async function closeTab(sessionId: string, args: CloseTabArgs) {
  const prev = getSessionTab(sessionId);
  const state = sessionStates.get(sessionId);
  const current = state?.currentTabId;
  const targetTabId = args.tabId ?? current;
  if (!targetTabId) throw new Error('No active tab to close');

  const ownerSession = tg.getSessionByTab(targetTabId);
  const isOwnTab = ownerSession != null && ownerSession === sessionId;
  if (!isOwnTab && !args.force && args.tabId == null) {
    throw new Error('close_tab: refusing to close current non-Hermes tab. Pass force=true to close explicitly.');
  }
  if (!isOwnTab && !args.force) {
    throw new Error('close_tab: refusing to close non-Hermes-managed tab. Pass force=true to close explicitly.');
  }
  await chrome.tabs.remove(targetTabId);

  if (state && state.currentTabId === targetTabId) {
    const rest = (await tg.listSessionTabs(sessionId).catch(() => [])).filter((id) => id !== targetTabId);
    if (rest.length > 0) {
      state.currentTabId = rest[0];
      bindSessionToTab(sessionId, rest[0]);
    }
  }
  if (prev != null && prev !== targetTabId) bindSessionToTab(sessionId, prev);
  return { action: 'close_tab', closed_tab_id: targetTabId, tabId: current, force: !!args.force };
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
  if (!args.query?.trim()) return { error: 'query argument is required' };
  const prevTabId = getSessionTab(sessionId);
  if (args.tabId != null) bindSessionToTab(sessionId, args.tabId);
  try {
    const tabId = await getCurrentTab(sessionId);
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
    if (matches.length < limit) {
      const seenRefs = new Set(matches.map((match) => match.ref_id));
      const dom = await scanInteractiveTargets(tabId, 80).catch(() => null);
      const queryLooksForSubmit = /(发送|发布|提交|评论|回复|send|submit|post|comment|reply)/i.test(args.query);
      const domMatches = dom
        ? [...dom.editables, ...dom.clickables]
          .filter((target) => !seenRefs.has(target.ref_id))
          .map((target) => {
            const inferredSubmit = queryLooksForSubmit
              && target.kind === 'clickable'
              && !!target.hasSvg
              && (target.nearestEditableDistance ?? 9999) < 260;
            const line = [
              target.kind === 'editable' ? 'dom_editable' : 'dom_clickable',
              `"${[target.label, target.placeholder, target.text].filter(Boolean).join(' ').replace(/"/g, '\\"')}"`,
              `[${target.ref_id}]`,
              `tag=${target.tag}`,
              `role=${target.role}`,
              target.hasSvg ? 'svg icon' : '',
              target.disabled ? 'disabled' : '',
              target.nearestEditableRef ? `near=${target.nearestEditableRef}` : '',
              inferredSubmit ? 'possible submit send 发送 发布 评论' : '',
              target.notes?.join(' ') || '',
            ].filter(Boolean).join(' ');
            return { line, ref_id: target.ref_id, score: scoreA11yLine(line, terms) + (inferredSubmit ? 8 : 0) };
          })
          .filter((target) => target.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit - matches.length)
          .map(({ line, ref_id, score }) => ({ ref_id, score, line }))
        : [];
      matches.push(...domMatches);
    }
    return { query: args.query, count: matches.length, matches, url: page.url, title: page.title };
  } finally {
    if (args.tabId != null && prevTabId != null) bindSessionToTab(sessionId, prevTabId);
  }
}

async function saveToLocal(
  _sessionId: string,
  args: { path: string; content: string; encoding?: 'utf8' | 'base64'; create_dirs?: boolean; overwrite?: boolean },
) {
  if (!args || typeof args.path !== 'string' || !args.path.trim()) {
    throw new Error('path argument is required (must be absolute)');
  }
  if (typeof args.content !== 'string') {
    throw new Error('content argument is required (string; for binaries use base64 + encoding=base64)');
  }
  const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
  const create_dirs = args.create_dirs !== false;
  const overwrite = args.overwrite === true;

  const resp = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('save_to_local timed out after 60s (large file or hung host)'));
    }, 60_000);
    try {
      chrome.runtime.sendNativeMessage(
        'com.hermes.filewriter',
        { op: 'write', path: args.path, content: args.content, encoding, create_dirs, overwrite },
        (response) => {
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || String(err)));
          resolve(response);
        },
      );
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Native Messaging call failed: ${msg}. Open the Hermes sidepanel and follow the status bar to install the host.`,
    );
  });

  if (!resp || resp.ok !== true) {
    throw new Error(`Failed to write file: ${resp?.error || 'unknown error'}`);
  }
  return {
    saved: true,
    path: resp.path,
    bytes_written: resp.bytes_written,
    encoding,
    overwritten: !!resp.overwritten,
  };
}

async function extractMarkdown(
  sessionId: string,
  args: { tabId?: number; max_chars?: number },
) {
  const prevTabId = getSessionTab(sessionId);
  if (args.tabId != null) bindSessionToTab(sessionId, args.tabId);
  try {
    const tabId = await getCurrentTab(sessionId);
    const maxChars = Math.max(1000, Math.min(2_000_000, args.max_chars ?? 500_000));
    const result = await runInPage<{ url: string; title: string; markdown: string; truncated: boolean }>(
      tabId,
      (limit) => {
        const SKIP_TAGS = new Set([
          'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'TEMPLATE', 'SVG', 'CANVAS',
          'NAV', 'FOOTER', 'ASIDE', 'HEADER', 'FORM',
        ]);
        const MAX_NODES = 50_000;
        const MAX_TIME_MS = 8_000;
        const startTime = performance.now();
        let nodeCount = 0;
        let walkTruncated = false;

        function isVisible(el: Element): boolean {
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (parseFloat(style.opacity || '1') < 0.05) return false;
          return true;
        }

        function inlineText(node: Node): string {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
          if (node.nodeType !== Node.ELEMENT_NODE) return '';
          const el = node as Element;
          if (SKIP_TAGS.has(el.tagName)) return '';
          const tag = el.tagName;
          if (tag === 'BR') return '\n';
          if (tag === 'IMG') {
            const alt = el.getAttribute('alt') || '';
            const src = el.getAttribute('src') || '';
            return src ? `![${alt}](${src})` : '';
          }
          if (tag === 'A') {
            const href = el.getAttribute('href') || '';
            const text = Array.from(el.childNodes).map(inlineText).join('').trim();
            if (!text) return '';
            return href ? `[${text}](${href})` : text;
          }
          if (tag === 'CODE' && !el.closest('pre')) {
            return '`' + (el.textContent || '').replace(/`/g, '\\`') + '`';
          }
          if (tag === 'STRONG' || tag === 'B') {
            const inner = Array.from(el.childNodes).map(inlineText).join('').trim();
            return inner ? `**${inner}**` : '';
          }
          if (tag === 'EM' || tag === 'I') {
            const inner = Array.from(el.childNodes).map(inlineText).join('').trim();
            return inner ? `*${inner}*` : '';
          }
          return Array.from(el.childNodes).map(inlineText).join('');
        }

        function blockText(el: Element, depth: number): string[] {
          if (walkTruncated) return [];
          nodeCount++;
          if (nodeCount > MAX_NODES || performance.now() - startTime > MAX_TIME_MS) {
            walkTruncated = true;
            return [];
          }
          if (SKIP_TAGS.has(el.tagName) || !isVisible(el)) return [];
          const tag = el.tagName;
          if (/^H[1-6]$/.test(tag)) {
            const level = Number(tag.slice(1));
            const text = inlineText(el).trim();
            return text ? ['#'.repeat(level) + ' ' + text, ''] : [];
          }
          if (tag === 'P') {
            const text = inlineText(el).trim();
            return text ? [text, ''] : [];
          }
          if (tag === 'BLOCKQUOTE') {
            const text = inlineText(el).trim();
            if (!text) return [];
            return [text.split('\n').map((line) => '> ' + line).join('\n'), ''];
          }
          if (tag === 'PRE') {
            const code = (el.textContent || '').replace(/\n+$/, '');
            const lang = el.querySelector('code')?.className?.match(/language-(\w+)/)?.[1] || '';
            return ['```' + lang, code, '```', ''];
          }
          if (tag === 'HR') return ['---', ''];
          if (tag === 'UL' || tag === 'OL') {
            const items: string[] = [];
            const isOrdered = tag === 'OL';
            let idx = 1;
            for (const li of Array.from(el.children)) {
              if (li.tagName !== 'LI') continue;
              const prefix = isOrdered ? `${idx}. ` : '- ';
              const text = inlineText(li).trim().replace(/\n/g, ' ');
              if (text) items.push('  '.repeat(depth) + prefix + text);
              idx += 1;
            }
            items.push('');
            return items;
          }
          if (tag === 'TABLE') {
            const rows = Array.from(el.querySelectorAll('tr'));
            if (!rows.length) return [];
            const md: string[] = [];
            rows.forEach((tr, i) => {
              const cells = Array.from(tr.children).map((cell) => inlineText(cell).trim().replace(/\|/g, '\\|') || ' ');
              md.push('| ' + cells.join(' | ') + ' |');
              if (i === 0) md.push('| ' + cells.map(() => '---').join(' | ') + ' |');
            });
            md.push('');
            return md;
          }
          // Generic container: recurse
          const out: string[] = [];
          for (const child of Array.from(el.children)) {
            out.push(...blockText(child, depth));
          }
          if (out.length === 0) {
            const text = inlineText(el).trim();
            if (text) out.push(text, '');
          }
          return out;
        }

        const root = document.querySelector('article, main, [role="main"]') || document.body;
        const lines = blockText(root as Element, 0);
        let markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        const truncated = walkTruncated || markdown.length > limit;
        if (markdown.length > limit) markdown = markdown.slice(0, limit) + '\n\n…(truncated)';
        if (walkTruncated && markdown.length <= limit) markdown += '\n\n…(walk truncated)';
        return {
          url: location.href,
          title: document.title || '',
          markdown,
          truncated,
        };
      },
      [maxChars],
    );
    return result;
  } finally {
    if (args.tabId != null && prevTabId != null) bindSessionToTab(sessionId, prevTabId);
  }
}

// ── javascript_tool ───────────────────────────────────────

const JS_DENYLIST = [
  'document.cookie', 'localStorage', 'sessionStorage', 'indexedDB',
  'chrome.', 'fetch(', 'XMLHttpRequest', 'navigator.sendBeacon',
  'navigator.clipboard', 'eval(', 'Function(', 'import(',
  'WebSocket', 'EventSource', 'postMessage(', 'window.open(',
];

function validateSafeJavascript(code: string): void {
  if (code.length > 8000) throw new Error('Code exceeds 8000 characters');
  // Block obviously obfuscated code: >500 chars without space or newline
  if (code.length > 500 && !/[ \n]/.test(code.slice(0, 500)) && !/[ \n]/.test(code.slice(500))) {
    throw new Error('Code appears obfuscated');
  }
  if (/\bwhile\s*\(\s*true\s*\)/.test(code)) throw new Error('while(true) is forbidden');
  if (/<script[\s>]/i.test(code)) throw new Error('Creating <script> tags is forbidden');
  if (/<iframe[\s>]/i.test(code)) throw new Error('Creating <iframe> elements is forbidden');
  const lower = code.toLowerCase();
  for (const kw of JS_DENYLIST) {
    if (lower.includes(kw.toLowerCase())) throw new Error(`Forbidden: ${kw}`);
  }
}

function truncateValue(v: unknown, maxChars: number): unknown {
  if (typeof v === 'string' && v.length > maxChars) return v.slice(0, maxChars) + '…(truncated)';
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => truncateValue(x, maxChars));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).slice(0, 200)) {
      out[k] = truncateValue((v as Record<string, unknown>)[k], maxChars);
    }
    return out;
  }
  return v;
}

async function javascriptTool(_sessionId: string, args: {
  code?: string; tabId?: number; timeoutMs?: number; returnByValue?: boolean;
}) {
  const code = String(args.code || '');
  if (!code.trim()) return { error: 'code is required' };
  if (code.length > 8000) return { error: `Code exceeds 8000 characters (got ${code.length})` };

  try {
    validateSafeJavascript(code);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), blocked: true };
  }

  const tabId = args.tabId ?? (await getCurrentTab(_sessionId).catch(() => undefined));
  if (tabId == null) return { error: 'No active tab for javascript_tool' };

  const timeoutMs = Math.min(args.timeoutMs ?? 1000, 3000);

  try {
    const raw = await Promise.race([
      cdp.evaluate(tabId, code),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`javascript_tool timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    const wasTruncated = typeof raw === 'string' && raw.length > 4000;
    return { result: truncateValue(raw, 4000), wasTruncated };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function browserBatch(sessionId: string, args: { actions?: BatchAction[] }) {
  const actions = args.actions || [];
  if (!Array.isArray(actions) || actions.length === 0) return { error: 'actions argument is required' };
  if (actions.length > 20) return { error: 'browser_batch supports at most 20 actions per call' };
  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const tool = action.tool || action.name;
    const input = action.args || action.input || {};
    if (!tool) {
      results.push({ index: i, ok: false, error: 'tool/name missing' });
      break;
    }
    if (tool === 'browser_batch') {
      results.push({ index: i, tool, ok: false, error: 'browser_batch cannot call itself recursively' });
      break;
    }
    try {
      const data = await Promise.race([
        execute(sessionId, tool, input),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`browser_batch action ${tool} timed out after 30s`)), 30_000),
        ),
      ]);
      results.push({ index: i, tool, ok: true, data });
    } catch (e) {
      results.push({ index: i, tool, ok: false, error: e instanceof Error ? e.message : String(e) });
      break;
    }
  }
  return { results, completed: results.filter((r) => r.ok).length, total: actions.length };
}

// ── shortcuts ────────────────────────────────────────────

const SHORTCUTS: Record<string, string> = {
  'browser.reload': 'Meta+R',
  'browser.find': 'Meta+F',
  'browser.address_bar': 'Meta+L',
  'editing.submit': 'Meta+Enter',
  'editing.select_all': 'Meta+A',
  'editing.copy': 'Meta+C',
  'editing.paste': 'Meta+V',
  'media.play_pause': 'Space',
  'media.fullscreen': 'F',
  'media.mute': 'M',
};

async function shortcutsList(_sessionId: string, args: { scope?: string }) {
  const scope = args.scope;
  if (scope) {
    const prefix = scope + '.';
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(SHORTCUTS)) {
      if (k.startsWith(prefix)) filtered[k] = v;
    }
    return { shortcuts: filtered };
  }
  return { shortcuts: SHORTCUTS };
}

async function shortcutsExecute(_sessionId: string, args: { id?: string }) {
  if (!args.id) return { error: 'id is required' };
  const chord = SHORTCUTS[args.id];
  if (!chord) return { error: `Unknown shortcut: ${args.id}`, available: Object.keys(SHORTCUTS) };
  return pressKey(_sessionId, { key: chord });
}

// ── resize_window ─────────────────────────────────────────

async function resizeWindow(_sessionId: string, args: { width?: number; height?: number }) {
  const w = args.width, h = args.height;
  if (typeof w !== 'number' || typeof h !== 'number') return { error: 'width and height are required' };
  if (w < 320 || w > 2560 || h < 480 || h > 1600) {
    return { error: `Dimensions out of range. width: 320-2560, height: 480-1600` };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.windowId) return { error: 'Could not find window' };
  await chrome.windows.update(tab.windowId, { width: w, height: h });
  return { width: w, height: h };
}

// ── file_upload / upload_image ────────────────────────────

const SENSITIVE_DIRS = ['.ssh', '.aws', '.gnupg', '.zshrc', '.bashrc', '.bash_profile', '.profile'];

function validateUploadPath(p: string): void {
  // Accept only absolute or ~ paths
  if (!p.startsWith('/') && !p.startsWith('~')) throw new Error(`Path must be absolute: ${p}`);
  const normalized = p.startsWith('~') ? '/Users/__home_placeholder' + p.slice(1) : p;
  for (const dir of SENSITIVE_DIRS) {
    if (normalized.includes(`/${dir}`) || normalized.endsWith(`/${dir}`)) {
      throw new Error(`Path in sensitive directory: ${dir}`);
    }
  }
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

async function fileUpload(_sessionId: string, args: {
  ref_id?: string; selector?: string; tabId?: number; paths?: string[]; submit?: boolean;
}) {
  const paths = args.paths || [];
  if (!paths.length) return { error: 'paths is required' };
  for (const p of paths) {
    try { validateUploadPath(p); }
    catch (e) { return { error: (e as Error).message }; }
  }

  const tabId = args.tabId ?? (await getCurrentTab(_sessionId).catch(() => undefined));
  if (tabId == null) return { error: 'No active tab' };

  try {
    // Ensure debugger is attached to this tab
    await cdp.evaluate(tabId, '').catch(() => {});

    let nodeId: number | undefined;

    // Strategy 1: ref_id → find via __hermesElementMap → CDP DOM.requestNode
    if (args.ref_id && !nodeId) {
      try {
        const evalResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `(function() {
            const m = window.__hermesElementMap;
            if (!m) return null;
            const ref = m[${JSON.stringify(args.ref_id)}];
            const el = ref && ref.deref ? ref.deref() : ref;
            return el instanceof Element ? el : null;
          })()`,
          returnByValue: false,
        }) as { result?: { objectId?: string; type?: string } };
        if (evalResult?.result?.objectId) {
          const node = await chrome.debugger.sendCommand({ tabId }, 'DOM.requestNode', {
            objectId: evalResult.result.objectId,
          }) as { nodeId: number };
          if (node?.nodeId) nodeId = node.nodeId;
        }
      } catch { /* fall through */ }
    }

    // Strategy 2: selector → CDP DOM.querySelector
    if (!nodeId && args.selector) {
      try {
        const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } };
        const sel = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: args.selector,
        }) as { nodeId: number } | null;
        if (sel?.nodeId) nodeId = sel.nodeId;
      } catch { /* fall through */ }
    }

    // Strategy 3: find first file input
    if (!nodeId) {
      try {
        const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } };
        const fi = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: 'input[type="file"]',
        }) as { nodeId: number } | null;
        if (fi?.nodeId) nodeId = fi.nodeId;
      } catch { /* fall through */ }
    }

    if (!nodeId) return { error: 'No file input found on page' };

    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
      files: paths,
      nodeId,
    });

    const result: Record<string, unknown> = { uploaded: true, paths_count: paths.length };

    if (args.submit) {
      try {
        // Escape selector for safe interpolation into JS string
        const safeSelector = (args.selector || 'input[type="file"]').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `document.querySelector('${safeSelector}')?.closest('form')?.requestSubmit()`,
        }).catch(() => {});
        result.submit_attempted = true;
      } catch { result.submit_attempted = false; }
    }
    return result;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function uploadImage(_sessionId: string, args: {
  ref_id?: string; selector?: string; tabId?: number; paths?: string[]; submit?: boolean;
}) {
  const paths = args.paths || [];
  for (const p of paths) {
    const ext = '.' + p.split('.').pop()?.toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return { error: `upload_image only allows images, got: ${p}` };
  }
  return fileUpload(_sessionId, args);
}

const TOOLS: Record<ToolName, (sessionId: string, args: any) => Promise<unknown>> = {
  fetch_url: fetchUrl,
  tabs_context: tabsContext,
  read_page: readPage,
  inspect_targets: inspectTargets,
  find: findElement,
  click: clickRef,
  hover,
  right_click: rightClick,
  double_click: doubleClick,
  drag,
  type: typeText,
  scroll,
  scroll_to: scrollTo,
  navigate,
  open_tab: openTab,
  close_tab: closeTab,
  screenshot: screenshotTool,
  visual_inspect: visualInspect,
  wait,
  browser_batch: browserBatch,
  get_console_logs: getConsoleLogs,
  read_network_requests: readNetworkRequests,
  key: pressKey,
  save_to_local: saveToLocal,
  extract_markdown: extractMarkdown,
  javascript_tool: javascriptTool,
  file_upload: fileUpload,
  upload_image: uploadImage,
  shortcuts_list: shortcutsList,
  shortcuts_execute: shortcutsExecute,
  resize_window: resizeWindow,
};

export async function execute(sessionId: string, tool: ToolName, args: Record<string, unknown>) {
  const fn = TOOLS[tool];
  if (!fn) throw new Error(`Unknown tool: ${tool}`);
  return fn(sessionId, args);
}
