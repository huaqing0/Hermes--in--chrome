// 工具分发器：per-session 工具上下文（每个 agent session 独立 currentTabId）

import * as cdp from './debugger';
import * as tg from './tabGroup';
import type { ToolName } from '../types/messages';

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
  submit_button_disabled: false;
  actual_text_preview: string;
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
  return `前一次富文本输入失败，页面可能还有 X/YouTube 隐藏草稿残留，已禁止继续输入或提交。请刷新页面或重新打开发布框后再试。原因：${dirty.reason}`;
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
  const dirty = await getRichTextDirtyState(tabId);
  if (dirty && await refIdLooksLikeSubmitButton(tabId, args.ref_id)) {
    throw new Error(richTextDirtyError(dirty));
  }
  const { x, y } = await refIdToCoords(tabId, args.ref_id);
  await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PHANTOM_CURSOR', x, y }).catch(() => {});
  await new Promise((r) => setTimeout(r, 220));
  await cdp.mouseClick(tabId, x, y);
  return { clicked: args.ref_id, x, y };
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
      const positive = /(发帖|发布|发送|评论|回复|post|tweet|send|comment|reply)/i;
      const negative = /(添加|add|gif|emoji|media|图片|照片|投票|schedule|日程|draft|草稿|下一步|next)/i;
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
  if (repeats > 1) return `输入内容重复了 ${repeats} 次，已阻止继续提交`;
  return '目标编辑器内容与要输入的文本不一致';
}

async function prepareAtomicType(tabId: number, refId: string | undefined, token: string, text: string): Promise<AtomicTypePreparation> {
  return runInPage<AtomicTypePreparation>(
    tabId,
    (targetRef, markerToken, inputText) => {
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

      function normalize(value: string | null | undefined): string {
        return (value || '').replace(/\s+/g, ' ').trim();
      }

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
        const negative = /(添加|add|gif|emoji|media|图片|照片|投票|schedule|日程|draft|草稿|下一步|next)/i;
        return Boolean(label && positive.test(label) && !negative.test(label));
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

      document
        .querySelectorAll('[data-hermes-type-target],[data-hermes-type-scope],[data-hermes-editable-index]')
        .forEach((node) => {
          node.removeAttribute('data-hermes-type-target');
          node.removeAttribute('data-hermes-type-scope');
          node.removeAttribute('data-hermes-editable-index');
        });

      if (normalize(inputText)) {
        for (const editable of Array.from(document.querySelectorAll(editableSelector)).filter(isVisible)) {
          if (normalize(readText(editable)).includes(normalize(inputText))) {
            clearTarget(editable);
            tried.push('clear_existing_residue');
          }
        }
      }

      const target = resolveEditable();
      if (!target) {
        return { ok: false, token: markerToken, target_kind: 'none', scope_kind: 'none', actual_text: '', snapshots: [], tried, error: 'No editable target found' };
      }
      const scope = resolveScope(target);
      (target as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center' });
      (target as HTMLElement).focus?.();
      clearTarget(target);
      tried.push('clear_target');

      const targetText = readText(target);
      if (targetText.replace(/\s+/g, ' ').trim()) {
        return {
          ok: false,
          token: markerToken,
          target_kind: targetKind(target),
          scope_kind: scopeKind(scope),
          actual_text: targetText,
          snapshots: [],
          tried,
          error: '清空目标编辑器失败，未执行输入',
        };
      }

      target.setAttribute('data-hermes-type-target', markerToken);
      scope.setAttribute('data-hermes-type-scope', markerToken);
      const editables = Array.from(scope.querySelectorAll(editableSelector)).filter(isVisible);
      if (!editables.includes(target)) editables.unshift(target);
      const snapshots = editables
        .filter((el, index, arr) => arr.indexOf(el) === index)
        .map((el, index) => {
          el.setAttribute('data-hermes-editable-index', String(index));
          return { index, text: readText(el), target: el === target };
        });
      const dirty = snapshots.find((item) => !item.target && normalize(item.text));
      if (dirty) {
        return {
          ok: false,
          token: markerToken,
          target_kind: targetKind(target),
          scope_kind: scopeKind(scope),
          actual_text: targetText,
          snapshots,
          tried,
          error: '输入作用域内存在其他未清空编辑器，未执行输入',
        };
      }

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
    [refId ?? null, token, text],
  );
}

async function inspectAtomicType(tabId: number, token: string, expected: string): Promise<EditableStatus> {
  return runInPage<EditableStatus>(
    tabId,
    (markerToken, inputText) => {
      const tried: string[] = ['inspect_atomic_type'];
      const editableSelector = 'textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]';
      const target = document.querySelector(`[data-hermes-type-target="${markerToken}"]`);
      const scope = document.querySelector(`[data-hermes-type-scope="${markerToken}"]`) || target?.parentElement || null;

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

      if (!target) {
        return { ok: false, target_kind: 'none', scope_kind: scopeKind(scope), actual_text: '', residue_preview: '', placeholder_visible: false, error: '目标编辑器标记丢失', tried };
      }

      const actual = readText(target);
      const editables = scope ? Array.from(scope.querySelectorAll(editableSelector)).filter(isVisible) : [target];
      if (!editables.includes(target)) editables.unshift(target);
      const uniqueEditables = editables.filter((el, index, arr) => arr.indexOf(el) === index);
      const otherTexts = uniqueEditables
        .filter((el) => el !== target)
        .map(readText)
        .filter((text) => Boolean(normalize(text)));
      const targetRepeats = repeatedCount(actual);
      const submit = submitButtonState(scope);
      const placeholderVisible = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? false : isPlaceholderVisible(target);
      let error: string | undefined;
      if (!normalize(inputText) || normalize(actual) !== normalize(inputText)) {
        error = targetRepeats > 1 ? `输入内容重复了 ${targetRepeats} 次，已阻止继续提交` : '目标编辑器内容与要输入的文本不一致';
      } else if (otherTexts.length > 0) {
        error = '输入作用域内存在额外文本，已阻止继续提交';
      } else if (placeholderVisible) {
        error = '编辑器 placeholder 仍可见，页面没有接受这次富文本输入';
      } else if (submit.disabled) {
        error = `输入后“${submit.label}”按钮仍不可用，页面没有接受这次富文本输入`;
      }

      const residuePreview = otherTexts.concat(targetRepeats > 1 ? [actual] : []).join(' | ').slice(0, 180);
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
    [token, expected],
  );
}

async function inspectAtomicDraft(tabId: number, token: string): Promise<DraftInspection> {
  return runInPage<DraftInspection>(
    tabId,
    (markerToken) => {
      const tried: string[] = ['inspect_atomic_draft'];
      const editableSelector = 'textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]';
      const target = document.querySelector(`[data-hermes-type-target="${markerToken}"]`);
      const scope = document.querySelector(`[data-hermes-type-scope="${markerToken}"]`) || target?.parentElement || null;

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

      function isVisible(node: Element): boolean {
        const rect = (node as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(node as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity || '1') > 0.05;
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
          error: '目标编辑器标记丢失',
        };
      }

      const editables = scope ? Array.from(scope.querySelectorAll(editableSelector)).filter(isVisible) : [target];
      if (!editables.includes(target)) editables.unshift(target);
      const texts = editables
        .filter((el, index, arr) => arr.indexOf(el) === index)
        .map(readText)
        .filter((text) => Boolean(normalize(text)));
      const allText = texts.join(' | ');
      return {
        empty: texts.length === 0,
        target_kind: targetKind(target),
        scope_kind: scopeKind(scope),
        target_text: readText(target),
        all_text: allText,
        residue_preview: allText.slice(0, 180),
        tried,
        error: texts.length > 0 ? '输入前作用域没有清空' : undefined,
      };
    },
    [token],
  );
}

async function rollbackAtomicType(tabId: number, token: string, expected: string, snapshots: EditableSnapshot[]): Promise<EditableStatus> {
  return runInPage<EditableStatus>(
    tabId,
    (markerToken, inputText, previousSnapshots) => {
      const tried: string[] = ['rollback_atomic_type'];
      const editableSelector = 'textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]';
      const scope = document.querySelector(`[data-hermes-type-scope="${markerToken}"]`);
      const target = document.querySelector(`[data-hermes-type-target="${markerToken}"]`);

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
        error: '输入验证失败，已回滚本次输入残留',
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
      const target = document.querySelector(`[data-hermes-type-target="${markerToken}"]`);
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: 'center', inline: 'center' });
        target.focus();
      }
    },
    [token],
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 160));
}

async function typeText(sessionId: string, args: { ref_id?: string; text: string; submit?: boolean }) {
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
  const richTextStrategy = { name: 'cdp_key_events_per_char', run: () => cdp.typeTextByKeyEvents(tabId, args.text, 30) };

  for (let attempt = 0; attempt < plainTextStrategies.length; attempt += 1) {
    const token = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const preparation = await prepareAtomicType(tabId, args.ref_id, token, args.text);
    lastPreparation = preparation;
    const richTextTarget = isRichTextTarget(preparation.target_kind);
    const strategy = richTextTarget ? richTextStrategy : plainTextStrategies[attempt];
    tried.push(...preparation.tried, strategy.name);
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
        lastStatus = {
          ok: false,
          target_kind: emptyStatus.target_kind,
          scope_kind: emptyStatus.scope_kind,
          actual_text: emptyStatus.target_text,
          residue_preview: emptyStatus.residue_preview,
          placeholder_visible: false,
          error: emptyStatus.error || '富文本编辑器清空失败，未执行输入',
          rollback: false,
          tried,
        };
        break;
      }
      await refocusAtomicTarget(tabId, token, tried);
    }

    await strategy.run();
    await new Promise((r) => setTimeout(r, 180));
    let status = await inspectAtomicType(tabId, token, args.text);
    status.tried = [...tried, ...status.tried];

    if (status.ok && richTextTarget && status.submit_button_disabled) {
      tried.push('activation_nudge');
      await cdp.typeTextByKeyEvents(tabId, ' ');
      await cdp.pressKey(tabId, 'Backspace');
      await new Promise((r) => setTimeout(r, 180));
      status = await inspectAtomicType(tabId, token, args.text);
      status.tried = [...tried, ...status.tried];
    }

    if (status.ok) {
      if (args.submit) await cdp.pressKey(tabId, 'Enter');
      return {
        typed_chars: args.text.length,
        submitted: !!args.submit,
        verified: true,
        strategy: strategy.name,
        target_kind: status.target_kind,
        scope_kind: status.scope_kind,
        submit_button_disabled: false,
        actual_text_preview: (status.actual_text || '').slice(0, 160),
      } satisfies TypeResult;
    }

    if (richTextTarget) richTextUnsafeFailure = true;
    const rollback = await rollbackAtomicType(tabId, token, args.text, preparation.snapshots);
    let rollbackResidue = rollback.residue_preview || status.residue_preview;
    let rollbackOk = !!rollback.rollback;
    if (richTextTarget) {
      await clearFocusedEditableWithTrustedKeys(tabId, tried);
      const afterClear = await inspectAtomicDraft(tabId, token);
      tried.push(...afterClear.tried);
      rollbackResidue = afterClear.residue_preview || rollbackResidue;
      rollbackOk = afterClear.empty;
    }
    lastStatus = {
      ...status,
      rollback: rollbackOk,
      residue_preview: rollbackResidue,
      tried,
    };
    if (richTextTarget || !rollbackOk) break;
  }

  const status = lastStatus;
  const preview = (status?.actual_text || lastPreparation?.actual_text || '').slice(0, 160);
  const residue = (status?.residue_preview || '').slice(0, 160);
  if (richTextUnsafeFailure) {
    await markRichTextDirty(tabId, sessionId, status?.error || '富文本输入验证失败');
  }
  throw new Error(
    `输入失败：${status?.error || typedTextError({ actual_text: preview }, args.text) || '目标编辑器没有包含要输入的文本'}。target=${status?.target_kind || lastPreparation?.target_kind || 'none'}; scope=${status?.scope_kind || lastPreparation?.scope_kind || 'none'}; rollback=${status?.rollback ?? false}; residue="${residue}"; tried=${tried.join(', ')}; actual="${preview}"`,
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
