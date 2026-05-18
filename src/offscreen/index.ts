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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'HERMES_CLIPBOARD_READ' && msg?.type !== 'HERMES_CLIPBOARD_WRITE') return false;

  (async () => {
    try {
      if (msg.type === 'HERMES_CLIPBOARD_READ') {
        // Offscreen documents can't get focus, so navigator.clipboard.readText()
        // throws "Document is not focused". The execCommand("paste") fallback into
        // a focused textarea is the workaround Chrome leaves open for this case.
        let value: string;
        try {
          value = await navigator.clipboard.readText();
        } catch {
          value = readClipboardViaTextarea();
        }
        sendResponse({ ok: true, value });
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
