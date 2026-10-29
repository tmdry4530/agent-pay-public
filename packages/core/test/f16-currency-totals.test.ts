import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReasonCode, reasonCode, runPayment } from '../src/index.ts';
import { basePolicy, delayedAdapter, makeIntent, newLedger, tempDir } from './helpers.ts';

test('F16: spend in another currency does not count against the policy currency', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const usd = basePolicy({ dailyMax: 200, perTxMax: 200, requireApprovalAbove: 200 });
  const r1 = await runPayment(makeIntent({ id: 'pi-usd', amount: 200 }), usd, ledger, delayedAdapter(0));
  assert.equal(r1.decision.status, 'approved');

  const near = { ...usd, currency: 'NEAR' };
  const r2 = await runPayment(makeIntent({ id: 'pi-near', amount: 10, currency: 'NEAR' }), near, ledger, delayedAdapter(0, 'near'));
  assert.equal(r2.decision.status, 'approved', r2.decision.reason);

  assert.equal(await ledger.dailyTotal('agent-1', undefined, 'USD'), 200);
  assert.equal(await ledger.dailyTotal('agent-1', undefined, 'near'), 10);
  assert.deepEqual(await ledger.dailyTotals('agent-1'), { USD: 200, NEAR: 10 });
});

test('F16: same-currency spend still counts (case-insensitive) and the limit holds', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const near = basePolicy({ currency: 'NEAR' });
  await runPayment(makeIntent({ id: 'a', amount: 100, currency: 'NEAR' }), near, ledger, delayedAdapter(0, 'near'));
  await runPayment(makeIntent({ id: 'b', amount: 100, currency: 'near' }), near, ledger, delayedAdapter(0, 'near'));
  const r = await runPayment(makeIntent({ id: 'c', amount: 1, currency: 'NEAR' }), near, ledger, delayedAdapter(0, 'near'));
  assert.equal(reasonCode(r.decision), ReasonCode.DailyLimitExceeded);
});

test('F16: an intent in a non-policy currency is rejected currency_mismatch and reserves nothing', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const r = await runPayment(makeIntent({ id: 'eur', amount: 10, currency: 'EUR' }), basePolicy(), ledger, delayedAdapter(0));
  assert.equal(reasonCode(r.decision), ReasonCode.CurrencyMismatch);
  assert.deepEqual(await ledger.dailyTotals('agent-1'), {});
});
