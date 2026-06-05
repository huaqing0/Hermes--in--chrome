# Troubleshooting Guide

Common issues when running Hermes in Chrome and how to resolve them.

## Backend is not connected

**Symptom**: Sidepanel shows "Backend offline" or WebSocket connection fails.

**Check**:
```bash
npm run backend:status
```

**Fix**:
```bash
npm run backend:ensure
```

This detects whether Hermes gateway is already running on `127.0.0.1:8642` and starts it if needed. If it still fails:

1. Check whether another process is occupying port 8642: `lsof -i :8642` (macOS) or `netstat -ano | findstr :8642` (Windows)
2. Verify the Hermes Agent installation
3. Check the gateway log: `~/.hermes/logs/hermes-in-chrome-gateway.log`

## Hermes Agent is not found

**Symptom**: `npm run backend:ensure` reports "Hermes gateway command not found."

**Causes and fixes**:

- Hermes Agent is not installed: follow the [Hermes Agent setup guide](https://github.com/huaqing0/hermes-agent)
- Installed in a non-default location: set `HERMES_AGENT_DIR` before running the script
  ```bash
  HERMES_AGENT_DIR=/path/to/hermes-agent npm run backend:ensure
  ```
- Virtual environment not at the expected path: verify `~/.hermes/hermes-agent/venv/bin/python` exists (macOS) or `~/.hermes/hermes-agent/venv/Scripts/python.exe` (Windows)

## Native Messaging host is not installed

**Symptom**: `save_to_local` tool fails, status bar shows Native Host as not installed.

**Check**:
```bash
npm run native-host:status
```

**Fix**:
```bash
npm run native-host:install -- <your-extension-id>
```

Find your extension ID at `chrome://extensions` (turn on Developer mode first). After installing, reload the extension at `chrome://extensions`.

If it still fails:
- macOS: verify the manifest exists at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.hermes.filewriter.json`
- Windows: verify the registry key exists
  ```bash
  reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hermes.filewriter
  ```
- Check the filewriter log: `~/.hermes/logs/hermes-filewriter.log`

## Extension ID mismatch

**Symptom**: Native host is installed but the extension can't connect to it.

The Native Messaging manifest must contain the exact extension ID. Check the manifest:

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.hermes.filewriter.json`
- Windows: `%USERPROFILE%\.hermes\native-messaging\com.hermes.filewriter.json`

The `allowed_origins` array must include `chrome-extension://<your-extension-id>/`.

Reinstall the host with the correct ID if needed:
```bash
npm run native-host:install -- <correct-extension-id>
```

## Provider validation fails

**Symptom**: "Test model" or "Test vision" returns errors, or the agent can't call the LLM.

**Troubleshooting steps**:

1. **Check backend connectivity**: `npm run backend:status`. If offline, run `npm run backend:ensure`
2. **Verify API key**: In sidepanel Settings, check the provider and API key. Test with "Test model"
3. **Check backend env**: API keys in `~/.hermes/.env` take priority over sidepanel-only keys
4. **Network access**: Some providers may be blocked by firewalls or VPNs
5. **Rate limits**: The provider may have rate-limited your account
6. **Common error codes**:
   - `401`: Invalid or missing API key
   - `403`: Access denied (region restriction, quota, or billing issue)
   - `429`: Rate limited — wait and retry
   - `5xx`: Provider-side error — try again later

## Chrome debugger banner appears

**Symptom**: Chrome shows "This browser is being controlled by a debugger" banner.

This is expected behavior. Hermes in Chrome uses `chrome.debugger` (Chrome DevTools Protocol) to take screenshots, click, and type. The banner appears whenever an extension is attached to a tab via CDP.

- The banner disappears when the agent finishes its current task
- You can click the banner to stop the debugger at any time
- CDP itself is local, but page content or screenshots may be relayed by the backend to your configured model provider

## read_page fails or returns empty content

**Symptom**: Agent reports "no accessible content" or `read_page` returns an empty result.

**Common causes**:

1. **The page hasn't finished loading** — wait a moment and retry
2. **The page has no accessibility tree** — some pages (e.g., canvas-based apps, certain SPAs) don't expose content through the a11y tree. Use `screenshot` + `visual_inspect` instead
3. **Content scripts not injected** — navigate to a new URL on the same domain and try again
4. **The page is a restricted URL** — `chrome://`, `chrome-extension://`, and `edge://` pages cannot be read

## Windows support notes

Windows support is experimental. Known issues:

- Only Chrome registry paths are supported (not Edge, Brave, or other Chromium browsers)
- Python 3 must be on PATH and available as `python` or `py -3`
- The `.cmd` launcher must not echo anything to stdout (Native Messaging protocol requires binary-clean stdout)
- Detached process behavior may differ from macOS; use `npm run backend:watch` in a kept-open PowerShell window if the gateway doesn't survive terminal close

## Logs locations

| Log | Path | Purpose |
|-----|------|---------|
| Gateway log | `~/.hermes/logs/hermes-in-chrome-gateway.log` | Hermes Agent stdout/stderr |
| Filewriter log | `~/.hermes/logs/hermes-filewriter.log` | Native Messaging host events |
| Tools log | `~/.hermes/logs/hermes-in-chrome-tools.jsonl` | Tool execution telemetry |

To inspect logs:
```bash
tail -f ~/.hermes/logs/hermes-in-chrome-gateway.log
tail -f ~/.hermes/logs/hermes-filewriter.log
cat ~/.hermes/logs/hermes-in-chrome-tools.jsonl | tail -20
```

## Getting more help

If none of the above resolves your issue:

1. Run `npm run check-bridge` to verify the backend bridge is properly configured
2. Check the [security policy](../SECURITY.md) for reporting sensitive issues
3. File a bug report with logs and reproduction steps on [GitHub Issues](https://github.com/huaqing0/Hermes--in--chrome/issues)
