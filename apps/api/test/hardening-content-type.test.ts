import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { PaymentAdapter, PaymentIntent, Receipt } from '@agent-pay/core';
import { DEFAULT_POLICY, createMockAdapter, createServer, loadConfig } from '../src/index.ts';

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');

const baseIntent = (over: Record<string, unknown> = {}) => ({
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  ...over,
});

function createCountingMockAdapter(now: () => Date): { adapter: PaymentAdapter; get payCalls(): number } {
  let count = 0;
  const inner = createMockAdapter({ now });
  const adapter: PaymentAdapter = {
    rail: inner.rail,
    async pay(intent: PaymentIntent): Promise<Receipt> {
      count += 1;
      return inner.pay(intent);
    },
    ...(inner.refund ? { refund: inner.refund.bind(inner) } : {}),
    ...(inner.status ? { status: inner.status.bind(inner) } : {}),
  };
  return { adapter, get payCalls() { return count; } };
}

async function startTestServer(
  t: { after: (fn: () => Promise<void>) => void },
  adapter?: PaymentAdapter,
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-ct-'));
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
  return { base };
}

async function readError(res: Response): Promise<string> {
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  const body = (await res.json()) as { error?: string };
  assert.equal(typeof body.error, 'string');
  return body.error!;
}

async function ledgerEntryCount(base: string): Promise<number> {
  const res = await fetch(`${base}/ledger`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { entries: unknown[] };
  return body.entries.length;
}

test('M1: non-empty POST /intents without application/json returns 415 and no side effects', async (t) => {
  const counting = createCountingMockAdapter(() => new Date(FIXED_NOW));
  const { base } = await startTestServer(t, counting.adapter);
  const jsonBody = JSON.stringify(baseIntent());

  const cases: { label: string; headers: Record<string, string> }[] = [
    { label: 'text/plain', headers: { 'Content-Type': 'text/plain' } },
    { label: 'form-urlencoded', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    { label: 'missing Content-Type', headers: {} },
  ];

  for (const { label, headers } of cases) {
    const before = await ledgerEntryCount(base);
    const res = await fetch(`${base}/intents`, { method: 'POST', headers, body: jsonBody });
    assert.equal(res.status, 415, label);
    assert.match(await readError(res), /^unsupported_media_type: /);
    assert.equal(await ledgerEntryCount(base), before, label);
    assert.equal(counting.payCalls, 0, label);
  }
});

test('M1: application/json and charset variant still accepted on POST /intents', async (t) => {
  const { base } = await startTestServer(t);
  const body = JSON.stringify(baseIntent());

  for (const ct of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) {
    const res = await fetch(`${base}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': ct },
      body,
    });
    assert.equal(res.status, 201, ct);
  }
});

test('M1: empty-body POSTs without Content-Type still work', async (t) => {
  const pendingAdapter: PaymentAdapter = {
    rail: 'mock',
    async pay(intent: PaymentIntent): Promise<Receipt> {
      return {
        intentId: intent.id,
        rail: 'mock',
        externalId: `mock_${intent.id}`,
        status: 'pending',
        at: FIXED_NOW.toISOString(),
      };
    },
    async status(receipt: Receipt): Promise<Receipt> {
      return { ...receipt, status: 'pending' };
    },
  };
  const { base } = await startTestServer(t, pendingAdapter);

  const created = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_ct_refresh' })),
  });
  assert.equal(created.status, 201);

  const refresh = await fetch(`${base}/intents/pi_ct_refresh/refresh`, { method: 'POST' });
  assert.equal(refresh.status, 200);

  const queued = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 80, id: 'pi_ct_empty_approve' })),
  });
  assert.equal(queued.status, 201);
  const approve = await fetch(`${base}/intents/pi_ct_empty_approve/approve`, { method: 'POST' });
  assert.equal(approve.status, 200);
  const approved = (await approve.json()) as { status: string };
  assert.equal(approved.status, 'paid');
});

test('M1: PUT /policy with text/plain returns 415 and policy unchanged', async (t) => {
  const { base } = await startTestServer(t);
  const before = await fetch(`${base}/policy`);
  assert.deepEqual(await before.json(), DEFAULT_POLICY);

  const res = await fetch(`${base}/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ ...DEFAULT_POLICY, perTxMax: 999 }),
  });
  assert.equal(res.status, 415);
  assert.match(await readError(res), /^unsupported_media_type: /);

  const after = await fetch(`${base}/policy`);
  assert.deepEqual(await after.json(), DEFAULT_POLICY);
});

test('M1: non-empty approve body with wrong Content-Type returns 415 and intent stays pending', async (t) => {
  const counting = createCountingMockAdapter(() => new Date(FIXED_NOW));
  const { base } = await startTestServer(t, counting.adapter);

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 80, id: 'pi_ct_pending' })),
  });

  const res = await fetch(`${base}/intents/pi_ct_pending/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ approver: 'alice' }),
  });
  assert.equal(res.status, 415);
  assert.match(await readError(res), /^unsupported_media_type: /);
  assert.equal(counting.payCalls, 0);

  const ledger = await fetch(`${base}/ledger`);
  const body = (await ledger.json()) as {
    entries: { intent: { id: string }; decision: { status: string } }[];
  };
  const entry = body.entries.find((e) => e.intent.id === 'pi_ct_pending');
  assert.equal(entry?.decision.status, 'needs_approval');
});
