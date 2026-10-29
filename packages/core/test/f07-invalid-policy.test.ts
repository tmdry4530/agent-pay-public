import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReasonCode, evaluate, reasonCode } from '../src/index.ts';
import type { Policy } from '../src/index.ts';
import { basePolicy, makeIntent } from './helpers.ts';

const bad: [string, Partial<Record<keyof Policy, unknown>>][] = [
  ['perTxMax NaN', { perTxMax: NaN }],
  ['perTxMax missing', { perTxMax: undefined }],
  ['perTxMax negative', { perTxMax: -1 }],
  ['perTxMax string', { perTxMax: '100' }],
  ['dailyMax NaN', { dailyMax: NaN }],
  ['dailyMax missing', { dailyMax: undefined }],
  ['dailyMax Infinity', { dailyMax: Infinity }],
  ['requireApprovalAbove NaN', { requireApprovalAbove: NaN }],
  ['requireApprovalAbove missing', { requireApprovalAbove: undefined }],
  ['allowedPayees not an array', { allowedPayees: 'openai-api' }],
];

for (const [name, over] of bad) {
  test(`F7: ${name} → rejected invalid_policy (fail closed)`, () => {
    const policy = { ...basePolicy(), ...over } as Policy;
    const d = evaluate(policy, makeIntent({ amount: 1 }), { dailyTotal: 0 });
    assert.equal(d.status, 'rejected');
    assert.equal(reasonCode(d), ReasonCode.InvalidPolicy);
    assert.equal(ReasonCode.InvalidPolicy, 'invalid_policy');
  });
}

test('F7: a non-finite ledger daily total fails closed', () => {
  for (const dailyTotal of [NaN, Infinity, -1]) {
    const d = evaluate(basePolicy(), makeIntent({ amount: 1 }), { dailyTotal });
    assert.equal(reasonCode(d), ReasonCode.InvalidPolicy, String(dailyTotal));
  }
});

test('F7: requireApprovalAbove may be Infinity (never ask) and limits may be 0', () => {
  assert.equal(evaluate(basePolicy({ requireApprovalAbove: Infinity }), makeIntent({ amount: 100 }), { dailyTotal: 0 }).status, 'approved');
  const d = evaluate(basePolicy({ perTxMax: 0 }), makeIntent({ amount: 1 }), { dailyTotal: 0 });
  assert.equal(reasonCode(d), ReasonCode.PerTxLimitExceeded);
});

test('F7: policy validity is checked before everything else', () => {
  const d = evaluate({ ...basePolicy(), dailyMax: NaN }, makeIntent({ agentId: 'someone-else' }), { dailyTotal: 0 });
  assert.equal(reasonCode(d), ReasonCode.InvalidPolicy);
});
