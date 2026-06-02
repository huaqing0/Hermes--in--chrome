#!/usr/bin/env node

// Hermes in Chrome — bridge connectivity check
// Verifies that the Hermes Agent gateway is healthy and the browser-ext tool bridge is loaded.

import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HOST = process.env.HERMES_GATEWAY_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.HERMES_GATEWAY_PORT || '8642', 10);
const GATEWAY_LOG = process.env.HERMES_GATEWAY_LOG || join(homedir(), '.hermes', 'logs', 'hermes-in-chrome-gateway.log');
const BACKEND_PATH = process.env.HERMES_IN_CHROME_BACKEND_PATH || join(repoRoot, 'backend');

const OK = '[OK]';
const FAIL = '[FAIL]';
const WARN = '[WARN]';

let errors = 0;

function check(label, pass, detail) {
  if (pass) {
    console.log(`  ${OK} ${label}`);
  } else {
    console.log(`  ${FAIL} ${label}${detail ? ' — ' + detail : ''}`);
    errors++;
  }
}

// --- health endpoint ---
console.log(`\nHermes in Chrome bridge check`);
console.log(`  Gateway: http://${HOST}:${PORT}/health`);

const healthy = await new Promise((resolve) => {
  const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: 3000 }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
  });
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
});

check('Gateway /health responded OK', healthy,
  !healthy ? `Gateway not reachable. Run: npm run backend:ensure` : '');

// --- backend path ---
let dirExists = false;
try { dirExists = statSync(BACKEND_PATH).isDirectory(); } catch {}
check(`backend bridge path = ${BACKEND_PATH}`, dirExists,
  `Directory not found. Set HERMES_IN_CHROME_BACKEND_PATH to the hermes-in-chrome/backend directory.`);
if (!process.env.HERMES_IN_CHROME_BACKEND_PATH) {
  console.log(`  ${WARN} HERMES_IN_CHROME_BACKEND_PATH not set in this shell; using repo backend path for this check.`);
  console.log(`       scripts/hermes-backend.mjs sets the env var automatically for the gateway process.`);
}

// --- gateway log check ---
let logChecked = false;
try {
  const log = readFileSync(GATEWAY_LOG, 'utf8');
  logChecked = true;
  const hasLoadError = /加载 browser_extension_tools 失败/.test(log);
  const hasLoadSuccess = /browser-ext 工具桥已加载/.test(log);

  if (hasLoadSuccess) {
    check('Gateway log: browser-ext tool bridge loaded', true);
  } else if (hasLoadError) {
    check('Gateway log: browser-ext tool bridge loaded', false,
      `Log shows import failure. Ensure HERMES_IN_CHROME_BACKEND_PATH points to the hermes-in-chrome/backend directory containing browser_extension_tools.py.`);
  } else {
    console.log(`  ${WARN} Gateway log exists but no browser-ext load message found`);
    console.log(`       If the gateway was started without HERMES_IN_CHROME_BACKEND_PATH, browser tools may not work.`);
  }
} catch {
  // log file doesn't exist yet — not necessarily an error
}

if (!logChecked) {
  console.log(`  ${WARN} Gateway log not found at ${GATEWAY_LOG}`);
  console.log(`       This is normal if the gateway hasn't been started yet.`);
}

// --- backend/ directory check ---
const backendDir = BACKEND_PATH || join(process.cwd(), 'backend');
try {
  const hasBridge = statSync(join(backendDir, 'browser_extension_tools.py')).isFile();
  check(`backend/browser_extension_tools.py exists (${backendDir})`, hasBridge,
    `Missing browser_extension_tools.py in ${backendDir}. Is this the right hermes-in-chrome checkout?`);
} catch {
  check(`backend/browser_extension_tools.py exists (${backendDir})`, false,
    `Cannot find ${backendDir}/browser_extension_tools.py.`);
}

// --- summary ---
console.log('');
if (errors === 0) {
  console.log(`${OK} Bridge check passed — Hermes Agent gateway is ready for extension connections.`);
} else {
  console.log(`${FAIL} Bridge check found ${errors} issue(s).`);
  console.log(`  Fix the issues above, then re-run:  node scripts/check-bridge.mjs`);
}

process.exitCode = errors > 0 ? 1 : 0;
