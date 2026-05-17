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
type TypeResult = {
  typed_chars: number;
  submitted: boolean;
  verified: true;
  strategy: string;
  target_kind: string;
  actual_text_preview: string;
};
type PageTypeAttempt = {
  ok: boolean;
  strategy: string;
  target_kind: string;
  actual_text: string;
  error?: string;
  tried: string[];
};
type EditableStatus = {
  target_kind: string;
  actual_text: string;
  placeholder_visible: boolean;
  submit_button_label?: string;
  submit_button_disabled?: boolean;
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

async function pageTypeAttempt(tabId: number, refId: string | undefined, text: string): Promise<PageTypeAttempt> {
  return runInPage<PageTypeAttempt>(
    tabId,
    (targetRef, inputText) => {
      const tried: string[] = [];
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

      function matchesExpected(actual: string): boolean {
        const a = normalize(actual);
        const b = normalize(inputText);
        return b.length === 0 || a === b;
      }

      function refElement(): Element | null {
        if (!targetRef) {
          return document.activeElement instanceof Element ? document.activeElement : null;
        }
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

      function scoreCandidate(el: Element): number {
        if (el instanceof HTMLTextAreaElement) return 10;
        if (el instanceof HTMLInputElement) return 9;
        if (el instanceof HTMLElement && el.isContentEditable) return 8;
        if (el.getAttribute('role') === 'textbox') return 7;
        return 0;
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
        const visible = candidates
          .filter((el, index, arr) => arr.indexOf(el) === index)
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          })
          .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
        return visible[0] || null;
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
        const aria = el.getAttribute('aria-label') || '';
        const text = (el as HTMLElement).innerText || el.textContent || '';
        return text || aria;
      }

      function dispatchInputEvents(el: Element, inputType = 'insertText') {
        try {
          el.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType,
            data: inputText,
          }));
        } catch {}
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType,
            data: inputText,
          }));
        } catch {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function focusTarget(el: Element) {
        (el as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center' });
        (el as HTMLElement).focus?.();
      }

      function clearTarget(el: Element) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, '');
          else el.value = '';
          dispatchInputEvents(el, 'deleteContentBackward');
          return;
        }
        if (el instanceof HTMLElement) {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel?.removeAllRanges();
          sel?.addRange(range);
          if (!document.execCommand('delete')) {
            el.textContent = '';
          }
          dispatchInputEvents(el, 'deleteContentBackward');
        }
      }

      const target = resolveEditable();
      if (!target) {
        return { ok: false, strategy: 'none', target_kind: 'none', actual_text: '', error: 'No editable target found', tried };
      }

      focusTarget(target);
      clearTarget(target);

      // contenteditable / role=textbox 一般是 React 受控编辑器（Draft.js / Slate / Lexical /
      // ProseMirror）— 它们检查 InputEvent.isTrusted，会拒绝合成事件，导致 DOM 写入但
      // internal state 不更新（placeholder 不消失、提交按钮不亮）。这里直接跳过 DOM 策略，
      // 让外层 typeText 走 CDP Input.insertText（trusted event）。
      if (target instanceof HTMLElement && !(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)
          && (target.isContentEditable || target.getAttribute('role') === 'textbox')) {
        tried.push('skipped_dom_for_contenteditable');
        return {
          ok: false,
          strategy: 'skipped_dom_for_contenteditable',
          target_kind: targetKind(target),
          actual_text: readText(target),
          tried,
        };
      }

      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        tried.push('native_value_setter');
        const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(target, inputText);
        else target.value = inputText;
        dispatchInputEvents(target);
        const actual = readText(target);
        if (matchesExpected(actual)) {
          return { ok: true, strategy: 'native_value_setter', target_kind: targetKind(target), actual_text: actual, tried };
        }
      }

      tried.push('execCommand_insertText');
      focusTarget(target);
      try {
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, inputText);
      } catch {}
      let actual = readText(target);
      if (matchesExpected(actual)) {
        return { ok: true, strategy: 'execCommand_insertText', target_kind: targetKind(target), actual_text: actual, tried };
      }

      tried.push('paste_event');
      try {
        const data = new DataTransfer();
        data.setData('text/plain', inputText);
        target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      } catch {}
      actual = readText(target);
      if (matchesExpected(actual)) {
        return { ok: true, strategy: 'paste_event', target_kind: targetKind(target), actual_text: actual, tried };
      }

      return {
        ok: false,
        strategy: 'dom_attempts_failed',
        target_kind: targetKind(target),
        actual_text: actual,
        error: 'DOM input strategies did not update the target',
        tried,
      };
    },
    [refId ?? null, text],
  );
}

async function readEditableText(tabId: number, refId?: string): Promise<EditableStatus> {
  return runInPage(
    tabId,
    (targetRef) => {
      const ref = targetRef ? window.__hermesElementMap?.[targetRef] : null;
      const base = ref && ref.deref ? ref.deref() : document.activeElement;
      const editable = base instanceof Element
        ? (base.matches('textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]')
            ? base
            : base.querySelector('textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]') || document.activeElement)
        : document.activeElement;
      const el = editable instanceof Element ? editable : null;
      const target_kind = !el
        ? 'none'
        : el instanceof HTMLTextAreaElement
          ? 'textarea'
          : el instanceof HTMLInputElement
            ? `input:${el.type || 'text'}`
            : el instanceof HTMLElement && el.isContentEditable
              ? 'contenteditable'
              : el.getAttribute('role') === 'textbox'
                ? 'role=textbox'
                : el.tagName.toLowerCase();
      const actual_text = !el
        ? ''
        : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.value || ''
          : (el as HTMLElement).innerText || el.textContent || '';

      // Placeholder 是否还可见 — 对 React 受控编辑器（Draft.js / Slate / Lexical /
      // ProseMirror）来说，placeholder 还在显示 == internal state 仍为空 == 没真正接受输入。
      // 检查范围：目标 contenteditable 自身及其最近的相对定位容器（通常 placeholder 是
      // absolute 兄弟节点）。
      function isPlaceholderVisible(root: Element): boolean {
        const scope = root.closest('[role="dialog"],form,article,section,div') || root.parentElement || root;
        const selectors = [
          '[data-placeholder]',
          '[aria-placeholder]:not([contenteditable])',
          '.public-DraftEditorPlaceholder-root',
          '.public-DraftEditorPlaceholder-inner',
          '[data-slate-placeholder]',
          '[data-lexical-text-placeholder]',
          '.ProseMirror-placeholder',
        ];
        for (const sel of selectors) {
          const nodes = scope.querySelectorAll(sel);
          for (const node of Array.from(nodes)) {
            const r = (node as HTMLElement).getBoundingClientRect();
            const style = window.getComputedStyle(node as HTMLElement);
            if (r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity || '1') > 0.05) {
              return true;
            }
          }
        }
        return false;
      }

      function buttonText(button: Element): string {
        return [
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.textContent,
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      }

      function isVisible(node: Element): boolean {
        const rect = (node as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(node as HTMLElement);
        return rect.width > 0
          && rect.height > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none'
          && parseFloat(style.opacity || '1') > 0.05;
      }

      function submitButtonState(root: Element): { label?: string; disabled?: boolean } {
        const scope = root.closest('[role="dialog"],form,article,section') || root.parentElement || root;
        const buttons = Array.from(scope.querySelectorAll('button,[role="button"]')).filter(isVisible);
        const positive = /(发帖|发布|发送|评论|回复|post|tweet|send|comment|reply)/i;
        const negative = /(添加|add|gif|emoji|media|图片|照片|投票|schedule|日程|draft|草稿)/i;
        for (const button of buttons) {
          const label = buttonText(button);
          if (!label || !positive.test(label) || negative.test(label)) continue;
          const style = window.getComputedStyle(button as HTMLElement);
          const disabled = (button instanceof HTMLButtonElement && button.disabled)
            || button.getAttribute('aria-disabled') === 'true'
            || button.getAttribute('disabled') != null
            || style.pointerEvents === 'none';
          return { label, disabled };
        }
        return {};
      }

      const placeholder_visible = !el
        ? false
        : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? false
          : isPlaceholderVisible(el);

      const submit = !el || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? {}
        : submitButtonState(el);

      return {
        target_kind,
        actual_text,
        placeholder_visible,
        submit_button_label: submit.label,
        submit_button_disabled: submit.disabled,
      };
    },
    [refId ?? null],
  );
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

function submitDisabledError(status: EditableStatus): string | undefined {
  if (!isRichTextTarget(status.target_kind) || !status.submit_button_label || !status.submit_button_disabled) return undefined;
  return `输入后“${status.submit_button_label}”按钮仍不可用，页面没有接受这次富文本输入`;
}

function typedTextError(status: EditableStatus, expected: string): string | undefined {
  if (normalizedEquals(status.actual_text, expected)) return undefined;
  const repeats = repeatedExpectedCount(status.actual_text, expected);
  if (repeats > 1) return `输入内容重复了 ${repeats} 次，已阻止继续提交`;
  return '目标编辑器内容与要输入的文本不一致';
}

async function clearFocusedEditableWithKeyboard(tabId: number, tried: string[]) {
  tried.push('cdp_select_all_clear');
  const modifier = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? 4 : 2;
  await cdp.pressKey(tabId, 'a', undefined, modifier);
  await cdp.pressKey(tabId, 'Backspace');
  await new Promise((r) => setTimeout(r, 120));
}

async function typeText(sessionId: string, args: { ref_id?: string; text: string; submit?: boolean }) {
  const tabId = await getCurrentTab(sessionId);
  const tried: string[] = [];
  let result: PageTypeAttempt | null = null;

  if (args.ref_id) {
    const { x, y } = await refIdToCoords(tabId, args.ref_id);
    await chrome.tabs.sendMessage(tabId, { type: 'UPDATE_PHANTOM_CURSOR', x, y }).catch(() => {});
    await new Promise((r) => setTimeout(r, 220));
    await cdp.mouseClick(tabId, x, y);
  }

  result = await pageTypeAttempt(tabId, args.ref_id, args.text);
  tried.push(...result.tried);

  if (!result.ok) {
    if (isRichTextTarget(result.target_kind)) {
      await clearFocusedEditableWithKeyboard(tabId, tried);
    }
    tried.push('cdp_insertText');
    await cdp.insertText(tabId, args.text);
    await new Promise((r) => setTimeout(r, 150));
    const actual = await readEditableText(tabId, args.ref_id);
    const typedError = typedTextError(actual, args.text);
    result = {
      ok: !typedError && !actual.placeholder_visible && !submitDisabledError(actual),
      strategy: 'cdp_insertText',
      target_kind: actual.target_kind,
      actual_text: actual.actual_text,
      tried,
      error: submitDisabledError(actual) || typedError || result.error,
    };
  }

  // Trusted-event 二级验证：即使 actual_text 包含期望文字，如果 placeholder 还在显示，
  // 说明 React 受控编辑器的 internal state 没真正接受输入（DOM 有字但状态层为空），
  // 提交按钮会保持 disabled。这里逐字 dispatchKeyEvent 重试，每个按键都是 trusted。
  if (result.ok) {
    const verify = await readEditableText(tabId, args.ref_id);
    if (verify.placeholder_visible) {
      tried.push('placeholder_still_visible_after_' + result.strategy);
      // 用 CDP 键盘逐字输入，给编辑器真实的键盘事件。
      tried.push('cdp_key_events_per_char');
      await clearFocusedEditableWithKeyboard(tabId, tried);
      await cdp.typeTextByKeyEvents(tabId, args.text);
      await new Promise((r) => setTimeout(r, 200));
      const after = await readEditableText(tabId, args.ref_id);
      const typedError = typedTextError(after, args.text);
      result = {
        ok: !typedError && !after.placeholder_visible && !submitDisabledError(after),
        strategy: 'cdp_key_events_per_char',
        target_kind: after.target_kind,
        actual_text: after.actual_text,
        tried,
        error: submitDisabledError(after) || typedError || (after.placeholder_visible
          ? '编辑器 placeholder 仍可见，internal state 未接受输入（React 受控编辑器拒绝了所有策略）'
          : undefined),
      };
    }
  }

  if (result.ok) {
    const status = await readEditableText(tabId, args.ref_id);
    const blocked = submitDisabledError(status);
    if (blocked) {
      tried.push('submit_button_disabled_after_' + result.strategy);
      // 某些富文本编辑器需要一次真实键盘编辑才会重新计算提交状态。
      await cdp.typeTextByKeyEvents(tabId, ' ');
      await cdp.pressKey(tabId, 'Backspace');
      await new Promise((r) => setTimeout(r, 200));
      const after = await readEditableText(tabId, args.ref_id);
      const typedError = typedTextError(after, args.text);
      result = {
        ok: !typedError && !after.placeholder_visible && !submitDisabledError(after),
        strategy: result.strategy + '+activation_nudge',
        target_kind: after.target_kind,
        actual_text: after.actual_text,
        tried,
        error: submitDisabledError(after) || typedError || blocked,
      };
    }
  }

  if (!result.ok) {
    const preview = (result.actual_text || '').slice(0, 160);
    throw new Error(
      `输入失败：${result.error || '目标编辑器没有包含要输入的文本'}。target=${result.target_kind}; tried=${tried.join(', ')}; actual="${preview}"`,
    );
  }

  if (args.submit) await cdp.pressKey(tabId, 'Enter');

  return {
    typed_chars: args.text.length,
    submitted: !!args.submit,
    verified: true,
    strategy: result.strategy,
    target_kind: result.target_kind,
    actual_text_preview: (result.actual_text || '').slice(0, 160),
  } satisfies TypeResult;
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
