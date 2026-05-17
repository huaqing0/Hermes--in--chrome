// Hermes 视觉指示器
// fork 自 Claude in Chrome 1.0.70 的 agent-visual-indicator.js
// 简化版：保留 Glow 边框 + 浮动 Stop 按钮 + 虚拟光标（去掉 audio keepalive 和静态指示器）

(function () {
  // 已经注入过就跳过
  if ((window as any).__hermesIndicatorInjected) return;
  (window as any).__hermesIndicatorInjected = true;

  const ACCENT = '#D97757';
  const Z_TOP = 2147483647;
  const Z_GLOW = 2147483646;

  let glowBorder: HTMLDivElement | null = null;
  let stopContainer: HTMLDivElement | null = null;
  let cursorContainer: HTMLDivElement | null = null;
  let staticBar: HTMLDivElement | null = null;
  let staticHeartbeatTimer: number | null = null;
  let active = false;
  let staticActive = false;
  let lastCursorX: number | null = null;
  let lastCursorY: number | null = null;
  let preHideActive = false;

  // === 注入动画样式（一次性）===
  function injectStyles() {
    if (document.getElementById('hermes-agent-styles')) return;
    const style = document.createElement('style');
    style.id = 'hermes-agent-styles';
    style.textContent = `
      @keyframes hermes-pulse {
        0%   { box-shadow: inset 0 0 10px rgba(217,119,87,0.5), inset 0 0 20px rgba(217,119,87,0.3), inset 0 0 30px rgba(217,119,87,0.1); }
        50%  { box-shadow: inset 0 0 15px rgba(217,119,87,0.7), inset 0 0 25px rgba(217,119,87,0.5), inset 0 0 35px rgba(217,119,87,0.2); }
        100% { box-shadow: inset 0 0 10px rgba(217,119,87,0.5), inset 0 0 20px rgba(217,119,87,0.3), inset 0 0 30px rgba(217,119,87,0.1); }
      }
    `;
    document.head.appendChild(style);
  }

  // === 创建 Glow 边框 ===
  function ensureGlow(): HTMLDivElement {
    if (glowBorder) return glowBorder;
    const el = document.createElement('div');
    el.id = 'hermes-agent-glow-border';
    el.style.cssText = `
      position: fixed; top:0; left:0; right:0; bottom:0;
      pointer-events: none;
      z-index: ${Z_GLOW};
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
      animation: hermes-pulse 2s ease-in-out infinite;
      box-shadow: inset 0 0 10px rgba(217,119,87,0.5), inset 0 0 20px rgba(217,119,87,0.3), inset 0 0 30px rgba(217,119,87,0.1);
    `;
    document.body.appendChild(el);
    glowBorder = el;
    return el;
  }

  // === 创建 Stop 按钮 ===
  function ensureStop(): HTMLDivElement {
    if (stopContainer) return stopContainer;
    const wrap = document.createElement('div');
    wrap.id = 'hermes-agent-stop-container';
    wrap.style.cssText = `
      position: fixed; bottom: 16px; left: 50%;
      transform: translateX(-50%);
      display: flex; justify-content: center; align-items: center;
      pointer-events: none;
      z-index: ${Z_TOP};
    `;
    const btn = document.createElement('button');
    btn.id = 'hermes-agent-stop-button';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" style="margin-right:10px;vertical-align:middle;">
        <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"></path>
      </svg>
      <span style="vertical-align:middle;">Stop Hermes</span>
    `;
    btn.style.cssText = `
      position: relative; transform: translateY(100px);
      padding: 10px 16px;
      background: #FAF9F5; color: #141413;
      border: 0.5px solid rgba(31,30,29,0.4);
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px; font-weight: 600;
      cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      box-shadow: 0 20px 40px rgba(217,119,87,0.24), 0 4px 14px rgba(217,119,87,0.24);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      opacity: 0;
      user-select: none;
      pointer-events: auto;
      white-space: nowrap;
    `;
    btn.addEventListener('mouseenter', () => {
      if (active) btn.style.background = '#F5F4F0';
    });
    btn.addEventListener('mouseleave', () => {
      if (active) btn.style.background = '#FAF9F5';
    });
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_AGENT', fromTabId: 'CURRENT_TAB' }).catch(() => {});
    });
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    stopContainer = wrap;
    return wrap;
  }

  // === 创建/更新虚拟光标 ===
  function ensureCursor(x: number, y: number) {
    if (!cursorContainer) {
      const wrap = document.createElement('div');
      wrap.id = 'hermes-phantom-cursor';
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.cssText = `
        position: fixed; top: 0; left: 0;
        pointer-events: none;
        z-index: ${Z_GLOW};
        transform: translate3d(${x}px, ${y}px, 0);
        transition: transform 180ms cubic-bezier(0.2, 0, 0, 1);
        will-change: transform;
      `;
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const makePath = (attrs: Record<string, string>) => {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', 'M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z');
        for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
        return p;
      };
      const makeSvg = (id: string, stroke: string, fill: string, extra: string) => {
        const s = document.createElementNS(SVG_NS, 'svg');
        s.id = id;
        s.setAttribute('width', '20');
        s.setAttribute('height', '26');
        s.setAttribute('viewBox', '0 0 20 26');
        s.style.cssText = `position:absolute; top:0; left:0; overflow:visible; ${extra}`;
        s.appendChild(makePath({ stroke, 'stroke-width': '3', 'stroke-linejoin': 'round', fill: stroke }));
        s.appendChild(makePath({ fill }));
        return s;
      };
      const plain = makeSvg('hermes-phantom-cursor-plain', 'white', '#111', '');
      const styled = makeSvg(
        'hermes-phantom-cursor-styled',
        ACCENT,
        '#FAF9F5',
        'filter: drop-shadow(0 0 4px rgba(217,119,87,0.9)) drop-shadow(0 0 10px rgba(217,119,87,0.45));',
      );
      wrap.appendChild(plain);
      wrap.appendChild(styled);
      document.body.appendChild(wrap);
      cursorContainer = wrap;
      lastCursorX = x;
      lastCursorY = y;
      return Promise.resolve();
    }
    const ref = cursorContainer;
    const same = lastCursorX === x && lastCursorY === y;
    ref.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    lastCursorX = x;
    lastCursorY = y;
    if (same || document.hidden) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        ref.removeEventListener('transitionend', fin);
        resolve();
      };
      ref.addEventListener('transitionend', fin, { once: true });
      setTimeout(fin, 220);
    });
  }

  function removeCursor() {
    if (cursorContainer && cursorContainer.parentNode) {
      cursorContainer.parentNode.removeChild(cursorContainer);
    }
    cursorContainer = null;
  }

  // === 显示/隐藏 ===
  function show() {
    if (active) return;
    active = true;
    injectStyles();
    const glow = ensureGlow();
    const stop = ensureStop();
    requestAnimationFrame(() => {
      glow.style.opacity = '1';
      const btn = stop.querySelector('button') as HTMLButtonElement | null;
      if (btn) {
        btn.style.transform = 'translateY(0)';
        btn.style.opacity = '1';
      }
    });
  }

  function hide() {
    if (!active) return;
    active = false;
    if (glowBorder) glowBorder.style.opacity = '0';
    if (stopContainer) {
      const btn = stopContainer.querySelector('button') as HTMLButtonElement | null;
      if (btn) {
        btn.style.transform = 'translateY(100px)';
        btn.style.opacity = '0';
      }
    }
    setTimeout(() => {
      if (active) return;
      if (glowBorder?.parentNode) {
        glowBorder.parentNode.removeChild(glowBorder);
        glowBorder = null;
      }
      if (stopContainer?.parentNode) {
        stopContainer.parentNode.removeChild(stopContainer);
        stopContainer = null;
      }
      removeCursor();
    }, 320);
  }

  // === 工具执行时临时隐藏（避免被 CDP 截图捕获）===
  function hideForTool() {
    preHideActive = active;
    if (glowBorder) glowBorder.style.display = 'none';
    if (stopContainer) stopContainer.style.display = 'none';
    if (cursorContainer) cursorContainer.style.display = 'none';
  }
  function showAfterTool() {
    if (preHideActive) {
      if (glowBorder) glowBorder.style.display = '';
      if (stopContainer) stopContainer.style.display = '';
      if (cursorContainer) cursorContainer.style.display = '';
    }
    preHideActive = false;
  }

  // === 静态指示器（任务结束后也常驻，提示用户这个 tab 在 Hermes Group 里）===
  function ensureStatic() {
    if (staticBar) return staticBar;
    const bar = document.createElement('div');
    bar.id = 'hermes-static-indicator';
    bar.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:6px;">
        <span style="width:6px;height:6px;border-radius:50%;background:${ACCENT};display:inline-block;animation:hermes-pulse-dot 2s ease-in-out infinite;"></span>
        <span style="color:#141413;font-size:12px;">Hermes 在这个 tab group</span>
      </span>
      <button id="hermes-static-chat" title="打开侧边栏" style="background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="#141413"><path d="M10 2.5C14.1421 2.5 17.5 5.85786 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5H3C2.79779 17.5 2.61549 17.3782 2.53809 17.1914C2.4607 17.0046 2.50349 16.7895 2.64648 16.6465L4.35547 14.9365C3.20124 13.6175 2.5 11.8906 2.5 10C2.5 5.85786 5.85786 2.5 10 2.5Z"/></svg>
      </button>
      <button id="hermes-static-close" title="隐藏" style="background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="#141413"><path d="M15.1464 4.14642C15.3417 3.95121 15.6582 3.95118 15.8534 4.14642C16.0486 4.34168 16.0486 4.65822 15.8534 4.85346L10.7069 9.99997L15.8534 15.1465C16.0486 15.3417 16.0486 15.6583 15.8534 15.8535C15.6826 16.0244 15.4186 16.0461 15.2245 15.918L15.1464 15.8535L9.99989 10.707L4.85338 15.8535C4.65813 16.0486 4.34155 16.0486 4.14634 15.8535C3.95115 15.6583 3.95129 15.3418 4.14634 15.1465L9.29286 9.99997L4.14634 4.85346C3.95129 4.65818 3.95115 4.34162 4.14634 4.14642C4.34154 3.95128 4.65812 3.95138 4.85338 4.14642L9.99989 9.29294L15.1464 4.14642Z"/></svg>
      </button>
    `;
    bar.style.cssText = `
      position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 4px 4px 12px;
      background: #FAF9F5;
      border: 0.5px solid rgba(31,30,29,0.30);
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.10);
      z-index: ${Z_GLOW};
      pointer-events: auto;
      user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
    `;
    // 注入小圆点 pulse 动画
    if (!document.getElementById('hermes-static-styles')) {
      const s = document.createElement('style');
      s.id = 'hermes-static-styles';
      s.textContent = `
        @keyframes hermes-pulse-dot {
          0%,100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.3); }
        }
      `;
      document.head.appendChild(s);
    }
    document.body.appendChild(bar);
    requestAnimationFrame(() => { bar.style.opacity = '1'; });
    bar.querySelector('#hermes-static-chat')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STATIC_OPEN_SIDEPANEL' }).catch(() => {});
    });
    bar.querySelector('#hermes-static-close')?.addEventListener('click', () => hideStatic());
    staticBar = bar;
    return bar;
  }
  function showStatic() {
    if (staticActive) return;
    staticActive = true;
    ensureStatic();
    // 心跳：每 5s 问 SW Hermes 还在 group 里吗，否则隐藏
    if (staticHeartbeatTimer != null) clearInterval(staticHeartbeatTimer);
    staticHeartbeatTimer = setInterval(async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'STATIC_INDICATOR_HEARTBEAT' });
        if (!resp?.alive) hideStatic();
      } catch {
        hideStatic();
      }
    }, 5_000) as unknown as number;
  }
  function hideStatic() {
    if (!staticActive) return;
    staticActive = false;
    if (staticHeartbeatTimer != null) {
      clearInterval(staticHeartbeatTimer);
      staticHeartbeatTimer = null;
    }
    if (staticBar) {
      staticBar.style.opacity = '0';
      setTimeout(() => {
        if (staticBar?.parentNode) staticBar.parentNode.removeChild(staticBar);
        staticBar = null;
      }, 320);
    }
  }

  // === 监听 SW 消息 ===
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'SHOW_AGENT_INDICATORS':
        show();
        sendResponse({ ok: true });
        break;
      case 'HIDE_AGENT_INDICATORS':
        hide();
        sendResponse({ ok: true });
        break;
      case 'UPDATE_PHANTOM_CURSOR':
        ensureCursor(msg.x, msg.y).then(() => sendResponse({ ok: true }));
        return true; // async
      case 'HIDE_FOR_TOOL_USE':
        hideForTool();
        sendResponse({ ok: true });
        break;
      case 'SHOW_AFTER_TOOL_USE':
        showAfterTool();
        sendResponse({ ok: true });
        break;
      case 'SHOW_STATIC_INDICATOR':
        showStatic();
        sendResponse({ ok: true });
        break;
      case 'HIDE_STATIC_INDICATOR':
        hideStatic();
        sendResponse({ ok: true });
        break;
    }
    return false;
  });

  // 页面卸载时清理
  window.addEventListener('beforeunload', () => {
    hide();
    removeCursor();
  });
})();

export {};
