import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const API_HOST = '127.0.0.1';
const API_PORT = Number(process.env.DEMO_API_PORT) || 8787;
const WEB_PORT = Number(process.env.DEMO_WEB_PORT) || 5173;

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  console.error(
    `error: Node.js >= 24 is required (current ${process.versions.node}). Upgrade Node and retry.`,
  );
  process.exit(1);
}

const corePath = path.join(repoRoot, 'node_modules', '@agent-pay', 'core');
if (!fs.existsSync(corePath)) {
  console.error(
    'error: missing node_modules/@agent-pay/core — run `npm install` at the repository root.',
  );
  process.exit(1);
}

const viteBin = path.join(repoRoot, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) {
  console.error(
    'error: missing apps/web/node_modules/vite/bin/vite.js — run `pnpm -C apps/web install`.',
  );
  process.exit(1);
}

function checkPortFree(port, label) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `error: port ${port} (${label}) is already in use on 127.0.0.1 — stop the other process or set DEMO_API_PORT/DEMO_WEB_PORT`,
        );
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port, API_HOST, () => {
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve();
      });
    });
  });
}

await checkPortFree(API_PORT, 'api');
await checkPortFree(WEB_PORT, 'web');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pay-demo-'));
const LEDGER_PATH = path.join(tempDir, 'ledger.json');
console.log(`fresh ledger: ${LEDGER_PATH}`);

/** @type {import('node:child_process').ChildProcess | null} */
let apiChild = null;
/** @type {import('node:child_process').ChildProcess | null} */
let webChild = null;
let cleanupDone = false;
let shuttingDown = false;

function prefixLines(stream, prefix) {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      console.log(`${prefix}${line}`);
    }
  });
  stream.on('end', () => {
    if (buffer.length) console.log(`${prefix}${buffer}`);
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function killProcessGroup(child) {
  if (!child?.pid) return;
  const stillAlive = child.exitCode === null && child.signalCode === null;
  if (!stillAlive) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err;
  }
  await waitForExit(child, 4000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err;
    }
  }
}

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  shuttingDown = true;

  const apiPid = apiChild?.pid ?? '—';
  const webPid = webChild?.pid ?? '—';

  await killProcessGroup(apiChild);
  await killProcessGroup(webChild);

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(
    `cleaned up: stopped api (pid ${apiPid}) and web (pid ${webPid}), removed ${tempDir}`,
  );
}

function onUnexpectedChildExit(name, code, signal) {
  if (shuttingDown) return;
  const detail =
    signal != null ? `signal ${signal}` : code != null ? `code ${code}` : 'unknown exit';
  console.error(`error: ${name} exited unexpectedly (${detail})`);
  shuttingDown = true;
  cleanup().then(() => process.exit(1));
}

function shutdownAndExit(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanup().then(() => process.exit(code));
}

process.on('SIGINT', () => shutdownAndExit(0));
process.on('SIGTERM', () => shutdownAndExit(0));

process.on('uncaughtException', (err) => {
  console.error(err);
  shutdownAndExit(1);
});

process.on('unhandledRejection', (err) => {
  console.error(err);
  shutdownAndExit(1);
});

apiChild = spawn(
  process.execPath,
  [path.join('apps', 'api', 'src', 'main.ts')],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAIL: 'mock',
      LEDGER_PATH,
      PORT: String(API_PORT),
      HOST: API_HOST,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

prefixLines(apiChild.stdout, '[api] ');
prefixLines(apiChild.stderr, '[api] ');
apiChild.on('exit', (code, signal) => {
  if (shuttingDown) return;
  onUnexpectedChildExit('api', code, signal);
});

const healthDeadline = Date.now() + 15_000;
let apiReady = false;
while (Date.now() < healthDeadline) {
  if (shuttingDown) {
    await new Promise(() => {});
  }
  if (apiChild.exitCode !== null || apiChild.signalCode !== null) {
    shuttingDown = true;
    await cleanup();
    process.exit(1);
  }
  try {
    const res = await fetch(`http://${API_HOST}:${API_PORT}/health`);
    if (res.ok) {
      const body = await res.json();
      if (body?.ok === true) {
        apiReady = true;
        break;
      }
    }
  } catch {
    /* retry */
  }
  await new Promise((r) => setTimeout(r, 200));
}

if (!apiReady) {
  console.error('error: API health check timed out after 15s');
  shuttingDown = true;
  await cleanup();
  process.exit(1);
}

webChild = spawn(
  process.execPath,
  [
    path.join('node_modules', 'vite', 'bin', 'vite.js'),
    '--host',
    API_HOST,
    '--port',
    String(WEB_PORT),
    '--strictPort',
  ],
  {
    cwd: path.join(repoRoot, 'apps', 'web'),
    env: {
      ...process.env,
      VITE_API_BASE: `http://${API_HOST}:${API_PORT}`,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

prefixLines(webChild.stdout, '[web] ');
prefixLines(webChild.stderr, '[web] ');
webChild.on('exit', (code, signal) => {
  if (shuttingDown) return;
  onUnexpectedChildExit('web', code, signal);
});

const webUrl = `http://${API_HOST}:${WEB_PORT}/`;
const webDeadline = Date.now() + 30_000;
let webReady = false;
while (Date.now() < webDeadline) {
  if (shuttingDown) {
    await new Promise(() => {});
  }
  if (webChild.exitCode !== null || webChild.signalCode !== null) {
    shuttingDown = true;
    await cleanup();
    process.exit(1);
  }
  try {
    const res = await fetch(webUrl);
    if (res.status === 200) {
      webReady = true;
      break;
    }
  } catch {
    /* retry */
  }
  await new Promise((r) => setTimeout(r, 200));
}

if (!webReady) {
  console.error('error: web server did not respond with HTTP 200 within 30s');
  shuttingDown = true;
  await cleanup();
  process.exit(1);
}

console.log(
  `agent-pay demo ready: ${webUrl}  (api http://${API_HOST}:${API_PORT}, rail=mock, ledger ${LEDGER_PATH})`,
);
console.log('Press Ctrl+C to stop.');

setInterval(() => {}, 1 << 30);
