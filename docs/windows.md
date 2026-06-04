# Windows experimental support

> This document covers Windows-specific implementation details for Hermes in Chrome.
> Windows support is **experimental** — not fully tested.

## Prerequisites

- Windows 10 or later
- [Node.js](https://nodejs.org/) (for npm scripts)
- [Python 3](https://www.python.org/downloads/) (for the filewriter host)
- Chrome 116+

## Native Messaging host

On Windows, Chrome discovers native messaging hosts through the registry instead of a well-known directory path.

### Install

```powershell
npm run native-host:install -- <your-extension-id>
```

This script:
1. Copies `hermes-filewriter.py` to `%USERPROFILE%\.hermes\native-messaging\`
2. Generates `hermes-filewriter-host.cmd` — a launcher that finds `python`/`py` on PATH and invokes the host with binary-mode stdin/stdout
3. Writes the manifest JSON to `%USERPROFILE%\.hermes\native-messaging\com.hermes.filewriter.json` with the `.cmd` launcher path
4. Registers the host via `reg add HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hermes.filewriter`

### Check status

```powershell
npm run native-host:status
```

This runs `reg query` to check if the registry key exists.

### Verify manually

```powershell
reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hermes.filewriter
```

Expected output shows the `(Default)` REG_SZ value pointing to the manifest JSON.

### Dry-run from macOS

If you are preparing a Windows release from another platform, preview the Windows manifest and registry command without touching the registry:

```bash
node scripts/install-native-host.mjs --dry-run --platform win32 --home "C:\Users\Your Name" abcdefghijklmnopabcdefghijklmnop
```

The example extension ID is a valid 32-character Chrome extension ID shape: only letters `a` through `p` are allowed.

### Uninstall

```powershell
npm run native-host:uninstall
```

Removes the registry key and cleans up the host files.

## Backend startup

```powershell
npm run backend:ensure
```

The backend script (`scripts/hermes-backend.mjs`) detects whether Hermes gateway is already running on `127.0.0.1:8642`. If not, it resolves the venv Python path:

- `%USERPROFILE%\.hermes\hermes-agent\venv\Scripts\python.exe` (preferred)
- Falls back to `hermes` on PATH (using `where.exe`)

## Filewriter security (Windows)

The filewriter host (`scripts/hermes-filewriter.py`) applies Windows-specific path restrictions:

### Rejected system paths
- `C:\Windows`
- `C:\Program Files`
- `C:\Program Files (x86)`
- `C:\ProgramData`

### Rejected user-sensitive paths
- `%USERPROFILE%\.ssh`
- `%USERPROFILE%\.aws`
- `%USERPROFILE%\.gnupg`
- `%USERPROFILE%\.docker`
- `%LOCALAPPDATA%\Google\Chrome`
- `%LOCALAPPDATA%\Chromium`
- `%APPDATA%\Mozilla\Firefox`
- `%APPDATA%\Microsoft\Windows\PowerShell`
- `%USERPROFILE%\Documents\WindowsPowerShell`

### Rejected patterns
- UNC paths (`\\server\share`)
- Device paths (`\\?\...`)
- Drive root (`C:\`)
- Sensitive filenames: `.git-credentials`, `.npmrc`, `.pypirc`, `.env`, `Microsoft.PowerShell_profile.ps1`, `profile.ps1`

Path comparisons are case-insensitive on Windows to prevent case-based bypasses.

## Known gaps

- Only Chrome's registry path (`HKCU\Software\Google\Chrome\NativeMessagingHosts`) is supported. Edge, Brave, and other Chromium-based browsers use different registry roots.
- The `npm run native-host:install` script uses `reg add` which requires no elevation for `HKCU`. If this fails, verify the user has write access to their own registry hive.
- Backend detach/spawn behavior differs slightly from macOS. If the gateway process doesn't survive terminal close, use `npm run backend:watch` in a kept-open PowerShell window.
