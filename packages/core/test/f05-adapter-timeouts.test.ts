import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAY_TIMEOUT_MS, DEFAULT_STATUS_TIMEOUT_MS, PaymentError, approve, reconcile, refreshIntent, runPayment,
  type PaymentAdapter, type Receipt,
} from '../src/index.ts';
import { NOW, basePolicy, makeIntent, newLedger, sleep, tempDir } from './helpers.ts';

const hanging = (settleAfterMs?: number): PaymentAdapter => ({
  rail: 'mock',
  pay: (i) => new Promise<Receipt>((resolve) => {
    if (settleAfterMs !== undefined) setTimeout(() => resolve({ intentId: i.id, rail: 'mock', externalId: 'late', status: 'succeeded', at: NOW }), settleAfterMs);
  }),
});

test('F5: documented defaults', () => {
  assert.equal(DEFAULT_PAY_TIMEOUT_MS, 60_000);
  assert.equal(DEFAULT_STATUS_TIMEOUT_MS, 45_000);
});

test('F5: a pay timeout is handled like F3 (pending + needsManualResolve, limit held); a late answer writes nothing', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const started = Date.now();
  const result = await runPayment(makeIntent({ amount: 25 }), basePolicy(), ledger, hanging(60), { payTimeoutMs: 20 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.status, 'paid');
  assert.equal(result.needsManualResolve, true);
  assert.match(result.error ?? '', /^adapter_timeout: adapter\.pay did not settle within 20ms/);
  assert.equal(await ledger.dailyTotal('agent-1'), 25);
  await sleep(80); // the adapter answers after the timeout
  const entry = await ledger.get('pi-1');
  assert.equal(entry?.receipt?.externalId, '', 'late receipt is ignored, not stored');
  assert.equal(entry?.needsManualResolve, true);
});

test('F5: approve passes payTimeoutMs through', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const first = await runPayment(makeIntent({ amount: 150 }), basePolicy({ perTxMax: 200, requireApprovalAbove: 100 }), ledger, hanging());
  assert.equal(first.status, 'needs_approval');
  const result = await approve('pi-1', { policy: basePolicy({ perTxMax: 200, requireApprovalAbove: 100 }), ledger, adapter: hanging(), payTimeoutMs: 15 });
  assert.equal(result.needsManualResolve, true);
  assert.match(result.error ?? '', /^adapter_timeout: /);
});

test('F5: a status timeout skips that entry and reconcile continues; refresh reports status_check_failed', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const pendingAdapter: PaymentAdapter = {
    rail: 'mock',
    async pay(i) { return { intentId: i.id, rail: 'mock', externalId: `x-${i.id}`, status: 'pending', at: NOW }; },
  };
  await runPayment(makeIntent({ id: 'slow' }), basePolicy(), ledger, pendingAdapter);
  await runPayment(makeIntent({ id: 'fast' }), basePolicy(), ledger, pendingAdapter);
  const statusAdapter: PaymentAdapter = {
    ...pendingAdapter,
    status: (r) => (r.intentId === 'slow' ? new Promise<Receipt>(() => {}) : Promise.resolve({ ...r, status: 'succeeded' })),
  };
  const summary = await reconcile(ledger, statusAdapter, { statusTimeoutMs: 20 });
  assert.equal(summary.checked, 2);
  assert.deepEqual(summary.updated, [{ intentId: 'fast', from: 'pending', to: 'succeeded' }]);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0]?.intentId, 'slow');
  assert.match(summary.errors[0]?.error ?? '', /^adapter_timeout: adapter\.status did not settle within 20ms/);
  assert.equal((await ledger.get('slow'))?.receipt?.status, 'pending', 'nothing written for the timed-out entry');

  await assert.rejects(
    refreshIntent('slow', ledger, statusAdapter, { statusTimeoutMs: 20 }),
    (err: unknown) => err instanceof PaymentError && err.code === 'status_check_failed' && /adapter_timeout/.test(err.message),
  );
});

test('F5: invalid timeout options throw TypeError before anything is written', async (t) => {
  const ledger = newLedger(await tempDir(t));
  await assert.rejects(runPayment(makeIntent(), basePolicy(), ledger, hanging(), { payTimeoutMs: 0 }), TypeError);
  assert.equal(await ledger.get('pi-1'), undefined);
});
