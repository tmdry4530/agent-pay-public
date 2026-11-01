import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createPayPalAdapter } from '@agent-pay/adapters';
import type { Policy } from '@agent-pay/core';
import { createServer, loadConfig } from '../src/index.ts';
import { createReceiptPoller } from '../src/receipt-poller.ts';
import { PaymentError } from '@agent-pay/core';

const FIXED_NOW = new Date('2026-11-01T03:00:00.000Z');
const PAYEE = 'merchant@example.com';
const POLICY: Policy = {
  agentId: 'demo-agent',
  perTxMax: 100,
  dailyMax: 200,
  requireApprovalAbove: 50,
  currency: 'USD',
  allowedPayees: [PAYEE],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const batch = (batchStatus: string, itemStatus?: string) => ({
  batch_header: { payout_batch_id: 'BATCH-API', batch_status: batchStatus },
  items: itemStatus ? [{ payout_item_id: 'ITEM-API', transaction_status: itemStatus }] : [],
});

/** Mocked PayPal: POST payouts answers PENDING; each GET answers the next queued batch body (last one repeats). */
function mockedPayPalAdapter(batchBodies: unknown[]) {
  let gets = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/v1/oauth2/token')) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    if (method === 'POST') return jsonResponse(batch('PENDING'), 201);
    const body = batchBodies[Math.min(gets, batchBodies.length - 1)];
    gets += 1;
    return jsonResponse(body);
  };
  const adapter = createPayPalAdapter({ clientId: 'id', clientSecret: 'secret', fetch: fetchMock });
  return { adapter, getCount: () => gets };
}

async function start(
  t: { after: (fn: () => Promise<void>) => void },
  adapter: ReturnType<typeof createPayPalAdapter>,
  receiptPoll?: { intervalMs: number; timeoutMs: number },
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-batch-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  const server: Server = createServer({
    ledger: config.ledgerPath,
    adapter,
    policy: POLICY,
    now: () => new Date(FIXED_NOW),
    ...(receiptPoll ? { receiptPoll } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

const intentBody = (id: string) =>
  JSON.stringify({
    id,
    agentId: 'demo-agent',
    payee: PAYEE,
    amount: 10,
    currency: 'USD',
    purpose: 'batch status',
    createdAt: FIXED_NOW.toISOString(),
  });

async function ledgerEntry(base: string, id: string) {
  const ledger = (await (await fetch(`${base}/ledger`)).json()) as {
    entries: Array<{ intent: { id: string }; receipt?: { status: string; meta?: Record<string, string> } }>;
  };
  return ledger.entries.find((e) => e.intent.id === id);
}

test('refresh: PROCESSING batch keeps the receipt pending; the next refresh writes batchStatus SUCCESS', async (t) => {
  const { adapter } = mockedPayPalAdapter([batch('PROCESSING', 'SUCCESS'), batch('SUCCESS', 'SUCCESS')]);
  const base = await start(t, adapter);
  const created = await fetch(`${base}/intents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: intentBody('pi_batch_refresh') });
  assert.equal(created.status, 201);

  const r1 = (await (await fetch(`${base}/intents/pi_batch_refresh/refresh`, { method: 'POST' })).json()) as { receipt: { status: string } };
  assert.equal(r1.receipt.status, 'pending');
  assert.equal((await ledgerEntry(base, 'pi_batch_refresh'))?.receipt?.meta?.batchStatus, 'PENDING');

  const r2 = (await (await fetch(`${base}/intents/pi_batch_refresh/refresh`, { method: 'POST' })).json()) as { receipt: { status: string } };
  assert.equal(r2.receipt.status, 'succeeded');
  const entry = await ledgerEntry(base, 'pi_batch_refresh');
  assert.equal(entry?.receipt?.status, 'succeeded');
  assert.equal(entry?.receipt?.meta?.batchStatus, 'SUCCESS');
  assert.equal(entry?.receipt?.meta?.transactionStatus, 'SUCCESS');
});

test('receipt poller: no client refresh, the API settles the receipt and records batchStatus SUCCESS', async (t) => {
  const { adapter, getCount } = mockedPayPalAdapter([batch('PROCESSING', 'SUCCESS'), batch('SUCCESS', 'SUCCESS')]);
  const base = await start(t, adapter, { intervalMs: 10, timeoutMs: 5000 });
  const created = await fetch(`${base}/intents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: intentBody('pi_batch_poll') });
  assert.equal(created.status, 201);
  const deadline = Date.now() + 3000;
  let entry = await ledgerEntry(base, 'pi_batch_poll');
  while (entry?.receipt?.status === 'pending' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    entry = await ledgerEntry(base, 'pi_batch_poll');
  }
  assert.equal(entry?.receipt?.status, 'succeeded');
  assert.equal(entry?.receipt?.meta?.batchStatus, 'SUCCESS');
  const after = getCount();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(getCount(), after, 'poller stops once the receipt settled');
});

test('receipt poller: stops on receipt_not_pending and at the timeout; transient errors are retried', async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const settledElsewhere = createReceiptPoller({
    intervalMs: 5,
    timeoutMs: 1000,
    refresh: async () => {
      calls += 1;
      if (calls === 1) throw new Error('502 flaky');
      throw new PaymentError('receipt_not_pending', 'settled by a client refresh');
    },
    onError: (_id, err) => errors.push(err),
  });
  settledElsewhere.watch('a');
  settledElsewhere.watch('a');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(settledElsewhere.watching(), []);

  let pendingCalls = 0;
  let clock = 0;
  const timesOut = createReceiptPoller({
    intervalMs: 5,
    timeoutMs: 100,
    now: () => clock,
    refresh: async () => {
      pendingCalls += 1;
      clock += 60;
      return { receipt: { intentId: 'b', rail: 'paypal', externalId: 'X', status: 'pending', at: FIXED_NOW.toISOString() } };
    },
  });
  timesOut.watch('b');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(pendingCalls, 2);
  assert.deepEqual(timesOut.watching(), []);
  timesOut.stop();
  timesOut.watch('c');
  assert.deepEqual(timesOut.watching(), []);
});

test('loadConfig: RECEIPT_POLL_MS defaults on, 0 disables, bad values are rejected', () => {
  assert.deepEqual(loadConfig({}).receiptPoll, { intervalMs: 5000, timeoutMs: 600000 });
  assert.equal(loadConfig({ RECEIPT_POLL_MS: '0' }).receiptPoll, undefined);
  assert.deepEqual(loadConfig({ RECEIPT_POLL_MS: '2000', RECEIPT_POLL_TIMEOUT_MS: '30000' }).receiptPoll, {
    intervalMs: 2000,
    timeoutMs: 30000,
  });
  assert.throws(() => loadConfig({ RECEIPT_POLL_MS: 'soon' }), /invalid_receipt_poll_ms/);
  assert.throws(() => loadConfig({ RECEIPT_POLL_TIMEOUT_MS: '-1' }), /invalid_receipt_poll_timeout_ms/);
});
