import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReasonCode, approve, reasonCode, runPayment, type PaymentAdapter, type PaymentIntent, type Policy } from '../src/index.ts';
import { NOW, basePolicy, legacyView, makeIntent, newLedger, tempDir } from './helpers.ts';

/** Valid policy under which a 100 USD intent needs approval. */
const validPolicy = () => basePolicy({ perTxMax: 200, dailyMax: 500, requireApprovalAbove: 50 });

function countingAdapter(): PaymentAdapter & { calls: number } {
  const a = {
    rail: 'mock' as const,
    calls: 0,
    async pay(i: PaymentIntent) {
      a.calls++;
      return { intentId: i.id, rail: 'mock' as const, externalId: `x-${i.id}`, status: 'succeeded' as const, at: NOW };
    },
  };
  return a;
}

const invalid: [string, Partial<Record<keyof Policy, unknown>>][] = [
  ['requireApprovalAbove NaN', { requireApprovalAbove: NaN }],
  ['requireApprovalAbove missing', { requireApprovalAbove: undefined }],
  ['requireApprovalAbove negative', { requireApprovalAbove: -1 }],
  ['requireApprovalAbove string', { requireApprovalAbove: '50' }],
  ['requireApprovalAbove sub-cent USD', { requireApprovalAbove: 50.001 }],
  ['perTxMax NaN', { perTxMax: NaN }],
  ['perTxMax missing', { perTxMax: undefined }],
  ['perTxMax sub-cent USD', { perTxMax: 200.001 }],
  ['dailyMax NaN', { dailyMax: NaN }],
  ['dailyMax Infinity', { dailyMax: Infinity }],
  ['allowedPayees not an array', { allowedPayees: 'openai-api' }],
  ['agentId not a string', { agentId: 1 }],
  ['unsupported policy currency', { currency: 'EUR' }],
];

for (const legacy of [false, true]) {
  for (const [name, over] of invalid) {
    test(`approve re-check (${legacy ? 'legacy ledger' : 'Ledger'}): ${name} → rejected invalid_policy by 'policy', no pay, no spend`, async (t) => {
      const real = newLedger(await tempDir(t));
      const ledger = legacy ? legacyView(real) : real;
      const adapter = countingAdapter();
      const first = await runPayment(makeIntent({ amount: 100 }), validPolicy(), ledger, adapter);
      assert.equal(first.status, 'needs_approval');

      const policy = { ...validPolicy(), ...over } as Policy;
      const result = await approve('pi-1', { policy, ledger, adapter, approver: 'alice' });
      assert.equal(result.status, 'rejected');
      assert.equal(reasonCode(result.decision), ReasonCode.InvalidPolicy, result.decision.reason);
      assert.equal(adapter.calls, 0, 'nothing paid');

      const entry = await real.get('pi-1');
      assert.equal(entry?.decision?.status, 'rejected');
      assert.equal(reasonCode(entry!.decision!), ReasonCode.InvalidPolicy);
      assert.equal(entry?.paymentStatus, undefined);
      const last = entry?.decisions.at(-1);
      assert.equal(last?.actor, 'policy');
      assert.equal(last?.status, 'rejected');
      assert.equal(await real.dailyTotal('agent-1'), 0, 'no spend released or reserved');
    });
  }
}

test('approve re-check: a valid policy still approves and pays (Infinity threshold allowed)', async (t) => {
  for (const requireApprovalAbove of [50, Infinity]) {
    const ledger = newLedger(await tempDir(t));
    const adapter = countingAdapter();
    await runPayment(makeIntent({ amount: 100 }), validPolicy(), ledger, adapter);
    const result = await approve('pi-1', { policy: { ...validPolicy(), requireApprovalAbove }, ledger, adapter, approver: 'alice' });
    assert.equal(result.status, 'paid');
    assert.equal(adapter.calls, 1);
    assert.equal(await ledger.dailyTotal('agent-1'), 100);
  }
});
