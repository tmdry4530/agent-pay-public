import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { PaymentAdapter, PaymentIntent, Receipt } from '@agent-pay/core';
import { createMockAdapter, createServer, loadConfig } from '../src/index.ts';

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');
const INTENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Each call returns a time `stepMs` later — reproduces retry-later createdAt drift. */
function createAdvancingNow(start: Date = FIXED_NOW, stepMs = 1000): () => Date {
  let ms = start.getTime();
  return () => {
    const d = new Date(ms);
    ms += stepMs;
    return d;
  };
}

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
  now: () => Date = () => new Date(FIXED_NOW),
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-idem-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
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

async function readError(res: Response): Promise<string> {
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  const body = (await res.json()) as { error?: string };
  assert.equal(typeof body.error, 'string');
  return body.error!;
}

function postIntent(
  base: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('H2: no id and no Idempotency-Key — new intent id each request (201)', async (t) => {
  const now = () => new Date(FIXED_NOW);
  const { adapter, counts } = createCountingMockAdapter(now);
  const { base } = await startTestServer(t, adapter);
  const body = baseIntent({ amount: 12 });

  const first = await postIntent(base, body);
  const second = await postIntent(base, body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const a = (await first.json()) as { intent: { id: string } };
  const b = (await second.json()) as { intent: { id: string } };
  assert.match(a.intent.id, /^pi_/);
  assert.match(b.intent.id, /^pi_/);
  assert.notEqual(a.intent.id, b.intent.id);
  assert.equal(counts.payCalls, 2);
});

test('H2: first create returns 201 with intent id and createdAt', async (t) => {
  const { base } = await startTestServer(t);
  const res = await postIntent(base, baseIntent({ amount: 10 }), { 'Idempotency-Key': 'client-key-1' });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    status: string;
    intent: { id: string; createdAt: string };
  };
  assert.equal(body.status, 'paid');
  assert.match(body.intent.id, INTENT_ID_RE);
  assert.equal(body.intent.createdAt, FIXED_NOW.toISOString());
});

test('H2: invalid Idempotency-Key returns 400 invalid_header', async (t) => {
  const { base } = await startTestServer(t);

  for (const key of ['', '!!!', 'x'.repeat(129)]) {
    const res = await postIntent(base, baseIntent(), { 'Idempotency-Key': key });
    assert.equal(res.status, 400, `key=${JSON.stringify(key)}`);
    assert.match(await readError(res), /^invalid_header: /);
  }
});

test('H2: Idempotency-Key and body id must match when both present', async (t) => {
  const { base } = await startTestServer(t);

  const mismatch = await postIntent(base, baseIntent({ id: 'pi_body' }), {
    'Idempotency-Key': 'other-key',
  });
  assert.equal(mismatch.status, 400);
  assert.match(await readError(mismatch), /^invalid_body: /);

  const match = await postIntent(base, baseIntent({ id: 'pi_same' }), {
    'Idempotency-Key': 'pi_same',
  });
  assert.equal(match.status, 201);
});

test('H2: same Idempotency-Key derives stable intent id', async (t) => {
  const { base } = await startTestServer(t);
  const key = 'retry-key-alpha';
  const payload = baseIntent({ amount: 14 });

  const r1 = await postIntent(base, payload, { 'Idempotency-Key': key });
  const r2 = await postIntent(base, payload, { 'Idempotency-Key': key });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);

  const j1 = (await r1.json()) as { intent: { id: string }; replayed?: boolean };
  const j2 = (await r2.json()) as { intent: { id: string }; replayed?: boolean };
  assert.equal(j1.replayed, undefined);
  assert.equal(j2.replayed, true);
  assert.equal(j1.intent.id, j2.intent.id);
  assert.match(j1.intent.id, INTENT_ID_RE);
});

test('H2: Idempotency-Key retry pays once (replayed 200)', async (t) => {
  const now = createAdvancingNow();
  const { adapter, counts } = createCountingMockAdapter(now);
  const { base } = await startTestServer(t, adapter, now);
  const key = 'pay-once-key';
  const payload = baseIntent({ amount: 11 });

  assert.equal((await postIntent(base, payload, { 'Idempotency-Key': key })).status, 201);
  const replay = await postIntent(base, payload, { 'Idempotency-Key': key });
  assert.equal(replay.status, 200);
  const body = (await replay.json()) as { replayed?: boolean; intent: { id: string } };
  assert.equal(body.replayed, true);
  assert.equal(counts.payCalls, 1);
});

test('H2: body id without createdAt — identical retry replays (not 409)', async (t) => {
  const now = createAdvancingNow();
  const { adapter, counts } = createCountingMockAdapter(now);
  const { base } = await startTestServer(t, adapter, now);
  const payload = baseIntent({ id: 'pi_no_created_at', amount: 13 });

  assert.equal((await postIntent(base, payload)).status, 201);
  const second = await postIntent(base, payload);
  assert.equal(second.status, 200);
  const body = (await second.json()) as { replayed?: boolean; intent: { id: string } };
  assert.equal(body.replayed, true);
  assert.equal(body.intent.id, 'pi_no_created_at');
  assert.equal(counts.payCalls, 1);
});

test('H2: same Idempotency-Key with different body returns intent_conflict', async (t) => {
  const { base } = await startTestServer(t);
  const key = 'conflict-key';

  assert.equal(
    (await postIntent(base, baseIntent({ amount: 10 }), { 'Idempotency-Key': key })).status,
    201,
  );

  const conflict = await postIntent(base, baseIntent({ amount: 11 }), { 'Idempotency-Key': key });
  assert.equal(conflict.status, 409);
  assert.match(await readError(conflict), /^intent_conflict:/);
});

test('H2: same body id without createdAt but different amount returns intent_conflict', async (t) => {
  const { base } = await startTestServer(t);

  assert.equal((await postIntent(base, baseIntent({ id: 'pi_conflict_amt', amount: 10 }))).status, 201);

  const conflict = await postIntent(base, baseIntent({ id: 'pi_conflict_amt', amount: 11 }));
  assert.equal(conflict.status, 409);
  assert.match(await readError(conflict), /^intent_conflict:/);
});

test('H2: needs_approval intent retried with same Idempotency-Key replays', async (t) => {
  const now = createAdvancingNow();
  const { adapter, counts } = createCountingMockAdapter(now);
  const { base } = await startTestServer(t, adapter, now);
  const key = 'needs-approval-key';
  const payload = baseIntent({ amount: 80 });

  const first = await postIntent(base, payload, { 'Idempotency-Key': key });
  assert.equal(first.status, 201);
  const created = (await first.json()) as { status: string; intent: { id: string } };
  assert.equal(created.status, 'needs_approval');

  const second = await postIntent(base, payload, { 'Idempotency-Key': key });
  assert.equal(second.status, 200);
  const replay = (await second.json()) as {
    status: string;
    replayed?: boolean;
    intent: { id: string };
  };
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 'needs_approval');
  assert.equal(replay.intent.id, created.intent.id);
  assert.equal(counts.payCalls, 0);
});
