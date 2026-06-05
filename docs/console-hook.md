# Console Hook Risk

## Current behavior

The content script `src/content/console-hook.ts` is injected into every page at `document_start` in the **MAIN world**. It overwrites `console.log`, `console.info`, `console.warn`, `console.error`, and `console.debug` to capture console output for the `get_console_logs` tool.

## Risk

### Page script interference

Rewriting global `console.*` methods in the MAIN world means the extension's hooks run in the same JavaScript environment as the page's own code. This creates several issues:

- **Compatibility**: page scripts that wrap, decorate, or rely on specific `console` behavior (e.g. logging frameworks, devtools integration, monitoring libraries) may break or behave unexpectedly when the extension's overrides are present
- **Detectability**: websites can detect that `console` has been modified by checking `console.log.toString()` or comparing `Function.prototype.toString.call(console.log)`, revealing the presence of the extension
- **Performance**: every `console.log` call made by page scripts passes through the extension's interceptor, adding overhead even when `get_console_logs` is not actively being called

### Always-on injection

The console hook is injected unconditionally — every page, every frame, every navigation. There is no way for the user to disable it without modifying the extension's manifest. This violates the principle of least privilege: the extension should only modify page globals when the user has explicitly asked for console capture.

## Future direction

### On-demand injection

The preferred approach is to inject the console hook only when `get_console_logs` is requested:

1. Remove `console-hook.ts` from the manifest's `content_scripts` section
2. In `tools.execute` for `get_console_logs`, use `chrome.scripting.executeScript` to inject the hook on demand
3. Collect logs for the duration of the tool call, then remove the interceptor

### CDP as primary source

Chrome DevTools Protocol provides `Runtime.consoleAPICalled` and `Log.entryAdded` events that capture console output without modifying page globals. This is the preferred long-term approach:

- Attach to the tab via `chrome.debugger` (already granted)
- Subscribe to `Runtime.enable` and `Log.enable`
- Buffer console events and return them for `get_console_logs`
- No MAIN world injection needed

### Stop injecting by default

No matter which alternative is chosen, the default behavior should change: **normal browsing should not rewrite page globals**. The `get_console_logs` tool should handle its own injection, not rely on a permanently running content script.

## Related

- [Threat model](./threat-model.md)
- [ROADMAP.md](../ROADMAP.md) (console hook hardening)
