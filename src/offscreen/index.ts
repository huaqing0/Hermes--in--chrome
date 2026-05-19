// Offscreen Document：每 20s 给 Service Worker 发心跳，防止 SW 30s idle 被杀
// 学自 Claude in Chrome 的做法

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'SW_KEEPALIVE' }).catch(() => {});
}, 20_000);

function readClipboardViaTextarea(): string {
  const ta = document.createElement('textarea');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  try {
    ta.focus();
    const ok = document.execCommand('paste');
    if (!ok) throw new Error('execCommand("paste") returned false');
    return ta.value;
  } finally {
    ta.remove();
  }
}

function writeClipboardViaTextarea(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand("copy") returned false');
  } finally {
    ta.remove();
  }
}

type ClipboardSnapshot =
  | { mode: 'full'; items: Array<{ types: Array<{ type: string; dataUrl: string }> }> }
  | { mode: 'text'; text: string };

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read blob failed'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const resp = await fetch(dataUrl);
  return resp.blob();
}

async function readClipboardSnapshot(): Promise<ClipboardSnapshot> {
  try {
    const items = await navigator.clipboard.read();
    if (items.length > 0) {
      const serialized = [];
      for (const item of items) {
        const types = [];
        for (const type of item.types) {
          const blob = await item.getType(type);
          types.push({ type, dataUrl: await blobToDataUrl(blob) });
        }
        serialized.push({ types });
      }
      return { mode: 'full', items: serialized };
    }
  } catch {
    // Offscreen documents may not be focusable enough for full clipboard APIs.
    // Fall through to the text-only path instead of silently dropping data.
  }

  try {
    return { mode: 'text', text: await navigator.clipboard.readText() };
  } catch {
    return { mode: 'text', text: readClipboardViaTextarea() };
  }
}

async function restoreClipboardSnapshot(snapshot: ClipboardSnapshot): Promise<{ mode: 'full' | 'text' | 'failed'; error?: string }> {
  if (snapshot.mode === 'full') {
    try {
      const items = [];
      for (const item of snapshot.items) {
        const data: Record<string, Blob> = {};
        for (const entry of item.types) {
          data[entry.type] = await dataUrlToBlob(entry.dataUrl);
        }
        items.push(new ClipboardItem(data));
      }
      await navigator.clipboard.write(items);
      return { mode: 'full' };
    } catch (e) {
      const text = snapshot.items
        .flatMap((item) => item.types)
        .find((entry) => entry.type === 'text/plain');
      if (!text) return { mode: 'failed', error: e instanceof Error ? e.message : String(e) };
      try {
        const blob = await dataUrlToBlob(text.dataUrl);
        await navigator.clipboard.writeText(await blob.text());
        return { mode: 'text', error: e instanceof Error ? e.message : String(e) };
      } catch (fallbackError) {
        return { mode: 'failed', error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) };
      }
    }
  }

  try {
    await navigator.clipboard.writeText(snapshot.text);
    return { mode: 'text' };
  } catch (e) {
    try {
      writeClipboardViaTextarea(snapshot.text);
      return { mode: 'text', error: e instanceof Error ? e.message : String(e) };
    } catch (fallbackError) {
      return { mode: 'failed', error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) };
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (
    msg?.type !== 'HERMES_CLIPBOARD_READ'
    && msg?.type !== 'HERMES_CLIPBOARD_WRITE_TEXT'
    && msg?.type !== 'HERMES_CLIPBOARD_RESTORE'
  ) return false;

  (async () => {
    try {
      if (msg.type === 'HERMES_CLIPBOARD_READ') {
        sendResponse({ ok: true, snapshot: await readClipboardSnapshot() });
        return;
      }

      if (msg.type === 'HERMES_CLIPBOARD_RESTORE') {
        const result = await restoreClipboardSnapshot(msg.snapshot as ClipboardSnapshot);
        sendResponse({ ok: result.mode !== 'failed', ...result });
        return;
      }

      const text = String(msg.text ?? '');
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        writeClipboardViaTextarea(text);
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();

  return true;
});

console.log('[Hermes Offscreen] 心跳已启动 (20s 间隔)');
