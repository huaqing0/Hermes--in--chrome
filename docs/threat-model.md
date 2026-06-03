# Threat Model

Hermes in Chrome is a local-first browser automation extension. It can still touch sensitive data because it reads web pages, sees screenshots, uses the clipboard for rich-text input, drives Chrome through the debugger protocol, and can save files through a Native Messaging host.

## Assets

- Page content, accessibility trees, URLs, titles, screenshots, console logs, and network metadata from tabs the user asks Hermes to operate on.
- User prompts, conversation history, model/provider selection, and optional frontend API-key overrides stored in `chrome.storage.local`.
- Local files written through the Native Messaging host.
- Clipboard contents while a `type` operation is using snapshot, paste, and restore.

## Trust Boundaries

- **Chrome extension -> local Hermes Agent**: all conversation and browser-tool traffic goes to `127.0.0.1:8642`.
- **Hermes Agent -> LLM provider**: only the backend decides what prompt/page/screenshot context is relayed to the selected provider.
- **Chrome extension -> Native Messaging host**: file writes are handled by `hermes-filewriter.py`, not by the extension directly.
- **Content scripts -> web pages**: page-reading scripts run in the extension isolated world where possible; the console hook uses the main world because page console capture requires it.

## Primary Risks

- A malicious page can try prompt injection against the agent by placing instructions in visible text, ARIA labels, forms, or hidden DOM.
- A model can choose the wrong target and click, type, submit, navigate, or save to an unintended location.
- Clipboard operations can disrupt user data if restore fails.
- `debugger` and `<all_urls>` are broad permissions. They are necessary for a browser agent but increase the blast radius of a compromised extension.
- Native file writing can be abused if path checks are too loose.
- Screenshots and page text may contain private data before being sent to the configured model provider.

## Mitigations

- `plan` mode blocks write/navigation tools and `browser_batch`.
- `approval` mode requires explicit user approval before write/navigation tools and `browser_batch`.
- Native file writes reject system paths and sensitive user directories such as shell rc files, browser profiles, `~/.ssh`, `~/.aws`, and `~/.gnupg`.
- Native file writes refuse to overwrite existing files unless the tool explicitly passes `overwrite=true`.
- The filewriter log records metadata, not full file contents.
- `type` snapshots the clipboard, pastes the requested text, and reports `clipboard_restore_mode` if restore had to degrade or failed.
- `save_to_local` is unavailable until the Native Messaging host is explicitly installed for this extension ID.
- Provider API keys are recommended to live in the Hermes backend environment, not in Chrome storage.

## User Controls

- Use `plan` mode for read-only inspection.
- Use `approval` mode when operating on accounts, dashboards, payments, admin pages, or any page with destructive actions.
- Stop the active debugger session from Chrome's debugger banner if behavior looks wrong.
- Remove the Native Messaging host manifest to disable local file writing.
- Clear frontend provider overrides from the settings panel if API keys should only live in the backend.

## Out of Scope

- Hermes in Chrome does not sandbox the selected LLM provider. Provider data handling follows that provider's terms and data policy.
- The extension does not attempt to bypass website anti-automation systems.
- The macOS Native Messaging host is the only supported local filewriter host in this release.
