// Hermes agent visual indicators — original implementation for MIT release.
// Manages glow border, floating stop button, phantom cursor, and static status bar.

(function () {
  if ((window as any).__hermesIndicatorInstalled) return;
  (window as any).__hermesIndicatorInstalled = true;

  // ---- configuration ----

  const BRAND = '#D97757'; // Hermes accent color (terracotta)
  const TOPMOST_Z = 2147483647;
  const GLOW_Z = TOPMOST_Z - 1;

  // ---- internal state ----

  let glowOverlay: HTMLDivElement | null = null;
  let stopWrapper: HTMLDivElement | null = null;
  let cursorEl: HTMLDivElement | null = null;
  let statusBar: HTMLDivElement | null = null;
  let heartbeatInterval: number | null = null;

  let indicatorsVisible = false;
  let statusBarVisible = false;
  let preHideWasActive = false;

  let cursorPrevX: number | null = null;
  let cursorPrevY: number | null = null;

  // ---- style injection ----

  function injectStylesOnce() {
    if (document.getElementById('hms-indicator-css')) return;
    const s = document.createElement('style');
    s.id = 'hms-indicator-css';
    s.textContent = [
      '@keyframes hms-glow-pulse {',
      '  0%   { box-shadow: inset 0 0 10px rgba(217,119,87,0.5), inset 0 0 20px rgba(217,119,87,0.3), inset 0 0 30px rgba(217,119,87,0.1); }',
      '  50%  { box-shadow: inset 0 0 15px rgba(217,119,87,0.7), inset 0 0 25px rgba(217,119,87,0.5), inset 0 0 35px rgba(217,119,87,0.2); }',
      '  100% { box-shadow: inset 0 0 10px rgba(217,119,87,0.5), inset 0 0 20px rgba(217,119,87,0.3), inset 0 0 30px rgba(217,119,87,0.1); }',
      '}',
      '@keyframes hms-status-dot {',
      '  0%,100% { opacity: 1; transform: scale(1); }',
      '  50% { opacity: 0.5; transform: scale(1.3); }',
      '}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ---- glow overlay ----

  function getOrCreateGlow(): HTMLDivElement {
    if (glowOverlay) return glowOverlay;
    const div = document.createElement('div');
    div.id = 'hms-glow-overlay';
    div.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;' +
      'z-index:' + GLOW_Z + ';opacity:0;transition:opacity 0.3s ease-in-out;' +
      'animation:hms-glow-pulse 2s ease-in-out infinite;' +
      'box-shadow:inset 0 0 10px rgba(217,119,87,0.5),inset 0 0 20px rgba(217,119,87,0.3),inset 0 0 30px rgba(217,119,87,0.1);';
    document.body.appendChild(div);
    glowOverlay = div;
    return div;
  }

  function removeGlow() {
    if (glowOverlay?.parentNode) glowOverlay.parentNode.removeChild(glowOverlay);
    glowOverlay = null;
  }

  // ---- stop button ----

  function getOrCreateStopButton(): HTMLDivElement {
    if (stopWrapper) return stopWrapper;
    const wrap = document.createElement('div');
    wrap.id = 'hms-stop-wrapper';
    wrap.style.cssText =
      'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
      'display:flex;justify-content:center;align-items:center;' +
      'pointer-events:none;z-index:' + TOPMOST_Z + ';';

    const btn = document.createElement('button');
    btn.id = 'hms-stop-btn';

    // Build SVG stop icon inline
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.style.cssText = 'margin-right:10px;vertical-align:middle;';
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z');
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    btn.appendChild(svg);
    btn.appendChild(document.createTextNode('Stop Hermes'));

    btn.style.cssText =
      'position:relative;transform:translateY(100px);padding:10px 16px;' +
      'background:#FAF9F5;color:#141413;border:0.5px solid rgba(31,30,29,0.4);' +
      'border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;' +
      'justify-content:center;box-shadow:0 20px 40px rgba(217,119,87,0.24),0 4px 14px rgba(217,119,87,0.24);' +
      'transition:all 0.3s cubic-bezier(0.4,0,0.2,1);opacity:0;user-select:none;' +
      'pointer-events:auto;white-space:nowrap;';

    btn.addEventListener('mouseenter', () => {
      if (indicatorsVisible) btn.style.background = '#F5F4F0';
    });
    btn.addEventListener('mouseleave', () => {
      if (indicatorsVisible) btn.style.background = '#FAF9F5';
    });
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_AGENT', fromTabId: 'CURRENT_TAB' }).catch(() => {});
    });

    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    stopWrapper = wrap;
    return wrap;
  }

  function removeStopButton() {
    if (stopWrapper?.parentNode) stopWrapper.parentNode.removeChild(stopWrapper);
    stopWrapper = null;
  }

  // ---- phantom cursor ----

  function moveCursorTo(x: number, y: number) {
    if (!cursorEl) {
      const wrap = document.createElement('div');
      wrap.id = 'hms-phantom-cursor';
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.cssText =
        'position:fixed;top:0;left:0;pointer-events:none;z-index:' + GLOW_Z + ';' +
        'transform:translate3d(' + x + 'px,' + y + 'px,0);' +
        'transition:transform 180ms cubic-bezier(0.2,0,0,1);will-change:transform;';

      const svgNS = 'http://www.w3.org/2000/svg';

      function buildPath(attrs: Record<string, string>): SVGPathElement {
        const p = document.createElementNS(svgNS, 'path');
        p.setAttribute('d', 'M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z');
        for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
        return p;
      }

      function buildCursorSvg(id: string, outline: string, fillColor: string, extraStyle: string): SVGSVGElement {
        const s = document.createElementNS(svgNS, 'svg');
        s.id = id;
        s.setAttribute('width', '20');
        s.setAttribute('height', '26');
        s.setAttribute('viewBox', '0 0 20 26');
        s.style.cssText = 'position:absolute;top:0;left:0;overflow:visible;' + extraStyle;
        s.appendChild(buildPath({ stroke: outline, 'stroke-width': '3', 'stroke-linejoin': 'round', fill: outline }));
        s.appendChild(buildPath({ fill: fillColor }));
        return s;
      }

      wrap.appendChild(buildCursorSvg('hms-cursor-outline', 'white', '#111', ''));
      wrap.appendChild(buildCursorSvg(
        'hms-cursor-accent', BRAND, '#FAF9F5',
        'filter:drop-shadow(0 0 4px rgba(217,119,87,0.9)) drop-shadow(0 0 10px rgba(217,119,87,0.45));',
      ));

      document.body.appendChild(wrap);
      cursorEl = wrap;
      cursorPrevX = x;
      cursorPrevY = y;
      return Promise.resolve();
    }

    const el = cursorEl;
    const moved = cursorPrevX !== x || cursorPrevY !== y;
    el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    cursorPrevX = x;
    cursorPrevY = y;

    if (!moved || document.hidden) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        el.removeEventListener('transitionend', finish);
        resolve();
      };
      el.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 220);
    });
  }

  function destroyCursor() {
    if (cursorEl?.parentNode) cursorEl.parentNode.removeChild(cursorEl);
    cursorEl = null;
  }

  // ---- static status bar ----

  function getOrCreateStatusBar(): HTMLDivElement {
    if (statusBar) return statusBar;

    const bar = document.createElement('div');
    bar.id = 'hms-status-bar';

    const dot = document.createElement('span');
    dot.style.cssText =
      'width:6px;height:6px;border-radius:50%;background:' + BRAND + ';' +
      'display:inline-block;animation:hms-status-dot 2s ease-in-out infinite;';

    const label = document.createElement('span');
    label.style.cssText = 'color:#141413;font-size:12px;';
    label.textContent = 'Hermes in this tab group';

    const left = document.createElement('span');
    left.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
    left.appendChild(dot);
    left.appendChild(label);

    const chatBtn = makeIconBtn('hms-status-chat', 'Open sidebar',
      'M10 2.5C14.1421 2.5 17.5 5.85786 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5H3C2.79779 17.5 2.61549 17.3782 2.53809 17.1914C2.4607 17.0046 2.50349 16.7895 2.64648 16.6465L4.35547 14.9365C3.20124 13.6175 2.5 11.8906 2.5 10C2.5 5.85786 5.85786 2.5 10 2.5Z');
    chatBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STATIC_OPEN_SIDEPANEL' }).catch(() => {});
    });

    const closeBtn = makeIconBtn('hms-status-close', 'Hide',
      'M15.1464 4.14642C15.3417 3.95121 15.6582 3.95118 15.8534 4.14642C16.0486 4.34168 16.0486 4.65822 15.8534 4.85346L10.7069 9.99997L15.8534 15.1465C16.0486 15.3417 16.0486 15.6583 15.8534 15.8535C15.6826 16.0244 15.4186 16.0461 15.2245 15.918L15.1464 15.8535L9.99989 10.707L4.85338 15.8535C4.65813 16.0486 4.34155 16.0486 4.14634 15.8535C3.95115 15.6583 3.95129 15.3418 4.14634 15.1465L9.29286 9.99997L4.14634 4.85346C3.95129 4.65818 3.95115 4.34162 4.14634 4.14642C4.34154 3.95128 4.65812 3.95138 4.85338 4.14642L9.99989 9.29294L15.1464 4.14642Z');
    closeBtn.addEventListener('click', () => dismissStatusBar());

    bar.appendChild(left);
    bar.appendChild(chatBtn);
    bar.appendChild(closeBtn);

    bar.style.cssText =
      'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);' +
      'display:inline-flex;align-items:center;gap:4px;' +
      'padding:4px 4px 4px 12px;background:#FAF9F5;' +
      'border:0.5px solid rgba(31,30,29,0.30);border-radius:14px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.10);z-index:' + GLOW_Z + ';' +
      'pointer-events:auto;user-select:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'opacity:0;transition:opacity 0.3s ease-in-out;';

    document.body.appendChild(bar);
    requestAnimationFrame(() => { bar.style.opacity = '1'; });
    statusBar = bar;
    return bar;
  }

  function makeIconBtn(id: string, title: string, pathD: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id = id;
    btn.title = title;
    btn.style.cssText =
      'background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;' +
      'display:inline-flex;align-items:center;justify-content:center;';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 20 20');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', '#141413');
    svg.appendChild(path);
    btn.appendChild(svg);
    return btn;
  }

  function removeStatusBar() {
    if (statusBar?.parentNode) statusBar.parentNode.removeChild(statusBar);
    statusBar = null;
  }

  // ---- show / hide indicators ----

  function showIndicators() {
    if (indicatorsVisible) return;
    indicatorsVisible = true;
    injectStylesOnce();
    const glow = getOrCreateGlow();
    const stop = getOrCreateStopButton();
    requestAnimationFrame(() => {
      glow.style.opacity = '1';
      const btn = stop.querySelector('button') as HTMLButtonElement | null;
      if (btn) {
        btn.style.transform = 'translateY(0)';
        btn.style.opacity = '1';
      }
    });
  }

  function hideIndicators() {
    if (!indicatorsVisible) return;
    indicatorsVisible = false;
    if (glowOverlay) glowOverlay.style.opacity = '0';
    if (stopWrapper) {
      const btn = stopWrapper.querySelector('button') as HTMLButtonElement | null;
      if (btn) {
        btn.style.transform = 'translateY(100px)';
        btn.style.opacity = '0';
      }
    }
    setTimeout(() => {
      if (indicatorsVisible) return; // re-shown in the meantime
      removeGlow();
      removeStopButton();
      destroyCursor();
    }, 320);
  }

  // ---- tool-time hide (prevent CDP screenshots from capturing indicators) ----

  function hideForToolUse() {
    preHideWasActive = indicatorsVisible;
    if (glowOverlay) glowOverlay.style.display = 'none';
    if (stopWrapper) stopWrapper.style.display = 'none';
    if (cursorEl) cursorEl.style.display = 'none';
  }

  function showAfterToolUse() {
    if (preHideWasActive) {
      if (glowOverlay) glowOverlay.style.display = '';
      if (stopWrapper) stopWrapper.style.display = '';
      if (cursorEl) cursorEl.style.display = '';
    }
    preHideWasActive = false;
  }

  // ---- static status bar lifecycle ----

  function showStatusBar() {
    if (statusBarVisible) return;
    statusBarVisible = true;
    getOrCreateStatusBar();
    startHeartbeat();
  }

  function dismissStatusBar() {
    if (!statusBarVisible) return;
    statusBarVisible = false;
    stopHeartbeat();
    if (statusBar) {
      statusBar.style.opacity = '0';
      setTimeout(() => {
        removeStatusBar();
      }, 320);
    }
  }

  function startHeartbeat() {
    if (heartbeatInterval != null) clearInterval(heartbeatInterval);
    heartbeatInterval = window.setInterval(async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'STATIC_INDICATOR_HEARTBEAT' });
        if (!resp?.alive) dismissStatusBar();
      } catch {
        dismissStatusBar();
      }
    }, 5000);
  }

  function stopHeartbeat() {
    if (heartbeatInterval != null) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  // ---- message handler ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'SHOW_AGENT_INDICATORS':
        showIndicators();
        sendResponse({ ok: true });
        break;
      case 'HIDE_AGENT_INDICATORS':
        hideIndicators();
        sendResponse({ ok: true });
        break;
      case 'UPDATE_PHANTOM_CURSOR':
        moveCursorTo(msg.x, msg.y).then(() => sendResponse({ ok: true }));
        return true; // async response
      case 'HIDE_FOR_TOOL_USE':
        hideForToolUse();
        sendResponse({ ok: true });
        break;
      case 'SHOW_AFTER_TOOL_USE':
        showAfterToolUse();
        sendResponse({ ok: true });
        break;
      case 'SHOW_STATIC_INDICATOR':
        showStatusBar();
        sendResponse({ ok: true });
        break;
      case 'HIDE_STATIC_INDICATOR':
        dismissStatusBar();
        sendResponse({ ok: true });
        break;
    }
    return false;
  });

  // ---- cleanup on unload ----

  window.addEventListener('beforeunload', () => {
    hideIndicators();
    destroyCursor();
  });
})();

export {};
