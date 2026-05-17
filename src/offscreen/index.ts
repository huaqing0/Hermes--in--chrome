// Offscreen Document：每 20s 给 Service Worker 发心跳，防止 SW 30s idle 被杀
// 学自 Claude in Chrome 的做法

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'SW_KEEPALIVE' }).catch(() => {});
}, 20_000);

console.log('[Hermes Offscreen] 心跳已启动 (20s 间隔)');
