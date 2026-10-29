import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaymentError, runPayment, sameIntent, type PaymentAdapter, type PaymentIntent } from '../src/index.ts';
import { NOW, basePolicy, makeIntent, newLedger, tempDir } from './helpers.ts';

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

test('F14: sameIntent ignores undefined props and compares timestamps by instant', () => {
  const a = makeIntent({ createdAt: '2026-10-28T10:00:00Z' });
  assert.ok(sameIntent(a, { ...a, createdAt: '2026-10-28T10:00:00.000Z' }));
  assert.ok(sameIntent(a, { ...a, createdAt: '2026-10-28T19:00:00+09:00' }));
  assert.ok(sameIntent(a, { ...a, extra: undefined } as PaymentIntent));
  assert.ok(sameIntent(a, { ...a, currency: a.currency.toLowerCase() }));
  assert.ok(!sameIntent(a, { ...a, createdAt: '2026-10-28T10:00:01Z' }));
  assert.ok(!sameIntent(a, { ...a, amount: a.amount + 0.01 }));
  assert.ok(!sameIntent(a, { ...a, payee: 'someone-else' }));
  assert.ok(!sameIntent(a, { ...a, extra: 1 } as PaymentIntent));
  assert.ok(!sameIntent(a, { ...a, createdAt: 'not-a-date' }));
});

test('F14: a retry with an equivalent timestamp / undefined props replays without paying again', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const adapter = countingAdapter();
  const intent = makeIntent({ createdAt: '2026-10-28T10:00:00Z' });
  const first = await runPayment(intent, basePolicy(), ledger, adapter);
  assert.equal(first.status, 'paid');
  const retry = await runPayment({ ...intent, createdAt: '2026-10-28T10:00:00.000Z', purpose: intent.purpose, extra: undefined } as PaymentIntent, basePolicy(), ledger, adapter);
  assert.equal(retry.status, 'paid');
  assert.equal(retry.replayed, true);
  assert.equal(adapter.calls, 1);
  await assert.rejects(
    runPayment({ ...intent, amount: intent.amount + 1 }, basePolicy(), ledger, adapter),
    (err: unknown) => err instanceof PaymentError && err.code === 'intent_conflict',
  );
  assert.equal(adapter.calls, 1);
});
