// Hermes accessibility tree generator — original implementation for MIT release.
// Produces a structured text representation of the page DOM for agent consumption.

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

// Console buffer hook — captures console output in the isolated world for debugging.
(function installConsoleHook() {
  const w = window as any;
  if (w.__hermesConsoleHooked) return;
  w.__hermesConsoleHooked = true;
  w.__hermesConsoleBuffer = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const level of methods) {
    const original = (console as any)[level].bind(console);
    (console as any)[level] = (...args: unknown[]) => {
      try {
        w.__hermesConsoleBuffer.push({
          level,
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
      } catch { /* best-effort */ }
      original(...args);
    };
  }
})();

(function buildA11yTree() {
  if (window.__hermesElementMap) return;

  window.__hermesElementMap = {};
  window.__hermesRefCounter = 0;

  // ---- constants ----

  const AUTOFILL_SENSITIVE = new Set([
    'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  ]);

  const TAG_TO_IMPLICIT_ROLE: Record<string, string> = {
    a: 'link',          button: 'button',
    h1: 'heading',      h2: 'heading',      h3: 'heading',
    h4: 'heading',      h5: 'heading',      h6: 'heading',
    img: 'image',       nav: 'navigation',   main: 'main',
    header: 'banner',   footer: 'contentinfo',
    section: 'region',  article: 'article',  aside: 'complementary',
    form: 'form',       table: 'table',
    ul: 'list',         ol: 'list',          li: 'listitem',
    label: 'label',     select: 'combobox',  textarea: 'textbox',
  };

  const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript']);

  // ---- helpers ----

  function classifyRole(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();

    const tag = el.tagName.toLowerCase();

    if (tag === 'input') {
      const inputType = (el.getAttribute('type') || 'text').toLowerCase();
      if (inputType === 'submit' || inputType === 'button' || inputType === 'file') return 'button';
      if (inputType === 'checkbox') return 'checkbox';
      if (inputType === 'radio') return 'radio';
      return 'textbox';
    }

    const cedit = el.getAttribute('contenteditable');
    if (cedit === 'true' || cedit === 'plaintext-only') return 'textbox';

    return TAG_TO_IMPLICIT_ROLE[tag] || 'generic';
  }

  function holdsSensitiveData(el: Element): boolean {
    const inputType = (el.getAttribute('type') || '').toLowerCase();
    if (inputType === 'password' || inputType === 'hidden') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return [...AUTOFILL_SENSITIVE].some((k) => ac.includes(k));
  }

  function immediateText(el: Element): string {
    let out = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
    }
    return out.trim();
  }

  function fullText(el: Element): string {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extractLabel(el: Element): string {
    const tag = el.tagName.toLowerCase();

    // <select> — show selected option text
    if (tag === 'select') {
      if (holdsSensitiveData(el)) {
        const aria = el.getAttribute('aria-label')?.trim();
        const title = el.getAttribute('title')?.trim();
        const fromFor = el.id ? immediateText(document.querySelector(`label[for="${CSS.escape(el.id)}"]`) ?? document.createElement('span')) : '';
        return aria || title || fromFor || '[value redacted]';
      }
      const sel = el as HTMLSelectElement;
      const chosen = sel.querySelector('option[selected]') || sel.options[sel.selectedIndex];
      return chosen?.textContent?.trim() || '';
    }

    // Explicit attributes
    const attrLabel =
      el.getAttribute('aria-label')?.trim() ||
      el.getAttribute('placeholder')?.trim() ||
      el.getAttribute('title')?.trim() ||
      el.getAttribute('alt')?.trim();
    if (attrLabel) return attrLabel;

    // <label for="..."> association
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) {
        const txt = fullText(forLabel);
        if (txt) return txt;
      }
    }

    // <input> — show current value if short and non-sensitive
    if (tag === 'input') {
      const inp = el as HTMLInputElement;
      const t = (inp.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' && inp.value) return inp.value.trim();
      if (holdsSensitiveData(el)) return inp.value ? '[value redacted]' : '';
      if (inp.value && inp.value.length < 50) return inp.value.trim();
    }

    // <textarea>
    if (tag === 'textarea') {
      if (holdsSensitiveData(el)) return (el as HTMLTextAreaElement).value ? '[value redacted]' : '';
    }

    // Interactive controls — use full descendant text
    if (
      tag === 'button' || tag === 'a' || tag === 'summary' ||
      el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link'
    ) {
      const t = fullText(el);
      if (t) return t;
      const svgTitle = el.querySelector('svg title,title')?.textContent?.trim();
      if (svgTitle) return svgTitle;
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      return (el.textContent || '').trim().substring(0, 100);
    }

    // Images don't have a useful label beyond alt (already checked above)
    if (tag === 'img') return '';

    const direct = immediateText(el);
    if (direct.length >= 3) return direct.length > 100 ? direct.substring(0, 100) + '…' : direct;
    return '';
  }

  function isInViewport(el: Element): boolean {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const he = el as HTMLElement;
    return he.offsetWidth > 0 && he.offsetHeight > 0;
  }

  function canInteract(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag)) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
    const role = el.getAttribute('role');
    if (role && [
      'button',
      'link',
      'textbox',
      'checkbox',
      'radio',
      'combobox',
      'switch',
      'menuitem',
      'option',
      'tab',
    ].includes(role.trim().toLowerCase())) return true;
    const editable = el.getAttribute('contenteditable');
    if (editable === 'true' || editable === 'plaintext-only') return true;
    try {
      const s = window.getComputedStyle(el as HTMLElement);
      if (s.cursor === 'pointer' && !!el.querySelector('svg,path')) return true;
    } catch { /* best-effort */ }
    return false;
  }

  function hasSemanticMeaning(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    return /^(h[1-6]|nav|main|header|footer|section|article|aside)$/.test(tag) || el.hasAttribute('role');
  }

  function elementIsWorthShowing(el: Element, filter: string, isSubtreeWalk: boolean): boolean {
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) return false;
    if (filter !== 'all' && el.getAttribute('aria-hidden') === 'true') return false;
    if (filter !== 'all' && !isInViewport(el)) return false;
    // Viewport culling: skip elements outside visible area (unless walking a specific subtree)
    if (filter !== 'all' && !isSubtreeWalk) {
      const r = el.getBoundingClientRect();
      if (!(r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0)) return false;
    }
    if (filter === 'interactive') return canInteract(el);
    if (canInteract(el) || hasSemanticMeaning(el)) return true;
    if (extractLabel(el).length > 0) return true;
    const role = classifyRole(el);
    return role !== 'generic' && role !== 'image';
  }

  function getOrCreateRef(el: Element): string {
    for (const key in window.__hermesElementMap) {
      if (window.__hermesElementMap[key].deref() === el) return key;
    }
    const newRef = 'ref_' + (++window.__hermesRefCounter);
    window.__hermesElementMap[newRef] = new WeakRef(el);
    return newRef;
  }

  // ---- main tree builder ----

  window.__hermesGenerateA11yTree = function (filter, maxDepth, maxChars, refId) {
    try {
      const outputLines: string[] = [];
      const depthLimit = maxDepth ?? 15;
      const mode = filter ?? 'all';
      const subtreeOnly = refId != null;

      function walkNode(el: Element, indent: number) {
        if (indent > depthLimit || !el || !el.tagName) return;

        const visible = elementIsWorthShowing(el, mode, subtreeOnly);
        // When walking a subtree, always include the root element even if it normally wouldn't be shown
        const includeThis = visible || (subtreeOnly && indent === 0);

        if (includeThis) {
          const role = classifyRole(el);
          let label = extractLabel(el);
          const ref = getOrCreateRef(el);

          let line = ' '.repeat(indent) + role;
          if (label) {
            label = label.replace(/\s+/g, ' ').substring(0, 100);
            line += ' "' + label.replace(/"/g, '\\"') + '"';
          }
          line += ' [' + ref + ']';

          const href = el.getAttribute('href');
          if (href) line += ' href="' + href + '"';
          const typeAttr = el.getAttribute('type');
          if (typeAttr) line += ' type="' + typeAttr + '"';
          const placeholder = el.getAttribute('placeholder');
          if (placeholder) line += ' placeholder="' + placeholder + '"';

          outputLines.push(line);

          // Inline <select> options
          if (el.tagName.toLowerCase() === 'select' && !holdsSensitiveData(el)) {
            for (const opt of Array.from((el as HTMLSelectElement).options)) {
              let optLine = ' '.repeat(indent + 1) + 'option';
              const optText = opt.textContent?.trim() || '';
              if (optText) optLine += ' "' + optText.replace(/"/g, '\\"').substring(0, 100) + '"';
              if (opt.selected) optLine += ' (selected)';
              if (opt.value && opt.value !== optText) optLine += ' value="' + opt.value.replace(/"/g, '\\"') + '"';
              outputLines.push(optLine);
            }
          }
        }

        // Don't recurse into <select> (options already rendered inline)
        if (el.tagName.toLowerCase() === 'select' && !holdsSensitiveData(el)) return;

        if (el.children && indent < depthLimit) {
          const nextIndent = includeThis ? indent + 1 : indent;
          for (const child of Array.from(el.children)) {
            walkNode(child, nextIndent);
          }
          const shadow = (el as HTMLElement).shadowRoot;
          if (shadow) {
            for (const child of Array.from(shadow.children)) {
              walkNode(child, nextIndent);
            }
          }
        }
      }

      // Resolve starting point
      let root: Element | null = document.body;
      if (refId) {
        const entry = window.__hermesElementMap[refId];
        if (!entry) {
          return {
            error: 'ref_id \'' + refId + '\' does not exist or was garbage collected',
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        }
        const el = entry.deref();
        if (!el) {
          return {
            error: 'ref_id \'' + refId + '\' has been removed from the DOM',
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        }
        root = el;
      }

      if (root) walkNode(root, 0);

      // Garbage-collect dead WeakRefs
      for (const key in window.__hermesElementMap) {
        if (!window.__hermesElementMap[key].deref()) delete window.__hermesElementMap[key];
      }

      const result = outputLines.join('\n');
      if (maxChars != null && result.length > maxChars) {
        return {
          error: 'Output exceeds ' + maxChars + ' characters (actual ' + result.length + '); reduce depth or use ref_id to narrow scope',
          pageContent: '',
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      }

      return { pageContent: result, viewport: { width: window.innerWidth, height: window.innerHeight } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      throw new Error('Failed to build accessibility tree: ' + msg);
    }
  };
})();

export {};
