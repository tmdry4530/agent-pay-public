import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger,
  PaymentError,
  reconcile,
  refreshIntent,
  runPayment,
  type PaymentAdapter,
  type PaymentIntent,
  type Policy,
  type Rail,
  type Receipt,
} from '../src/index.ts';

const NOW = '2026-10-28T12:00:00.000Z';

const policy: Policy = {
  agentId: 'agent-1',
  perTxMax: 100,
  dailyMax: 150,
  allowedPayees: ['openai-api'],
  requireApprovalAbove: 50,
};

const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: 'pi-1',
  agentId: 'agent-1',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  createdAt: '2026-10-28T10:00:00.000Z',
  ...over,
});

const pendingReceipt = (intentId: string, over: Partial<Receipt> = {}): Receipt => ({
  intentId,
  rail: 'mock',
  externalId: `ext-${intentId}`,
  status: 'pending',
  at: NOW,
  ...over,
});

class StatusAdapter implements PaymentAdapter {
  readonly rail: Rail = 'mock';
  statusCalls = 0;
  readonly onStatus: (receipt: Receipt, call: number) => Receipt | Promise<Receipt>;
  readonly onPay?: (intent: PaymentIntent) => Receipt | Promise<Receipt>;
  constructor(
    onStatus: (receipt: Receipt, call: number) => Receipt | Promise<Receipt>,
    onPay?: (intent: PaymentIntent) => Receipt | Promise<Receipt>,
  ) {
    this.onStatus = onStatus;
    this.onPay = onPay;
  }
  async pay(i: PaymentIntent): Promise<Receipt> {
    if (this.onPay) return this.onPay(i);
    return pendingReceipt(i.id);
  }
  async status(receipt: Receipt): Promise<Receipt> {
    this.statusCalls += 1;
    return this.onStatus(receipt, this.statusCalls);
  }
}

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'ledger.json');
  return { filePath, ledger: new Ledger({ filePath, now: () => new Date(NOW) }) };
}

async function recordPendingPaid(ledger: Ledger, i: PaymentIntent, receipt: Receipt): Promise<void> {
  await ledger.recordIntent(i);
  await ledger.recordDecision(i.id, { status: 'approved', reason: 'within_policy: test' });
  await ledger.recordPayment(i.id, 'paid');
  await ledger.recordReceipt(i.id, receipt);
}

test('reconcile: pending -> succeeded', async (t) => {
  const { ledger, filePath } = await setup(t);
  const i = intent();
  await recordPendingPaid(ledger, i, pendingReceipt(i.id));
  const adapter = new StatusAdapter((r) => ({ ...r, status: 'succeeded' }));
  const summary = await reconcile(ledger, adapter);
  assert.equal(summary.supported, true);
  assert.equal(summary.checked, 1);
  assert.deepEqual(summary.updated, [{ intentId: i.id, from: 'pending', to: 'succeeded' }]);
  const entry = await ledger.get(i.id);
  assert.equal(entry?.receipt?.status, 'succeeded');
  assert.equal(entry?.paymentStatus, 'paid');
  const bytes = await readFile(filePath, 'utf8');
  assert.ok(bytes.includes('succeeded'));
  // succeeded (like pending before it) still counts toward the daily total
  assert.equal(await ledger.dailyTotal('agent-1', '2026-10-28'), 10);
});

test('reconcile: pending -> failed drops daily total and replay reports failed', async (t) => {
  const { ledger } = await setup(t);
  const i = intent({ amount: 25 });
  await recordPendingPaid(ledger, i, pendingReceipt(i.id));
  assert.equal(await ledger.dailyTotal('agent-1'), 25);
  const adapter = new StatusAdapter((r) => ({ ...r, status: 'failed' }));
  await reconcile(ledger, adapter);
  assert.equal(await ledger.dailyTotal('agent-1'), 0);
  const entry = await ledger.get(i.id);
  assert.equal(entry?.paymentStatus, 'failed');
  const replay = await runPayment(i, policy, ledger, new StatusAdapter(() => pendingReceipt(i.id)));
  assert.equal(replay.status, 'failed');
  assert.equal(replay.replayed, true);
});

test('reconcile: unchanged pending writes nothing', async (t) => {
  const { ledger, filePath } = await setup(t);
  const i = intent();
  await recordPendingPaid(ledger, i, pendingReceipt(i.id));
  const before = await readFile(filePath, 'utf8');
  const beforeUpdated = (await ledger.get(i.id))!.updatedAt;
  const adapter = new StatusAdapter((r) => ({ ...r, status: 'pending' }));
  const summary = await reconcile(ledger, adapter);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.updated.length, 0);
  const after = await readFile(filePath, 'utf8');
  assert.equal(after, before);
  assert.equal((await ledger.get(i.id))!.updatedAt, beforeUpdated);
});

test('reconcile: idempotent second run', async (t) => {
  const { ledger, filePath } = await setup(t);
  const i = intent();
  await recordPendingPaid(ledger, i, pendingReceipt(i.id));
  const adapter = new StatusAdapter((r) => ({ ...r, status: 'succeeded' }));
  await reconcile(ledger, adapter);
  const afterFirst = await readFile(filePath, 'utf8');
  const callsAfterFirst = adapter.statusCalls;
  const second = await reconcile(ledger, adapter);
  assert.equal(second.checked, 0);
  assert.equal(adapter.statusCalls, callsAfterFirst);
  assert.deepEqual(second.updated, []);
  assert.equal(await readFile(filePath, 'utf8'), afterFirst);
});

test('reconcile: mismatched receipt (intentId, rail, status) -> error items, nothing stored', async (t) => {
  const { ledger, filePath } = await setup(t);
  for (const id of ['m-id', 'm-rail', 'm-status']) await recordPendingPaid(ledger, intent({ id }), pendingReceipt(id));
  const before = await readFile(filePath, 'utf8');
  const adapter = new StatusAdapter((r): Receipt => {
    if (r.intentId === 'm-id') return { ...r, intentId: 'wrong', status: 'succeeded' };
    if (r.intentId === 'm-rail') return { ...r, rail: 'paypal', status: 'succeeded' };
    return { ...r, status: 'refunded' };
  });
  const summary = await reconcile(ledger, adapter);
  assert.equal(summary.checked, 3);
  assert.deepEqual(summary.updated, []);
  assert.deepEqual(
    summary.errors.map((e) => e.intentId),
    ['m-id', 'm-rail', 'm-status'],
  );
  for (const e of summary.errors) assert.match(e.error, /^receipt_mismatch:/);
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('reconcile: adapter.status throws -> error item, others still processed', async (t) => {
  const { ledger } = await setup(t);
  await recordPendingPaid(ledger, intent({ id: 'a' }), pendingReceipt('a'));
  await recordPendingPaid(ledger, intent({ id: 'b' }), pendingReceipt('b'));
  const adapter = new StatusAdapter((r) => {
    if (r.intentId === 'a') throw new Error('boom');
    return { ...r, status: 'succeeded' };
  });
  const summary = await reconcile(ledger, adapter);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0]!.error, /^adapter_error: boom/);
  assert.equal((await ledger.get('a'))!.receipt?.status, 'pending');
  assert.equal((await ledger.get('b'))!.receipt?.status, 'succeeded');
});

test('reconcile: adapter without status -> supported false', async (t) => {
  const { ledger } = await setup(t);
  await recordPendingPaid(ledger, intent(), pendingReceipt('pi-1'));
  const adapter: PaymentAdapter = {
    rail: 'mock',
    async pay(i) {
      return pendingReceipt(i.id);
    },
  };
  const summary = await reconcile(ledger, adapter);
  assert.equal(summary.supported, false);
  assert.equal(summary.checked, 0);
});

test('reconcile: skips other rails', async (t) => {
  const { ledger } = await setup(t);
  await recordPendingPaid(ledger, intent(), pendingReceipt('pi-1', { rail: 'paypal' }));
  const adapter = new StatusAdapter((r) => ({ ...r, status: 'succeeded' }));
  const summary = await reconcile(ledger, adapter);
  assert.equal(summary.checked, 0);
  assert.equal((await ledger.get('pi-1'))!.receipt?.status, 'pending');
});

test('refreshIntent happy path and PaymentError codes', async (t) => {
  const { ledger } = await setup(t);
  const i = intent();
  await recordPendingPaid(ledger, i, pendingReceipt(i.id));
  const adapter = new StatusAdapter((r) => ({ ...r, status: 'succeeded' }));
  const ok = await refreshIntent(i.id, ledger, adapter);
  assert.equal(ok.changed, true);
  assert.equal(ok.status, 'paid');

  await assert.rejects(refreshIntent('missing', ledger, adapter), (e: unknown) => e instanceof PaymentError && e.code === 'intent_not_found');

  await ledger.recordIntent(intent({ id: 'rej' }));
  await ledger.recordDecision('rej', { status: 'rejected', reason: 'payee_not_allowed: x' });
  await assert.rejects(refreshIntent('rej', ledger, adapter), (e: unknown) => e instanceof PaymentError && e.code === 'no_receipt');

  await recordPendingPaid(ledger, intent({ id: 'done' }), pendingReceipt('done'));
  await ledger.settleReceipt('done', { ...pendingReceipt('done'), status: 'succeeded' });
  await assert.rejects(refreshIntent('done', ledger, adapter), (e: unknown) => e instanceof PaymentError && e.code === 'receipt_not_pending');

  await recordPendingPaid(ledger, intent({ id: 'pend2' }), pendingReceipt('pend2'));
  const noStatus: PaymentAdapter = { rail: 'mock', async pay(x) { return pendingReceipt(x.id); } };
  await assert.rejects(refreshIntent('pend2', ledger, noStatus), (e: unknown) => e instanceof PaymentError && e.code === 'status_unsupported');

  await recordPendingPaid(ledger, intent({ id: 'bad' }), pendingReceipt('bad'));
  const bad = new StatusAdapter(() => {
    throw new Error('status blew up');
  });
  await assert.rejects(refreshIntent('bad', ledger, bad), (e: unknown) => e instanceof PaymentError && e.code === 'status_check_failed');
});
