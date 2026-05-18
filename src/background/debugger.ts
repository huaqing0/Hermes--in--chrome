// CDP (chrome.debugger) 封装：截图 / 鼠标 / 键盘 / 滚轮 / 对话框
// 设计原则：每个方法 attach 自动管理，调用方不感知 attach/detach 细节

const ATTACHED = new Set<number>();

async function ensureAttached(tabId: number): Promise<void> {
  if (ATTACHED.has(tabId)) return;
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message?.includes('already attached')) {
        return reject(err);
      }
      ATTACHED.add(tabId);
      // 监听对话框，自动 accept
      chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
      resolve();
    });
  });
}

async function send<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
  await ensureAttached(tabId);
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(err);
      resolve(result as T);
    });
  });
}

export async function detach(tabId: number) {
  if (!ATTACHED.has(tabId)) return;
  return new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      ATTACHED.delete(tabId);
      resolve();
    });
  });
}

// 自动清理
chrome.tabs.onRemoved.addListener((tabId) => ATTACHED.delete(tabId));
chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId) ATTACHED.delete(src.tabId);
});

// 自动处理 JS Dialog
chrome.debugger.onEvent.addListener((src, method) => {
  if (!src.tabId) return;
  if (method === 'Page.javascriptDialogOpening') {
    chrome.debugger
      .sendCommand({ tabId: src.tabId }, 'Page.handleJavaScriptDialog', { accept: true })
      .catch(() => {});
  }
});

// === 工具方法 ===

export async function screenshot(tabId: number, format: 'jpeg' | 'png' = 'jpeg') {
  const result = await send<{ data: string }>(tabId, 'Page.captureScreenshot', {
    format,
    quality: format === 'jpeg' ? 80 : undefined,
    fromSurface: true,
  });
  return { data: result.data, format, mimeType: `image/${format}` };
}

export async function mouseClick(tabId: number, x: number, y: number, button: 'left' | 'right' = 'left', clickCount = 1) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
}

export async function mouseMove(tabId: number, x: number, y: number) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

export async function mouseWheel(tabId: number, x: number, y: number, deltaX: number, deltaY: number) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
}

export async function insertText(tabId: number, text: string) {
  await send(tabId, 'Input.insertText', { text });
}

export async function typeTextByKeyEvents(tabId: number, text: string, delayMs = 0) {
  for (const ch of Array.from(text)) {
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'char',
      key: ch,
      text: ch,
      unmodifiedText: ch,
    });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export async function pressKey(tabId: number, key: string, code?: string, modifiers = 0) {
  const mods: Array<{ k: string; c: string; f: number }> = [];
  if (modifiers & 1) mods.push({ k: 'Alt',     c: 'AltLeft',     f: 1 });
  if (modifiers & 2) mods.push({ k: 'Control', c: 'ControlLeft', f: 2 });
  if (modifiers & 4) mods.push({ k: 'Meta',    c: 'MetaLeft',    f: 4 });
  if (modifiers & 8) mods.push({ k: 'Shift',   c: 'ShiftLeft',   f: 8 });

  let acc = 0;
  for (const m of mods) {
    acc |= m.f;
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: m.k, code: m.c, modifiers: acc });
  }
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: code ?? key, modifiers });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp',   key, code: code ?? key, modifiers });
  for (let i = mods.length - 1; i >= 0; i--) {
    acc &= ~mods[i].f;
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: mods[i].k, code: mods[i].c, modifiers: acc });
  }
}

export async function evaluate<T = unknown>(tabId: number, expression: string): Promise<T> {
  const r = await send<{ result: { value?: T } }>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return r.result.value as T;
}
