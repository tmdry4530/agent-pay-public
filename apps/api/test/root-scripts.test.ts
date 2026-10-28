// Root scripts that start the API: `npm run api` (package.json) and `npm run demo` (scripts/demo.mjs).
// Every run here uses a temp dir and a temp .env with non-secret values only; nothing calls PayPal or NEAR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '../../..');
const MAIN_REL = 'apps/api/src/main.ts';

/** Inherited env without rail settings, so a developer's shell cannot change the outcome. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(PAYPAL|NEAR)_|^(RAIL|DEMO_PAYEES|PORT|HOST|LEDGER_PATH)$/.test(k)),
  );
  return { ...base, ...extra };
}

interface Run {
  code: number | null;
  out: string;
}

/** Spawns a process and resolves on exit, or when `until` matches (then kills that one child). */
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, until?: RegExp): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let matched = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out; output so far:\n${out}`));
    }, 20_000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (until && !matched && until.test(out)) {
        matched = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: matched ? 0 : code, out });
    });
  });
}

async function tempDir(t: { after: (fn: () => Promise<void>) => void }, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** The `api` script's node args, with main.ts made absolute so it can run from a temp cwd. */
function apiScriptArgs(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const script = pkg.scripts.api;
  assert.ok(script, 'root package.json has an "api" script');
  const [bin, ...args] = script.split(/\s+/);
  assert.equal(bin, 'node');
  assert.ok(args.includes('--env-file-if-exists=.env'), 'api script loads .env only if it exists');
  return args.map((a) => (a === MAIN_REL ? join(REPO, MAIN_REL) : a));
}

test('npm run api: without .env it starts on the mock rail', async (t) => {
  const dir = await tempDir(t, 'agent-pay-api-noenv-');
  const r = await run(apiScriptArgs(), dir, cleanEnv({ PORT: '0', LEDGER_PATH: join(dir, 'ledger.json') }), /listening on/);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /agent-pay api listening on http:\/\/127\.0\.0\.1:\d+ \(rail=mock, /);
});

test('npm run api: reads .env when present (RAIL=near from the file, names-only error, exit 1)', async (t) => {
  const dir = await tempDir(t, 'agent-pay-api-env-');
  await writeFile(join(dir, '.env'), `RAIL=near\nPORT=0\nLEDGER_PATH=${join(dir, 'ledger.json')}\n`);
  const r = await run(apiScriptArgs(), dir, cleanEnv({}));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^missing required env vars for RAIL=near: NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY/m);
});

const haveDemoDeps =
  existsSync(join(REPO, 'node_modules/@agent-pay/core')) &&
  existsSync(join(REPO, 'apps/web/node_modules/vite/bin/vite.js'));

/** A temp "repo root" for scripts/demo.mjs: a copy of the script plus symlinks to the real code and deps. */
async function demoRoot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await tempDir(t, 'agent-pay-demo-test-');
  await mkdir(join(dir, 'scripts'));
  await copyFile(join(REPO, 'scripts/demo.mjs'), join(dir, 'scripts/demo.mjs'));
  for (const name of ['apps', 'packages', 'node_modules']) await symlink(join(REPO, name), join(dir, name));
  return dir;
}

async function demoEnv(extra: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  return cleanEnv({ DEMO_API_PORT: String(await freePort()), DEMO_WEB_PORT: String(await freePort()), ...extra });
}

test('npm run demo: RAIL=near without .env exits 1 with the names-only message, before the web app', { skip: !haveDemoDeps && 'demo deps not installed' }, async (t) => {
  const root = await demoRoot(t);
  const r = await run([join(root, 'scripts/demo.mjs')], root, await demoEnv({ RAIL: 'near' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^rail: near$/m);
  assert.match(r.out, /^\[api\] missing required env vars for RAIL=near: NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY$/m);
  assert.match(r.out, /^error: api exited unexpectedly \(code 1\)$/m);
  assert.match(r.out, /stopped api \(pid \d+\) and web \(pid —\)/);
  assert.doesNotMatch(r.out, /demo ready/);
});

test('npm run demo: passes a root .env to the API (only the missing name is listed)', { skip: !haveDemoDeps && 'demo deps not installed' }, async (t) => {
  const root = await demoRoot(t);
  // Non-secret value: proves the file reached the API, which then reports only the name still missing.
  await writeFile(join(root, '.env'), 'NEAR_ACCOUNT_ID=demo-sender.testnet\n');
  const r = await run([join(root, 'scripts/demo.mjs')], root, await demoEnv({ RAIL: 'near' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^rail: near \(api env file: \.env\)$/m);
  assert.match(r.out, /^\[api\] missing required env vars for RAIL=near: NEAR_PRIVATE_KEY$/m);
});

test('npm run demo: RAIL=paypal-orders is rejected by the API (unknown_rail, exit 1)', { skip: !haveDemoDeps && 'demo deps not installed' }, async (t) => {
  const root = await demoRoot(t);
  const r = await run([join(root, 'scripts/demo.mjs')], root, await demoEnv({ RAIL: 'paypal-orders' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /unknown_rail: RAIL must be one of mock\|paypal\|near/);
});
