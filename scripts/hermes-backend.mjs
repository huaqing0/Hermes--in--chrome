#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.HERMES_GATEWAY_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.HERMES_GATEWAY_PORT || '8642', 10);
const timeoutMs = Number.parseInt(process.env.HERMES_GATEWAY_TIMEOUT_MS || '15000', 10);
const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const logsDir = path.join(hermesHome, 'logs');
const logPath = process.env.HERMES_GATEWAY_LOG || path.join(logsDir, 'hermes-in-chrome-gateway.log');

function usage() {
  console.log(`Usage: npm run backend:<status|start|ensure>

Environment:
  HERMES_AGENT_DIR           Path to hermes-agent checkout (default: ~/.hermes/hermes-agent)
  HERMES_GATEWAY_HOST        Gateway host (default: 127.0.0.1)
  HERMES_GATEWAY_PORT        Gateway port (default: 8642)
  HERMES_GATEWAY_TIMEOUT_MS  Startup wait timeout (default: 15000)
  HERMES_GATEWAY_LOG         Log path (default: ~/.hermes/logs/hermes-in-chrome-gateway.log)
`);
}

function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function isGatewayHealthy() {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 1200 }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300));
    });
    req.once('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.once('error', () => resolve(false));
  });
}

async function gatewayState() {
  if (await isGatewayHealthy()) return 'healthy';
  if (await isPortOpen()) return 'port-open';
  return 'offline';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function commandExists(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function resolveGatewayCommand() {
  const agentDir = process.env.HERMES_AGENT_DIR || path.join(hermesHome, 'hermes-agent');
  const venvPython = path.join(agentDir, 'venv', 'bin', 'python');

  if (fileExists(venvPython)) {
    return {
      command: venvPython,
      args: ['-m', 'hermes_cli.main', 'gateway', 'run'],
      cwd: agentDir,
      label: `${venvPython} -m hermes_cli.main gateway run`,
    };
  }

  const hermes = commandExists('hermes');
  if (hermes) {
    return {
      command: hermes,
      args: ['gateway', 'run'],
      cwd: repoRoot,
      label: `${hermes} gateway run`,
    };
  }

  throw new Error(
    `Hermes gateway command not found.

Tried:
  ${venvPython}
  hermes from PATH

Install Hermes Agent first, or run:
  HERMES_AGENT_DIR=/path/to/hermes-agent npm run backend:ensure`,
  );
}

async function waitForGateway() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await gatewayState()) === 'healthy') return true;
    await sleep(500);
  }
  return false;
}

async function startGateway() {
  const state = await gatewayState();
  if (state === 'healthy') {
    console.log(`Hermes gateway is healthy at http://${host}:${port}/health`);
    return true;
  }
  if (state === 'port-open') {
    console.error(`Port ${host}:${port} is open, but Hermes /health did not respond successfully.`);
    console.error('Stop the conflicting process or set HERMES_GATEWAY_PORT to another port.');
    return false;
  }

  fs.mkdirSync(logsDir, { recursive: true });
  const stdout = fs.openSync(logPath, 'a');
  const stderr = fs.openSync(logPath, 'a');
  const resolved = resolveGatewayCommand();

  const child = spawn(resolved.command, resolved.args, {
    cwd: resolved.cwd,
    detached: true,
    stdio: ['ignore', stdout, stderr],
    env: {
      ...process.env,
      HERMES_IN_CHROME_BACKEND_PATH: path.join(repoRoot, 'backend'),
      PYTHONUNBUFFERED: '1',
    },
  });

  child.unref();
  console.log(`Started Hermes gateway process ${child.pid}`);
  console.log(`Command: ${resolved.label}`);
  console.log(`Log: ${logPath}`);

  const ok = await waitForGateway();
  if (!ok) {
    console.error(`Gateway did not become reachable at ${host}:${port} within ${timeoutMs}ms.`);
    console.error(`Check log: ${logPath}`);
    return false;
  }

  console.log(`Hermes gateway is healthy at http://${host}:${port}/health`);
  return true;
}

async function main() {
  const command = process.argv[2] || 'ensure';

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid HERMES_GATEWAY_PORT: ${process.env.HERMES_GATEWAY_PORT}`);
  }

  if (command === 'status') {
    const state = await gatewayState();
    if (state === 'healthy') {
      console.log(`Hermes gateway is healthy at http://${host}:${port}/health`);
      return;
    }
    if (state === 'port-open') {
      console.error(`Port ${host}:${port} is open, but Hermes /health did not respond successfully.`);
    } else {
      console.error(`Hermes gateway is not reachable at ${host}:${port}`);
    }
    process.exitCode = 1;
    return;
  }

  if (command === 'start' || command === 'ensure') {
    const ok = await startGateway();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
