import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PaymentError, reconcile, refreshIntent, resolveIntent, runPayment, type PaymentAdapter, type PaymentIntent, type Receipt,
} from '../src/index.ts';
import { NOW, basePolicy, legacyView, makeIntent, newLedger, tempDir } from './helpers.ts';

const throwing: PaymentAdapter = { rail: 'mock', async pay() { throw new Error('socket hang up'); } };
const invalid = (r: (i: PaymentIntent) => unknown): PaymentAdapter => ({ rail: 'mock', async pay(i) { return r(i) as Receipt; } });
const policy = basePolicy({ dailyMax: 30 });

test('F3: adapter.pay throwing -> pending + needsManualResolve, limit stays held', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const result = await runPayment(makeIntent({ amount: 20 }), policy, ledger, throwing);
  assert.equal(result.status, 'paid', 'RunStatus unchanged: paid = counts, receipt may be pending');
  assert.equal(result.needsManualResolve, true);
  assert.equal(result.error, 'adapter_error: socket hang up');
  assert.deepEqual(result.receipt, { intentId: 'pi-1', rail: 'mock', externalId: '', status: 'pending', at: NOW });
  const entry = await ledger.get('pi-1');
  assert.equal(entry?.paymentStatus, 'paid');
  assert.equal(entry?.needsManualResolve, true);
  assert.equal(entry?.receipt?.status, 'pending');
  assert.equal(await ledger.dailyTotal('agent-1'), 20, 'limit held');
  const next = await runPayment(makeIntent({ id: 'pi-2', amount: 20 }), policy, ledger, throwing);
  assert.equal(next.status, 'rejected', 'the held amount still blocks the daily limit');
});

test('F3: an invalid receipt (wrong intentId / rail / status / not an object) is also pending + needsManualResolve', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const cases: [string, PaymentAdapter, RegExp][] = [
    ['a', invalid(() => ({ intentId: 'other', rail: 'mock', externalId: 'x', status: 'succeeded', at: NOW })), /^receipt_mismatch: receipt intentId "other"/],
    ['b', invalid((i) => ({ intentId: i.id, rail: 'near', externalId: 'x', status: 'succeeded', at: NOW })), /^receipt_mismatch: receipt rail "near"/],
    ['c', invalid((i) => ({ intentId: i.id, rail: 'mock', externalId: 'x', status: 'refunded', at: NOW })), /^receipt_mismatch: receipt status/],
    ['d', invalid(() => undefined), /^receipt_mismatch: adapter returned undefined/],
  ];
  for (const [id, adapter, error] of cases) {
    const result = await runPayment(makeIntent({ id, amount: 1 }), basePolicy(), ledger, adapter);
    assert.equal(result.needsManualResolve, true, id);
    assert.match(result.error ?? '', error, id);
    assert.equal(result.receipt?.status, 'pending', id);
    assert.equal((await ledger.get(id))?.needsManualResolve, true, id);
  }
  assert.equal(await ledger.dailyTotal('agent-1'), 4);
});

test('F3: replay reports needsManualResolve and never calls the adapter again', async (t) => {
  const ledger = newLedger(await tempDir(t));
  await runPayment(makeIntent(), policy, ledger, throwing);
  let calls = 0;
  const counting: PaymentAdapter = { rail: 'mock', async pay() { calls += 1; throw new Error('x'); } };
  const again = await runPayment(makeIntent(), policy, ledger, counting);
  assert.equal(calls, 0);
  assert.equal(again.replayed, true);
  assert.equal(again.needsManualResolve, true);
  assert.equal(again.receipt?.status, 'pending');
});

test('F3: reconcile and refresh skip needsManualResolve entries; resolve settles and clears the flag', async (t) => {
  const ledger = newLedger(await tempDir(t));
  await runPayment(makeIntent(), policy, ledger, throwing);
  let statusCalls = 0;
  const withStatus: PaymentAdapter = { ...throwing, async status(r) { statusCalls += 1; return r; } };
  const summary = await reconcile(ledger, withStatus);
  assert.equal(summary.checked, 0);
  await assert.rejects(refreshIntent('pi-1', ledger, withStatus), (err: unknown) => err instanceof PaymentError && err.code === 'status_unsupported');
  assert.equal(statusCalls, 0);

  const out = await resolveIntent('pi-1', ledger, { status: 'failed', note: 'rail has no record', resolvedBy: 'ops' }, () => new Date(NOW));
  assert.equal(out.status, 'failed');
  const entry = await ledger.get('pi-1');
  assert.equal(entry?.paymentStatus, 'failed');
  assert.equal(entry?.needsManualResolve, undefined);
  assert.equal(await ledger.dailyTotal('agent-1'), 0, 'resolved as failed frees the limit');
});

test('F3: legacy ledgers (no markSubmitting) get the same pending result', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const result = await runPayment(makeIntent(), policy, legacyView(ledger), throwing);
  assert.equal(result.status, 'paid');
  assert.equal(result.needsManualResolve, true);
  assert.equal((await ledger.get('pi-1'))?.receipt?.status, 'pending');
  assert.equal(await ledger.dailyTotal('agent-1'), 10);
});
