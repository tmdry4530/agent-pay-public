import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerError, PaymentError, reconcile, resolveIntent, runPayment, type PaymentAdapter, type Receipt } from '../src/index.ts';
import { NOW, basePolicy, makeIntent, newLedger, tempDir } from './helpers.ts';

const isPrecondition = (err: unknown) => err instanceof LedgerError && err.code === 'precondition_failed';
const approved = { status: 'approved', reason: 'within_policy: ok' } as const;

async function submittingLedger(t: Parameters<typeof tempDir>[0], amount = 10) {
  const ledger = newLedger(await tempDir(t));
  await ledger.recordIntent(makeIntent({ amount }));
  await ledger.recordDecision('pi-1', approved);
  await ledger.markSubmitting('pi-1', 'mock');
  return ledger;
}

test('F4: markSubmitting records status + submission, holds the limit, and is one-shot', async (t) => {
  const ledger = await submittingLedger(t);
  const entry = await ledger.get('pi-1');
  assert.equal(entry?.paymentStatus, 'submitting');
  assert.deepEqual(entry?.submission, { rail: 'mock', at: NOW });
  assert.equal(await ledger.dailyTotal('agent-1'), 10, 'a submitting payment holds the limit');
  await assert.rejects(ledger.markSubmitting('pi-1', 'mock'), isPrecondition, 'second submit');
  await assert.rejects(ledger.recordReceipt('pi-1', { intentId: 'pi-1', rail: 'mock', externalId: 'x', status: 'succeeded', at: NOW }), isPrecondition);

  await ledger.recordIntent(makeIntent({ id: 'held' }));
  await ledger.recordDecision('held', { status: 'needs_approval', reason: 'approval_required: x' });
  await assert.rejects(ledger.markSubmitting('held', 'mock'), isPrecondition, 'only approved intents are submitted');
});

test('F4: runPayment marks the entry submitting before adapter.pay and settles it after', async (t) => {
  const ledger = newLedger(await tempDir(t));
  let seen: string | undefined;
  const adapter: PaymentAdapter = {
    rail: 'mock',
    async pay(intent) {
      seen = (await ledger.get(intent.id))?.paymentStatus;
      return { intentId: intent.id, rail: 'mock', externalId: 'x-1', status: 'succeeded', at: NOW };
    },
  };
  const result = await runPayment(makeIntent(), basePolicy(), ledger, adapter);
  assert.equal(seen, 'submitting');
  assert.equal(result.status, 'paid');
  const entry = await ledger.get('pi-1');
  assert.equal(entry?.paymentStatus, 'paid');
  assert.equal(entry?.receipt?.externalId, 'x-1');
  assert.deepEqual(entry?.submission, { rail: 'mock', at: NOW });
});

test('F4: replaying a submitting entry (crash during pay) is in_progress and never re-sends', async (t) => {
  const ledger = await submittingLedger(t);
  let calls = 0;
  const adapter: PaymentAdapter = { rail: 'mock', async pay() { calls += 1; throw new Error('must not be called'); } };
  await assert.rejects(runPayment(makeIntent(), basePolicy(), ledger, adapter), (err: unknown) => err instanceof PaymentError && err.code === 'in_progress');
  assert.equal(calls, 0);
});

test('F4: reconcile skips submitting entries; resolve settles them', async (t) => {
  const ledger = await submittingLedger(t);
  let statusCalls = 0;
  const adapter: PaymentAdapter = {
    rail: 'mock',
    async pay() { throw new Error('no'); },
    async status(r: Receipt) { statusCalls += 1; return r; },
  };
  const summary = await reconcile(ledger, adapter);
  assert.equal(summary.checked, 0);
  assert.equal(statusCalls, 0);

  const out = await resolveIntent('pi-1', ledger, { status: 'succeeded', note: 'seen on rail dashboard', resolvedBy: 'ops', externalId: 'rail-123' }, () => new Date(NOW));
  assert.equal(out.status, 'paid');
  assert.deepEqual(out.receipt, { intentId: 'pi-1', rail: 'mock', externalId: 'rail-123', status: 'succeeded', at: NOW });
  assert.equal(out.resolution.previousExternalId, '');
  const entry = await ledger.get('pi-1');
  assert.equal(entry?.paymentStatus, 'paid');
  assert.equal(entry?.receipt?.status, 'succeeded');
});

test('F4: resolving a submitting entry as failed frees the limit', async (t) => {
  const ledger = await submittingLedger(t);
  const out = await resolveIntent('pi-1', ledger, { status: 'failed', note: 'never reached the rail', resolvedBy: 'ops' }, () => new Date(NOW));
  assert.equal(out.status, 'failed');
  assert.equal((await ledger.get('pi-1'))?.paymentStatus, 'failed');
  assert.equal(await ledger.dailyTotal('agent-1'), 0);
});

test('F4: recordPaymentResult settles a submitting entry atomically (payment + receipt in one write)', async (t) => {
  const ledger = await submittingLedger(t);
  const receipt: Receipt = { intentId: 'pi-1', rail: 'mock', externalId: 'x', status: 'pending', at: NOW };
  const entry = await ledger.recordPaymentResult('pi-1', { status: 'paid', receipt });
  assert.equal(entry.paymentStatus, 'paid');
  assert.deepEqual(entry.receipt, receipt);
  await assert.rejects(ledger.recordPaymentResult('pi-1', { status: 'paid', receipt }), isPrecondition, 'only from submitting');
});

test('F4: a ledger file holding a submitting entry loads in a fresh instance', async (t) => {
  const dir = await tempDir(t);
  const ledger = newLedger(dir);
  await ledger.recordIntent(makeIntent());
  await ledger.recordDecision('pi-1', approved);
  await ledger.markSubmitting('pi-1', 'paypal');
  const again = await newLedger(dir).get('pi-1');
  assert.equal(again?.paymentStatus, 'submitting');
});
