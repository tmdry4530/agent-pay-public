import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createMockAdapter, createServer, loadConfig } from '../src/index.ts';

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');
/** Same allowed origin as api.test.ts / hardening-origin.test.ts. */
const ALLOWED_ORIGIN = 'http://localhost:5173';

async function startTestServer(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  const now = () => new Date(FIXED_NOW);
  const server: Server = createServer({
    ledger: config.ledgerPath,
    adapter: createMockAdapter({ now }),
    now,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return { base, now };
}

/** Response Date plus a comma-separated Access-Control-Expose-Headers list that includes Date. */
function assertExposesDate(res: Response): void {
  const date = res.headers.get('date');
  assert.ok(typeof date === 'string', 'Date header missing');
  assert.ok(date.length > 0 && !Number.isNaN(Date.parse(date)), `Date header is not a date: ${date}`);
  const raw = res.headers.get('access-control-expose-headers');
  assert.ok(typeof raw === 'string', `Access-Control-Expose-Headers missing, got ${String(raw)}`);
  const names = raw.split(',').map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0);
  assert.ok(names.includes('date'), `Access-Control-Expose-Headers must include Date, got ${raw}`);
}

test('allowed Origin: GET /health and GET /ledger expose Date', async (t) => {
  const { base } = await startTestServer(t);
  const headers = { Origin: ALLOWED_ORIGIN };

  const health = await fetch(`${base}/health`, { headers });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assertExposesDate(health);
  assert.deepEqual(await health.json(), { ok: true, rail: 'mock' });

  const ledger = await fetch(`${base}/ledger`, { headers });
  assert.equal(ledger.status, 200);
  assert.equal(ledger.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assertExposesDate(ledger);
  const body = (await ledger.json()) as { entries: unknown[] };
  assert.ok(Array.isArray(body.entries));
});

test('allowed Origin: OPTIONS preflight for POST /intents exposes Date', async (t) => {
  const { base } = await startTestServer(t);

  const preflight = await fetch(`${base}/intents`, {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
  assertExposesDate(preflight);
});

test('allowed Origin: 404 error response exposes Date', async (t) => {
  const { base } = await startTestServer(t);

  const res = await fetch(`${base}/no-such-route`, { headers: { Origin: ALLOWED_ORIGIN } });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assertExposesDate(res);
  await res.json();
});

test('no Origin: Access-Control-Allow-Origin stays absent', async (t) => {
  const { base } = await startTestServer(t);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  await health.json();

  const ledger = await fetch(`${base}/ledger`);
  assert.equal(ledger.status, 200);
  assert.equal(ledger.headers.get('access-control-allow-origin'), null);
  await ledger.json();
});
