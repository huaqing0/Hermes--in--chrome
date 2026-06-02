// Hermes console hook — injected into MAIN world so it captures page-level
// console.log / info / warn / error / debug calls.
// The buffer is read by get_console_logs through chrome.scripting.executeScript
// with world: 'MAIN'.
(function () {
  const w = window as any;
  if (w.__hermesConsoleHookedMain) return;
  w.__hermesConsoleHookedMain = true;
  w.__hermesConsoleBufferMain = [];
  const orig: Record<string, (...a: unknown[]) => void> = {};
  for (const lvl of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    orig[lvl] = (console as any)[lvl].bind(console);
    (console as any)[lvl] = (...args: unknown[]) => {
      try {
        w.__hermesConsoleBufferMain.push({
          level: lvl,
          ts: Date.now(),
          msg: args
            .map((a: unknown) => {
              try {
                return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a);
              } catch {
                return String(a);
              }
            })
            .join(' ')
            .slice(0, 500),
        });
        if (w.__hermesConsoleBufferMain.length > 200) w.__hermesConsoleBufferMain.shift();
      } catch {}
      orig[lvl](...args);
    };
  }
})();
