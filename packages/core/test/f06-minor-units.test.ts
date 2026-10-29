import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENCY_DECIMALS,
  ReasonCode,
  evaluate,
  formatMinor,
  reasonCode,
  runPayment,
  toMinorUnits,
} from '../src/index.ts';
import { basePolicy, delayedAdapter, makeIntent, newLedger, tempDir } from './helpers.ts';

test('F6: toMinorUnits is exact, including exponent notation, and refuses excess precision', () => {
  assert.deepEqual(CURRENCY_DECIMALS, { USD: 2, NEAR: 24 });
  assert.equal(toMinorUnits(10.01, 2), 1001n);
  assert.equal(toMinorUnits(0.1, 2), 10n);
  assert.equal(toMinorUnits(100, 2), 10000n);
  assert.equal(toMinorUnits(10.001, 2), undefined);
  assert.equal(toMinorUnits(0.1 + 0.2, 2), undefined);
  assert.equal(toMinorUnits(1e21, 2), 100000000000000000000000n);
  assert.equal(toMinorUnits(1e-24, 24), 1n);
  assert.equal(toMinorUnits(1.5e-7, 24), 150000000000000000n);
  assert.equal(toMinorUnits(1e-25, 24), undefined);
  assert.equal(toMinorUnits(0.1, 24), 100000000000000000000000n);
  assert.equal(toMinorUnits(NaN, 2), undefined);
  assert.equal(formatMinor(1001n, 2), '10.01');
  assert.equal(formatMinor(2500n, 2), '25');
  assert.equal(formatMinor(1n, 24), '0.000000000000000000000001');
});

test('F6: USD amounts with more than 2 decimals are rejected invalid_amount', () => {
  for (const amount of [10.001, 0.1 + 0.2, 0.005]) {
    const d = evaluate(basePolicy(), makeIntent({ amount }), { dailyTotal: 0 });
    assert.equal(reasonCode(d), ReasonCode.InvalidAmount, String(amount));
    assert.match(d.reason, /USD allows at most 2 decimal places/);
  }
  assert.equal(evaluate(basePolicy(), makeIntent({ amount: 10.01 }), { dailyTotal: 0 }).status, 'approved');
});

test('F6: NEAR allows 24 decimals (yocto)', () => {
  const near = basePolicy({ currency: 'NEAR' });
  assert.equal(evaluate(near, makeIntent({ currency: 'NEAR', amount: 1e-24 }), { dailyTotal: 0 }).status, 'approved');
  assert.equal(reasonCode(evaluate(near, makeIntent({ currency: 'NEAR', amount: 1e-25 }), { dailyTotal: 0 })), ReasonCode.InvalidAmount);
});

for (const currency of ['USD', 'NEAR']) {
  test(`F6: ${currency} totals are summed in integer minor units (0.1 × 3 fits a 0.3 daily max)`, async (t) => {
    const ledger = newLedger(await tempDir(t));
    const policy = basePolicy({ currency, perTxMax: 1, dailyMax: 0.3, requireApprovalAbove: 1 });
    for (const id of ['a', 'b', 'c']) {
      const r = await runPayment(makeIntent({ id, amount: 0.1, currency }), policy, ledger, delayedAdapter(0));
      assert.equal(r.decision.status, 'approved', `${id}: ${r.decision.reason}`);
    }
    const r = await runPayment(makeIntent({ id: 'd', amount: currency === 'USD' ? 0.01 : 1e-24, currency }), policy, ledger, delayedAdapter(0));
    assert.equal(reasonCode(r.decision), ReasonCode.DailyLimitExceeded);
    assert.match(r.decision.reason, /today's total 0\.3 \+/);
  });
}

test('F6: limits that cannot be represented in the currency, or an unknown policy currency, are invalid_policy', () => {
  const cases = [basePolicy({ dailyMax: 10.005 }), basePolicy({ perTxMax: 0.001 }), basePolicy({ requireApprovalAbove: 1.234 }), basePolicy({ currency: 'EUR' })];
  for (const policy of cases) {
    const d = evaluate(policy, makeIntent({ amount: 1, currency: policy.currency ?? 'USD' }), { dailyTotal: 0 });
    assert.equal(reasonCode(d), ReasonCode.InvalidPolicy, JSON.stringify(policy));
  }
});

test('F6: a legacy LedgerState (number total only) is converted conservatively', () => {
  const policy = basePolicy({ dailyMax: 0.3 });
  assert.equal(evaluate(policy, makeIntent({ amount: 0.1 }), { dailyTotal: 0.1 + 0.1 }).status, 'approved');
  assert.equal(reasonCode(evaluate(policy, makeIntent({ amount: 0.1 }), { dailyTotal: 0.201 })), ReasonCode.DailyLimitExceeded);
});
