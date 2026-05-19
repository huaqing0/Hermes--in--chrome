#!/usr/bin/env node
// Install Native Messaging host manifest for Chrome on macOS.
// Usage:
//   node scripts/install-native-host.mjs <chrome-extension-id> [<extension-id-2> ...]
//
// Tells Chrome about the host com.hermes.filewriter and which extension
// IDs are allowed to talk to it. Also copies the Python host into
// ~/.hermes/native-messaging/hermes-filewriter.py so the extension can
// keep working even if the project dir moves.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.hermes.filewriter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const srcHost = join(repoRoot, 'scripts', 'hermes-filewriter.py');

const home = homedir();
const destDir = join(home, '.hermes', 'native-messaging');
const destHost = join(destDir, 'hermes-filewriter.py');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/install-native-host.mjs <chrome-extension-id> [more...]');
  console.error('');
  console.error('找你的 extension ID：');
  console.error('  1) Chrome 打开 chrome://extensions');
  console.error('  2) 右上角开「开发者模式」');
  console.error('  3) 找到 Hermes in Chrome，复制 ID（32 位小写字母）');
  process.exit(1);
}

const extIds = args.map((id) => id.trim()).filter(Boolean);
for (const id of extIds) {
  if (!/^[a-p]{32}$/.test(id)) {
    console.error(`extension ID 看起来不对：${id}（应为 32 位 a-p 字母）`);
    process.exit(1);
  }
}

if (platform() !== 'darwin') {
  console.error('当前只支持 macOS（Chrome on Darwin）');
  process.exit(1);
}

const chromeHostsDir = join(
  home,
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'NativeMessagingHosts',
);

await fs.mkdir(destDir, { recursive: true });
await fs.copyFile(srcHost, destHost);
await fs.chmod(destHost, 0o755);
console.log(`✔ copied host script → ${destHost}`);

await fs.mkdir(chromeHostsDir, { recursive: true });
const manifestPath = join(chromeHostsDir, `${HOST_NAME}.json`);
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

// 记录 repoRoot 供 sidepanel 拿来拼 `cd <root> && npm run ...` 一键复制命令
const metaPath = join(home, '.hermes', 'hermes-in-chrome.json');
const meta = {
  repoRoot,
  installedAt: new Date().toISOString(),
  extensionIds: extIds,
};
await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
console.log(`✔ wrote install meta → ${metaPath}`);

console.log('\n下一步：在 Chrome 里重新加载 Hermes 扩展，然后用 ext_save_to_local 试一下。');
