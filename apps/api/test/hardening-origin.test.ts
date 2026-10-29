import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { PaymentAdapter, PaymentIntent, Receipt } from '@agent-pay/core';
import { createMockAdapter, createServer, loadConfig } from '../src/index.ts';

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');
const EVIL_ORIGIN = 'https://evil.example';

const baseIntent = (over: Record<string, unknown> = {}) => ({
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  ...over,
});

function createCountingMockAdapter(now: () => Date): { adapter: PaymentAdapter; counts: { payCalls: number } } {
  const counts = { payCalls: 0 };
  const inner = createMockAdapter({ now });
  const adapter: PaymentAdapter = {
    rail: inner.rail,
    async pay(intent: PaymentIntent): Promise<Receipt> {
      counts.payCalls += 1;
      return inner.pay(intent);
    },
    ...(inner.refund ? { refund: inner.refund.bind(inner) } : {}),
    ...(inner.status ? { status: inner.status.bind(inner) } : {}),
  };
  return { adapter, counts };
}

async function startTestServer(
  t: { after: (fn: () => Promise<void>) => void },
  adapter?: PaymentAdapter,
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-origin-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  const now = () => new Date(FIXED_NOW);
  const server: Server = createServer({
    ledger: config.ledgerPath,
    adapter: adapter ?? createMockAdapter({ now }),
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

async function readError(res: Response): Promise<{ error: string; message: string }> {
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  const body: unknown = await res.json();
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body));
  const record = body as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ['error', 'message']);
  assert.equal(typeof record.error, 'string');
  assert.equal(typeof record.message, 'string');
  const error = record.error as string;
  const message = record.message as string;
  assert.ok(error.length > 0 && !error.includes(':'));
  assert.ok(message.length > 0);
  return { error, message };
}

async function ledgerEntryCount(base: string): Promise<number> {
  const res = await fetch(`${base}/ledger`);
  assert.equal(res.status, 200);
  const ledger = (await res.json()) as { entries: unknown[] };
  return ledger.entries.length;
}

test('H1: POST /intents with disallowed Origin (text/plain) returns 403 and does not mutate ledger or pay', async (t) => {
  const now = () => new Date(FIXED_NOW);
  const { adapter, counts } = createCountingMockAdapter(now);
  const { base } = await startTestServer(t, adapter);

  const before = await ledgerEntryCount(base);

  const res = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: {
      Origin: EVIL_ORIGIN,
      'Content-Type': 'text/plain',
    },
    body: JSON.stringify(baseIntent({ id: 'pi_csrf_create' })),
  });

  assert.equal(res.status, 403);
  assert.equal((await readError(res)).error, 'forbidden_origin');
  assert.equal(await ledgerEntryCount(base), before);
  assert.equal(counts.payCalls, 0);
});

test('H1: POST /intents/:id/approve with disallowed Origin returns 403 and intent stays needs_approval', async (t) => {
  const { base } = await startTestServer(t);

  const createRes = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 80, id: 'pi_csrf_approve' })),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as { status: string };
  assert.equal(created.status, 'needs_approval');

  const approveRes = await fetch(`${base}/intents/pi_csrf_approve/approve`, {
    method: 'POST',
    headers: { Origin: EVIL_ORIGIN },
  });
  assert.equal(approveRes.status, 403);
  assert.equal((await readError(approveRes)).error, 'forbidden_origin');

  const getRes = await fetch(`${base}/ledger`);
  assert.equal(getRes.status, 200);
  const ledger = (await getRes.json()) as {
    entries: { intent: { id: string }; decision?: { status: string }; paymentStatus?: string }[];
  };
  const entry = ledger.entries.find((e) => e.intent.id === 'pi_csrf_approve');
  assert.ok(entry);
  assert.equal(entry.decision?.status, 'needs_approval');
  assert.equal(entry.paymentStatus, undefined);
});

test('H1: POST /intents/:id/resolve and /reject with disallowed Origin return 403', async (t) => {
  const { base } = await startTestServer(t);

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_csrf_resolve' })),
  });

  const resolveRes = await fetch(`${base}/intents/pi_csrf_resolve/resolve`, {
    method: 'POST',
    headers: { Origin: EVIL_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'failed', note: 'n', resolvedBy: 'ops' }),
  });
  assert.equal(resolveRes.status, 403);
  assert.equal((await readError(resolveRes)).error, 'forbidden_origin');

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 80, id: 'pi_csrf_reject' })),
  });

  const rejectRes = await fetch(`${base}/intents/pi_csrf_reject/reject`, {
    method: 'POST',
    headers: { Origin: EVIL_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approver: 'bob', note: 'nope' }),
  });
  assert.equal(rejectRes.status, 403);
  assert.equal((await readError(rejectRes)).error, 'forbidden_origin');
});

test('H1: Origin "null" string on POST returns 403', async (t) => {
  const { base } = await startTestServer(t);

  const res = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: {
      Origin: 'null',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(baseIntent({ id: 'pi_csrf_null_origin' })),
  });

  assert.equal(res.status, 403);
  assert.equal((await readError(res)).error, 'forbidden_origin');
});

test('H1: POST /intents with allowed Origin or no Origin still returns 201', async (t) => {
  const { base } = await startTestServer(t);

  const allowed = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:5173',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(baseIntent({ id: 'pi_allowed_origin' })),
  });
  assert.equal(allowed.status, 201);
  const allowedBody = (await allowed.json()) as { status: string };
  assert.equal(allowedBody.status, 'paid');

  const noOrigin = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_no_origin', amount: 11 })),
  });
  assert.equal(noOrigin.status, 201);
  const noOriginBody = (await noOrigin.json()) as { status: string };
  assert.equal(noOriginBody.status, 'paid');
});

test('H1: GET /ledger with disallowed Origin returns 200 without Access-Control-Allow-Origin', async (t) => {
  const { base } = await startTestServer(t);

  const res = await fetch(`${base}/ledger`, {
    headers: { Origin: EVIL_ORIGIN },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  const ledger = (await res.json()) as { entries: unknown[] };
  assert.ok(Array.isArray(ledger.entries));
});
