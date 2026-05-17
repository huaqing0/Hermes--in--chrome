// Hermes 无障碍树生成器
// fork 自 Claude in Chrome 1.0.70 的 accessibility-tree.js
// 改名：__claudeElementMap → __hermesElementMap，__generateAccessibilityTree → __hermesGenerateA11yTree

declare global {
  interface Window {
    __hermesElementMap: Record<string, WeakRef<Element>>;
    __hermesRefCounter: number;
    __hermesGenerateA11yTree: (
      filter?: 'all' | 'interactive',
      maxDepth?: number,
      maxChars?: number | null,
      refId?: string | null,
    ) => A11yTreeResult;
  }
}

interface A11yTreeResult {
  pageContent: string;
  viewport: { width: number; height: number };
  error?: string;
}

// 顺便注入 console hook（不依赖 a11y-tree 单独检查，独立 IIFE）
(function () {
  const w = window as any;
  if (w.__hermesConsoleHooked) return;
  w.__hermesConsoleHooked = true;
  w.__hermesConsoleBuffer = [];
  const orig: Record<string, (...a: unknown[]) => void> = {};
  for (const lvl of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    orig[lvl] = (console as any)[lvl].bind(console);
    (console as any)[lvl] = (...args: unknown[]) => {
      try {
        w.__hermesConsoleBuffer.push({
          level: lvl,
          time: Date.now(),
          message: args
            .map((a) => {
              try {
                return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a);
              } catch {
                return String(a);
              }
            })
            .join(' ')
            .slice(0, 500),
        });
        if (w.__hermesConsoleBuffer.length > 200) w.__hermesConsoleBuffer.shift();
      } catch {}
      orig[lvl](...args);
    };
  }
})();

(function () {
  if (window.__hermesElementMap) return; // 已注入

  window.__hermesElementMap = window.__hermesElementMap || {};
  window.__hermesRefCounter = window.__hermesRefCounter || 0;

  const SENSITIVE_AUTOCOMPLETE = [
    'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  ];

  const ROLE_BY_TAG: Record<string, string> = {
    a: 'link', button: 'button',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'image', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    section: 'region', article: 'article', aside: 'complementary', form: 'form',
    table: 'table', ul: 'list', ol: 'list', li: 'listitem', label: 'label',
    select: 'combobox', textarea: 'textbox',
  };

  function inferRole(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'file') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return ROLE_BY_TAG[tag] || 'generic';
  }

  function isSensitive(el: Element): boolean {
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'password' || t === 'hidden') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return SENSITIVE_AUTOCOMPLETE.some((k) => ac.includes(k));
  }

  function textContent(el: Element): string {
    let out = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
    }
    return out.trim();
  }

  function descendantTextContent(el: Element): string {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getLabel(el: Element): string {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      if (isSensitive(el)) {
        return el.getAttribute('aria-label')?.trim()
          || el.getAttribute('title')?.trim()
          || (el.id ? textContent(document.querySelector(`label[for="${el.id}"]`) ?? document.createElement('span')) : '')
          || '[value redacted]';
      }
      const sel = el as HTMLSelectElement;
      const opt = sel.querySelector('option[selected]') || sel.options[sel.selectedIndex];
      return opt?.textContent?.trim() || '';
    }
    const label =
      el.getAttribute('aria-label')?.trim() ||
      el.getAttribute('placeholder')?.trim() ||
      el.getAttribute('title')?.trim() ||
      el.getAttribute('alt')?.trim();
    if (label) return label;
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) {
        const t = descendantTextContent(lbl);
        if (t) return t;
      }
    }
    if (tag === 'input') {
      const inp = el as HTMLInputElement;
      const t = (inp.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' && inp.value) return inp.value.trim();
      if (isSensitive(el)) return inp.value ? '[value redacted]' : '';
      if (inp.value && inp.value.length < 50) return inp.value.trim();
    }
    if (tag === 'textarea') {
      if (isSensitive(el)) return (el as HTMLTextAreaElement).value ? '[value redacted]' : '';
    }
    if (['button', 'a', 'summary'].includes(tag) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') {
      const t = descendantTextContent(el);
      if (t) return t;
    }
    if (/^h[1-6]$/.test(tag)) {
      return (el.textContent || '').trim().substring(0, 100);
    }
    if (tag === 'img') return '';
    const t = textContent(el);
    if (t.length >= 3) return t.length > 100 ? t.substring(0, 100) + '...' : t;
    return '';
  }

  function isVisible(el: Element): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const he = el as HTMLElement;
    return he.offsetWidth > 0 && he.offsetHeight > 0;
  }

  function isInteractive(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('tabindex')) return true;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function isSemantic(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    return /^(h[1-6]|nav|main|header|footer|section|article|aside)$/.test(tag) || el.hasAttribute('role');
  }

  function shouldInclude(el: Element, opts: { filter: string; refId: string | null }): boolean {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'meta', 'link', 'title', 'noscript'].includes(tag)) return false;
    if (opts.filter !== 'all' && el.getAttribute('aria-hidden') === 'true') return false;
    if (opts.filter !== 'all' && !isVisible(el)) return false;
    if (opts.filter !== 'all' && !opts.refId) {
      const r = el.getBoundingClientRect();
      if (!(r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0)) return false;
    }
    if (opts.filter === 'interactive') return isInteractive(el);
    if (isInteractive(el) || isSemantic(el)) return true;
    if (getLabel(el).length > 0) return true;
    const role = inferRole(el);
    return role !== 'generic' && role !== 'image';
  }

  window.__hermesGenerateA11yTree = function (filter, maxDepth, maxChars, refId) {
    try {
      const lines: string[] = [];
      const depth = maxDepth ?? 15;
      const opts = { filter: filter ?? 'all', refId: refId ?? null };

      function findOrAssignRef(el: Element): string {
        for (const k in window.__hermesElementMap) {
          if (window.__hermesElementMap[k].deref() === el) return k;
        }
        const ref = 'ref_' + ++window.__hermesRefCounter;
        window.__hermesElementMap[ref] = new WeakRef(el);
        return ref;
      }

      function walk(el: Element, level: number) {
        if (level > depth || !el || !el.tagName) return;
        const include = shouldInclude(el, opts) || (opts.refId !== null && level === 0);
        if (include) {
          const role = inferRole(el);
          let label = getLabel(el);
          const ref = findOrAssignRef(el);
          let line = ' '.repeat(level) + role;
          if (label) {
            label = label.replace(/\s+/g, ' ').substring(0, 100);
            line += ` "${label.replace(/"/g, '\\"')}"`;
          }
          line += ` [${ref}]`;
          const href = el.getAttribute('href');
          if (href) line += ` href="${href}"`;
          const type = el.getAttribute('type');
          if (type) line += ` type="${type}"`;
          const ph = el.getAttribute('placeholder');
          if (ph) line += ` placeholder="${ph}"`;
          lines.push(line);
          if (el.tagName.toLowerCase() === 'select' && !isSensitive(el)) {
            for (const opt of Array.from((el as HTMLSelectElement).options)) {
              let oline = ' '.repeat(level + 1) + 'option';
              const t = opt.textContent?.trim() || '';
              if (t) oline += ` "${t.replace(/"/g, '\\"').substring(0, 100)}"`;
              if (opt.selected) oline += ' (selected)';
              if (opt.value && opt.value !== t) oline += ` value="${opt.value.replace(/"/g, '\\"')}"`;
              lines.push(oline);
            }
          }
        }
        if (el.tagName.toLowerCase() === 'select' && !isSensitive(el)) return;
        if (el.children && level < depth) {
          for (const child of Array.from(el.children)) {
            walk(child, include ? level + 1 : level);
          }
        }
      }

      let root: Element | null = document.body;
      if (refId) {
        const ref = window.__hermesElementMap[refId];
        if (!ref) {
          return {
            error: `ref_id '${refId}' 不存在或已 GC`,
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        }
        const node = ref.deref();
        if (!node) {
          return {
            error: `ref_id '${refId}' 已被移除`,
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        }
        root = node;
      }
      if (root) walk(root, 0);

      // 清理失效 WeakRef
      for (const k in window.__hermesElementMap) {
        if (!window.__hermesElementMap[k].deref()) delete window.__hermesElementMap[k];
      }

      const out = lines.join('\n');
      if (maxChars != null && out.length > maxChars) {
        return {
          error: `输出超过 ${maxChars} 字符 (实际 ${out.length})，请减小 depth 或用 ref_id 聚焦`,
          pageContent: '',
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      }
      return { pageContent: out, viewport: { width: window.innerWidth, height: window.innerHeight } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      throw new Error('生成 a11y 树失败: ' + msg);
    }
  };
})();

export {};
