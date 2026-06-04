#!/usr/bin/env node
// Install Native Messaging host manifest for Chrome.
//
// macOS:
//   Writes com.hermes.filewriter.json into
//   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
//
// Windows:
//   Writes com.hermes.filewriter.json into
//   %USERPROFILE%\.hermes\native-messaging\ and registers it via
//   HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hermes.filewriter
//
// Usage:
//   node scripts/install-native-host.mjs <chrome-extension-id> [<id2> ...]
//   node scripts/install-native-host.mjs --status
//   node scripts/install-native-host.mjs --uninstall
//   node scripts/install-native-host.mjs --dry-run --platform win32 <id>

import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path, { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.hermes.filewriter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const srcHost = path.join(repoRoot, 'scripts', 'hermes-filewriter.py');

// ── flag parsing ──────────────────────────────────────────────
const rawArgs = process.argv.slice(2);

const flags = {
  status: false,
  uninstall: false,
  dryRun: false,
  platformOverride: /** @type {string | null} */ (null),
  homeOverride: /** @type {string | null} */ (null),
};

const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--status') { flags.status = true; }
  else if (a === '--uninstall') { flags.uninstall = true; }
  else if (a === '--dry-run') { flags.dryRun = true; }
  else if (a === '--platform' && i + 1 < rawArgs.length) { flags.platformOverride = rawArgs[++i]; }
  else if (a === '--home' && i + 1 < rawArgs.length) { flags.homeOverride = rawArgs[++i]; }
  else if (!a.startsWith('-')) { positional.push(a.trim()); }
}

const hostPlatform = platform();
const currentPlatform = flags.platformOverride ?? platform();
const pathApi = currentPlatform === 'win32' ? path.win32 : path.posix;
const home = flags.homeOverride
  ?? (currentPlatform === 'win32' && hostPlatform !== 'win32' ? 'C:\\Users\\hermes' : homedir());
const destDir = pathApi.join(home, '.hermes', 'native-messaging');
const destHost = pathApi.join(destDir, 'hermes-filewriter.py');

// ── helpers ───────────────────────────────────────────────────

function getChromeHostsDir() {
  if (currentPlatform === 'win32') {
    // Windows: manifest lives alongside the host, registered via registry
    return destDir;
  }
  // macOS
  return pathApi.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
}

function getManifestPath() {
  return pathApi.join(getChromeHostsDir(), `${HOST_NAME}.json`);
}

function getLauncherPath() {
  return pathApi.join(destDir, 'hermes-filewriter-host.cmd');
}

function buildLauncherContent() {
  return `@echo off
setlocal
set PYTHONUTF8=1
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 -u "%~dp0hermes-filewriter.py" %*
) else (
  python -u "%~dp0hermes-filewriter.py" %*
)
`;
}

function regKey() {
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
}

function usage() {
  console.error('usage: node scripts/install-native-host.mjs <chrome-extension-id> [more...]');
  console.error('       node scripts/install-native-host.mjs --status');
  console.error('       node scripts/install-native-host.mjs --uninstall');
  console.error('       node scripts/install-native-host.mjs --dry-run --platform win32 [--home C:\\Users\\you] <id>');
  console.error('');
  console.error('找你的 extension ID：');
  console.error('  1) Chrome 打开 chrome://extensions');
  console.error('  2) 右上角开「开发者模式」');
  console.error('  3) 找到 Hermes in Chrome，复制 ID（32 位小写字母）');
}

function validateExtensionIds(extIds, { allowPlaceholder = false } = {}) {
  for (const id of extIds) {
    if (allowPlaceholder && id === '<extension-id>') continue;
    if (!/^[a-p]{32}$/.test(id)) {
      console.error(`extension ID 看起来不对：${id}（应为 32 位 a-p 字母）`);
      process.exit(1);
    }
  }
}

/** Run a command and return {ok, stdout}. Throws nothing — catches all. */
function run(cmd, args) {
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    if (result.status === 0) {
      return { ok: true, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
    }
    return {
      ok: false,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || result.error?.message || `exit ${result.status}`).trim(),
    };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

// ── status ────────────────────────────────────────────────────

function checkStatus() {
  if (currentPlatform === 'win32') {
    const r = run('reg', ['query', regKey()]);
    if (!r.ok && /unable to find/i.test(r.stderr || '')) return { installed: false };
    if (r.ok) {
      // Parse default value line from reg query output
      const match = r.stdout.match(/REG_SZ\s+(.+)/);
      const manifestPath = match ? match[1].trim() : null;
      if (manifestPath && existsSync(manifestPath)) {
        let repoRootMeta = null;
        try {
          const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
          // manifest path lives in destDir — meta is in ~/.hermes/hermes-in-chrome.json
          const metaPath = pathApi.join(home, '.hermes', 'hermes-in-chrome.json');
          if (existsSync(metaPath)) {
            const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
            repoRootMeta = meta.repoRoot || null;
          }
        } catch {}
        return { installed: true, manifestPath, repoRoot: repoRootMeta };
      }
      return { installed: false, error: `manifest not found at ${manifestPath || '(unknown)'}` };
    }
    return { installed: false, error: r.stderr || 'reg query failed' };
  }

  // macOS
  const manifestPath = getManifestPath();
  if (!existsSync(manifestPath)) return { installed: false };

  // Also check the host script itself
  if (!existsSync(destHost)) return { installed: false };

  let repoRootMeta = null;
  try {
    const metaPath = pathApi.join(home, '.hermes', 'hermes-in-chrome.json');
    if (existsSync(metaPath)) {
      repoRootMeta = JSON.parse(readFileSync(metaPath, 'utf8')).repoRoot || null;
    }
  } catch {}

  return { installed: true, manifestPath, repoRoot: repoRootMeta };
}

// ── uninstall ─────────────────────────────────────────────────

function uninstall() {
  if (currentPlatform === 'win32') {
    const r = run('reg', ['delete', regKey(), '/f']);
    if (!r.ok && !/unable to find/i.test(r.stderr || '')) {
      console.error(`Failed to delete registry key: ${r.stderr}`);
      return false;
    }
    console.log(`✔ deleted registry key ${regKey()}`);
    // Clean up host files
    try { unlinkSync(getLauncherPath()); console.log(`✔ removed ${getLauncherPath()}`); } catch {}
    try { unlinkSync(destHost); console.log(`✔ removed ${destHost}`); } catch {}
    try { unlinkSync(getManifestPath()); console.log(`✔ removed ${getManifestPath()}`); } catch {}
    return true;
  }

  // macOS
  const manifestPath = getManifestPath();
  if (existsSync(manifestPath)) {
    try { unlinkSync(manifestPath); console.log(`✔ removed ${manifestPath}`); } catch (e) {
      console.error(`Failed to remove manifest: ${e.message}`);
      return false;
    }
  } else {
    console.log(`manifest not found at ${manifestPath}, nothing to remove`);
  }
  // Also remove host copy
  if (existsSync(destHost)) {
    try { unlinkSync(destHost); console.log(`✔ removed ${destHost}`); } catch {}
  }
  return true;
}

// ── install ───────────────────────────────────────────────────

async function install(extIds) {
  if (currentPlatform === 'win32') {
    return await installWindows(extIds);
  }
  return await installMacOS(extIds);
}

async function installMacOS(extIds) {
  const chromeHostsDir = getChromeHostsDir();

  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(srcHost, destHost);
  await fs.chmod(destHost, 0o755);
  console.log(`✔ copied host script → ${destHost}`);

  await fs.mkdir(chromeHostsDir, { recursive: true });
  const manifestPath = getManifestPath();
  const manifest = {
    name: HOST_NAME,
    description: 'Hermes in Chrome file writer',
    path: destHost,
    type: 'stdio',
    allowed_origins: extIds.map((id) => `chrome-extension://${id}/`),
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✔ wrote manifest → ${manifestPath}`);
  console.log('  allowed_origins:');
  for (const o of manifest.allowed_origins) console.log(`    - ${o}`);

  if (!existsSync(destHost)) {
    console.error('host script 没有写到目标路径，请检查权限。');
    process.exit(1);
  }

  // 记录 repoRoot 供 sidepanel 拿来拼 cd 命令
  const metaPath = pathApi.join(home, '.hermes', 'hermes-in-chrome.json');
  const meta = { repoRoot, installedAt: new Date().toISOString(), extensionIds: extIds };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`✔ wrote install meta → ${metaPath}`);

  console.log('\n下一步：在 Chrome 里重新加载 Hermes 扩展，然后用 ext_save_to_local 试一下。');
}

async function installWindows(extIds) {
  if (flags.dryRun) {
    console.log('[dry-run] Would install for Windows:');
    console.log(`[dry-run]   platform: ${currentPlatform}`);
    console.log(`[dry-run]   destDir: ${destDir}`);
    console.log(`[dry-run]   destHost: ${destHost}`);
    console.log(`[dry-run]   launcher: ${getLauncherPath()}`);
    console.log(`[dry-run]   manifestPath: ${getManifestPath()}`);
    console.log(`[dry-run]   regKey: HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`);
    console.log(`[dry-run]   regValue: ${getManifestPath()}`);
    console.log(`[dry-run]   extensionIds: ${extIds.join(', ')}`);

    const manifest = {
      name: HOST_NAME,
      description: 'Hermes in Chrome file writer',
      path: getLauncherPath(),
      type: 'stdio',
      allowed_origins: extIds.map((id) => `chrome-extension://${id}/`),
    };
    console.log(`[dry-run]   manifest.json: ${JSON.stringify(manifest, null, 2)}`);
    console.log(`[dry-run]   reg command: reg add ${regKey()} /ve /t REG_SZ /d "${getManifestPath()}" /f`);
    return;
  }

  // Real Windows install
  await fs.mkdir(destDir, { recursive: true });

  // 1. Copy host script
  await fs.copyFile(srcHost, destHost);
  console.log(`✔ copied host script → ${destHost}`);

  // 2. Write .cmd launcher
  const launcherPath = getLauncherPath();
  await fs.writeFile(launcherPath, buildLauncherContent());
  console.log(`✔ wrote launcher → ${launcherPath}`);

  // 3. Write manifest (path points to .cmd launcher, not .py directly)
  const manifestPath = getManifestPath();
  const manifest = {
    name: HOST_NAME,
    description: 'Hermes in Chrome file writer',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: extIds.map((id) => `chrome-extension://${id}/`),
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✔ wrote manifest → ${manifestPath}`);
  console.log('  allowed_origins:');
  for (const o of manifest.allowed_origins) console.log(`    - ${o}`);

  // 4. Write registry
  const regCmd = `reg add ${regKey()} /ve /t REG_SZ /d "${manifestPath}" /f`;
  const r = run('reg', ['add', regKey(), '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
  if (!r.ok) {
    console.error(`Failed to write registry: ${r.stderr}`);
    console.error(`Please run this command manually as Administrator:`);
    console.error(`  ${regCmd}`);
    process.exit(1);
  }
  console.log(`✔ registered ${regKey()} → ${manifestPath}`);

  // 5. Write install meta
  const metaPath = pathApi.join(home, '.hermes', 'hermes-in-chrome.json');
  const meta = { repoRoot, installedAt: new Date().toISOString(), extensionIds: extIds };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`✔ wrote install meta → ${metaPath}`);

  console.log('\n下一步：在 Chrome 里重新加载 Hermes 扩展，然后用 ext_save_to_local 试一下。');
}

// ── main ──────────────────────────────────────────────────────

async function main() {
  if (currentPlatform !== 'darwin' && currentPlatform !== 'win32') {
    console.error(`当前只支持 macOS 和 Windows（不支持 ${currentPlatform}）`);
    process.exit(1);
  }

  if (flags.platformOverride && !flags.dryRun && currentPlatform !== hostPlatform) {
    console.error('--platform can only target another OS when used with --dry-run.');
    process.exit(1);
  }

  // --status
  if (flags.status) {
    const s = checkStatus();
    if (s.installed) {
      console.log(`Native Messaging host "${HOST_NAME}" is installed.`);
      console.log(`  manifest: ${s.manifestPath}`);
      if (s.repoRoot) console.log(`  repoRoot: ${s.repoRoot}`);
    } else {
      console.log(`Native Messaging host "${HOST_NAME}" is NOT installed.`);
      if (s.error) console.log(`  reason: ${s.error}`);
      process.exitCode = 1;
    }
    return;
  }

  // --uninstall
  if (flags.uninstall) {
    const ok = uninstall();
    if (!ok) process.exitCode = 1;
    return;
  }

  const extIds = flags.dryRun && positional.length === 0 ? ['<extension-id>'] : positional;
  if (extIds.length === 0) {
    usage();
    process.exit(1);
  }
  validateExtensionIds(extIds, { allowPlaceholder: flags.dryRun });

  if (flags.dryRun && !flags.platformOverride && currentPlatform !== 'win32') {
    // macOS dry-run: just print what would happen
    console.log('[dry-run] Would install for macOS:');
    console.log(`[dry-run]   platform: ${currentPlatform}`);
    console.log(`[dry-run]   destDir: ${destDir}`);
    console.log(`[dry-run]   destHost: ${destHost}`);
    console.log(`[dry-run]   manifestPath: ${getManifestPath()}`);
    console.log(`[dry-run]   extensionIds: ${extIds.join(', ')}`);
    return;
  }

  await install(extIds);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
