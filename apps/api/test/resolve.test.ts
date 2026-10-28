import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { PaymentAdapter, PaymentIntent, Receipt } from '@agent-pay/core';
import { createServer, loadConfig } from '../src/index.ts';

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');

const baseIntent = (over: Record<string, unknown> = {}) => ({
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  createdAt: FIXED_NOW.toISOString(),
  ...over,
});

function createPayPalManualResolveAdapter(): { adapter: PaymentAdapter; counts: { payCalls: number; statusCalls: number } } {
  const counts = { payCalls: 0, statusCalls: 0 };
  const adapter: PaymentAdapter = {
    rail: 'paypal',
    async pay(intent: PaymentIntent): Promise<Receipt> {
      counts.payCalls += 1;
      return {
        intentId: intent.id,
        rail: 'paypal',
        externalId: '',
        status: 'pending',
        at: FIXED_NOW.toISOString(),
        meta: {
          unknownOutcome: 'true',
          needsManualResolve: 'true',
          duplicateSenderBatchId: 'true',
          errorName: 'DUPLICATE_ITEM',
        },
      } as Receipt; // PayPal adapter receipts carry meta at runtime (AdapterReceipt)
    },
    async status(receipt: Receipt): Promise<Receipt> {
      counts.statusCalls += 1;
      return receipt;
    },
  };
  return { adapter, counts };
}

async function startServer(
  t: { after: (fn: () => Promise<void>) => void },
  adapter: PaymentAdapter,
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-resolve-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  const now = () => new Date(FIXED_NOW);
  const server: Server = createServer({ ledger: config.ledgerPath, adapter, now });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return base;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? '';
}

type LedgerBody = {
  entries: {
    intent: { id: string };
    receipt?: Receipt & { meta?: Record<string, string> };
    resolution?: { note: string; resolvedBy: string; previousExternalId: string };
  }[];
  today: { totals: Record<string, number> };
};

test('resolve happy paths and adapter isolation', async (t) => {
  const { adapter, counts } = createPayPalManualResolveAdapter();
  const base = await startServer(t, adapter);

  const create = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_fail_resolve' })),
  });
  assert.equal(create.status, 201);
  const baselinePay = counts.payCalls;
  assert.equal(counts.statusCalls, 0);

  const ledgerBeforeFail = (await (await fetch(`${base}/ledger`)).json()) as LedgerBody;
  assert.equal(ledgerBeforeFail.today.totals['demo-agent'], 10);

  const failRes = await fetch(`${base}/intents/pi_fail_resolve/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'failed', note: 'duplicate batch id', resolvedBy: 'ops' }),
  });
  assert.equal(failRes.status, 200);
  const failed = (await failRes.json()) as {
    status: string;
    receipt: { status: string; meta?: Record<string, string> };
    resolution: { resolvedBy: string; note: string };
  };
  assert.equal(failed.status, 'failed');
  assert.equal(failed.receipt.status, 'failed');
  assert.equal(failed.resolution.resolvedBy, 'ops');
  assert.equal(failed.resolution.note, 'duplicate batch id');
  assert.equal(failed.receipt.meta?.needsManualResolve, 'true');
  assert.equal(counts.payCalls, baselinePay);
  assert.equal(counts.statusCalls, 0);

  const ledgerAfterFail = (await (await fetch(`${base}/ledger`)).json()) as LedgerBody;
  assert.equal(ledgerAfterFail.today.totals['demo-agent'], undefined);
  const failEntry = ledgerAfterFail.entries.find((e) => e.intent.id === 'pi_fail_resolve');
  assert.ok(failEntry?.resolution);
  assert.equal(failEntry?.receipt?.meta?.needsManualResolve, 'true');

  const create2 = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_ok_resolve' })),
  });
  assert.equal(create2.status, 201);
  assert.equal(counts.payCalls, baselinePay + 1);

  const ledgerBeforeOk = (await (await fetch(`${base}/ledger`)).json()) as LedgerBody;
  assert.equal(ledgerBeforeOk.today.totals['demo-agent'], 10);

  const okRes = await fetch(`${base}/intents/pi_ok_resolve/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'succeeded',
      note: 'confirmed in PayPal dashboard',
      externalId: 'BATCH-1',
      resolvedBy: 'alice',
    }),
  });
  assert.equal(okRes.status, 200);
  const ok = (await okRes.json()) as {
    status: string;
    receipt: { status: string; externalId: string };
    resolution: { resolvedBy: string; previousExternalId: string };
  };
  assert.equal(ok.status, 'paid');
  assert.equal(ok.receipt.status, 'succeeded');
  assert.equal(ok.receipt.externalId, 'BATCH-1');
  assert.equal(ok.resolution.resolvedBy, 'alice');
  assert.equal(ok.resolution.previousExternalId, '');
  assert.equal(counts.payCalls, baselinePay + 1);
  assert.equal(counts.statusCalls, 0);

  const ledgerAfterOk = (await (await fetch(`${base}/ledger`)).json()) as LedgerBody;
  assert.equal(ledgerAfterOk.today.totals['demo-agent'], 10);

  const create3 = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_refund_resolve' })),
  });
  assert.equal(create3.status, 201);
  const ledgerBeforeRefund = (await (await fetch(`${base}/ledger`)).json()) as LedgerBody;
  assert.equal(ledgerBeforeRefund.today.totals['demo-agent'], 20);

  const refundRes = await fetch(`${base}/intents/pi_refund_resolve/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'refunded', note: 'chargeback settled', resolvedBy: 'ops' }),
  });
  assert.equal(refundRes.status, 200);
  assert.equal(counts.payCalls, baselinePay + 2);
  assert.equal(counts.statusCalls, 0);

  const ledgerAfterRefund = (await (await fetch(`${base}/ledger`)).json()) as LedgerBody;
  assert.equal(ledgerAfterRefund.today.totals['demo-agent'], 20);

  const again = await fetch(`${base}/intents/pi_ok_resolve/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'failed', note: 'too late', resolvedBy: 'ops' }),
  });
  assert.equal(again.status, 409);
  assert.match(await readError(again), /^receipt_not_pending: /);
  assert.equal(counts.payCalls, baselinePay + 2);
  assert.equal(counts.statusCalls, 0);
});

test('resolve errors: 404, no_receipt, already succeeded, validation', async (t) => {
  const { adapter, counts } = createPayPalManualResolveAdapter();
  const base = await startServer(t, adapter);

  const missing = await fetch(`${base}/intents/nope/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'succeeded', note: 'x', resolvedBy: 'ops' }),
  });
  assert.equal(missing.status, 404);
  assert.match(await readError(missing), /^intent_not_found: /);
  assert.equal(counts.statusCalls, 0);

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 60, id: 'pi_needs_approval' })),
  });
  const noReceipt = await fetch(`${base}/intents/pi_needs_approval/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'succeeded', note: 'x', resolvedBy: 'ops' }),
  });
  assert.equal(noReceipt.status, 409);
  assert.match(await readError(noReceipt), /^no_receipt: /);

  const succeededAdapter: PaymentAdapter = {
    rail: 'mock',
    async pay(intent) {
      return {
        intentId: intent.id,
        rail: 'mock',
        externalId: 'done',
        status: 'succeeded',
        at: FIXED_NOW.toISOString(),
      };
    },
  };
  const baseDone = await startServer(t, succeededAdapter);
  await fetch(`${baseDone}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_already_done' })),
  });
  const settled = await fetch(`${baseDone}/intents/pi_already_done/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'succeeded', note: 'x', resolvedBy: 'ops' }),
  });
  assert.equal(settled.status, 409);
  assert.match(await readError(settled), /^receipt_not_pending: /);

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_validation' })),
  });
  const baselinePay = counts.payCalls;
  const ledgerSnap = (await (await fetch(`${base}/ledger`)).json()) as LedgerBody;

  const badCases: RequestInit[] = [
    { method: 'POST' },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending', note: 'n', resolvedBy: 'ops' }),
    },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'bogus', note: 'n', resolvedBy: 'ops' }),
    },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded', resolvedBy: 'ops' }),
    },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded', note: '   ', resolvedBy: 'ops' }),
    },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded', note: 'n', resolvedBy: 'ops', extra: true }),
    },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded', note: 'n', resolvedBy: '' }),
    },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded', note: 'n' }),
    },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded', note: 'n', resolvedBy: '   ' }),
    },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded', note: 'n', resolvedBy: 'x'.repeat(129) }),
    },
  ];

  for (const init of badCases) {
    const res = await fetch(`${base}/intents/pi_validation/resolve`, init);
    assert.equal(res.status, 400);
    assert.match(await readError(res), /^invalid_body: /);
    assert.equal(counts.payCalls, baselinePay);
    assert.equal(counts.statusCalls, 0);
    const ledgerNow = (await (await fetch(`${base}/ledger`)).json()) as LedgerBody;
    assert.deepEqual(ledgerNow, ledgerSnap);
  }

  const maxLen = await fetch(`${base}/intents/pi_validation/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'succeeded', note: 'n', resolvedBy: 'x'.repeat(128) }),
  });
  assert.equal(maxLen.status, 200);
  assert.equal(((await maxLen.json()) as { resolution: { resolvedBy: string } }).resolution.resolvedBy, 'x'.repeat(128));
  assert.equal(counts.payCalls, baselinePay);
  assert.equal(counts.statusCalls, 0);
});
