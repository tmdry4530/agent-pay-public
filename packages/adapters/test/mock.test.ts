import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockAdapter } from '../src/mock.ts';
import { AdapterValidationError } from '../src/validate.ts';
import type { PaymentIntent, ReceiptStatus } from '../src/index.ts';

const ALLOWED: ReadonlySet<ReceiptStatus> = new Set([
  'succeeded',
  'pending',
  'failed',
  'refunded',
]);

function assertAllowedStatus(status: ReceiptStatus): void {
  assert.ok(ALLOWED.has(status), `unexpected status: ${status}`);
}

function baseIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'intent-1',
    agentId: 'agent-a',
    payee: 'payee@example.com',
    amount: 10,
    currency: 'USD',
    purpose: 'test payment',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('createMockAdapter', () => {
  it('returns a succeeded receipt with expected shape', async () => {
    const adapter = createMockAdapter({ now: () => new Date('2026-06-01T12:00:00.000Z') });
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.intentId, 'intent-1');
    assert.equal(receipt.rail, 'mock');
    assert.match(receipt.externalId, /^mock_[a-f0-9]{16}$/);
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.at, '2026-06-01T12:00:00.000Z');
  });

  it('uses deterministic externalId for the same intent id', async () => {
    const a = createMockAdapter();
    const b = createMockAdapter();
    const r1 = await a.pay(baseIntent({ id: 'same-id' }));
    const r2 = await b.pay(baseIntent({ id: 'same-id' }));
    assert.equal(r1.externalId, r2.externalId);
    const r3 = await a.pay(baseIntent({ id: 'other-id' }));
    assert.notEqual(r1.externalId, r3.externalId);
  });

  it('pay is idempotent for the same intent id', async () => {
    const adapter = createMockAdapter();
    const r1 = await adapter.pay(baseIntent());
    const r2 = await adapter.pay(baseIntent());
    assert.deepEqual(r1, r2);
  });

  it('refunds succeeded mock receipts and is idempotent', async () => {
    const adapter = createMockAdapter({ now: () => new Date('2026-06-01T12:00:00.000Z') });
    const paid = await adapter.pay(baseIntent());
    const refund1 = await adapter.refund!(paid);
    assert.equal(refund1.status, 'refunded');
    assert.match(refund1.externalId, /^mock_refund_[a-f0-9]{16}$/);
    const refund2 = await adapter.refund!(paid);
    assert.deepEqual(refund1, refund2);
  });

  it('rejects refund of unknown or non-mock receipts', async () => {
    const adapter = createMockAdapter();
    await assert.rejects(
      () =>
        adapter.refund!({
          intentId: 'x',
          rail: 'mock',
          externalId: 'mock_unknown000000',
          status: 'succeeded',
          at: '2026-01-01T00:00:00.000Z',
        }),
      /Unknown or non-refundable/,
    );
    await assert.rejects(
      () =>
        adapter.refund!({
          intentId: 'x',
          rail: 'paypal',
          externalId: 'cap-1',
          status: 'succeeded',
          at: '2026-01-01T00:00:00.000Z',
        }),
      /another rail/,
    );
  });

  it('rejects invalid amounts', async () => {
    const adapter = createMockAdapter();
    for (const amount of [0, -1, NaN]) {
      await assert.rejects(
        () => adapter.pay(baseIntent({ amount })),
        (err: unknown) => err instanceof AdapterValidationError && err.field === 'amount',
      );
    }
  });

  it('rejects missing or invalid currency', async () => {
    const adapter = createMockAdapter();
    await assert.rejects(
      () => adapter.pay(baseIntent({ currency: '' })),
      (err: unknown) => err instanceof AdapterValidationError && err.field === 'currency',
    );
    await assert.rejects(
      () => adapter.pay(baseIntent({ currency: 'usd' })),
      (err: unknown) => err instanceof AdapterValidationError && err.field === 'currency',
    );
  });

  it('rejects missing payee', async () => {
    const adapter = createMockAdapter();
    await assert.rejects(
      () => adapter.pay(baseIntent({ payee: '' })),
      (err: unknown) => err instanceof AdapterValidationError && err.field === 'payee',
    );
  });
});

describe('contract', () => {
  it('receipt.intentId equals intent.id on pay (success and failed)', async () => {
    const adapter = createMockAdapter({
      shouldDecline: (intent) => intent.id === 'declined',
    });
    const ok = await adapter.pay(baseIntent({ id: 'ok' }));
    assert.equal(ok.intentId, 'ok');
    const bad = await adapter.pay(baseIntent({ id: 'declined' }));
    assert.equal(bad.intentId, 'declined');
  });

  it('receipt.rail equals adapter.rail on pay and refund', async () => {
    const adapter = createMockAdapter();
    const paid = await adapter.pay(baseIntent());
    assert.equal(paid.rail, adapter.rail);
    const refunded = await adapter.refund!(paid);
    assert.equal(refunded.rail, adapter.rail);
    assert.equal(refunded.intentId, paid.intentId);
  });

  it('declined payment resolves with status failed', async () => {
    const adapter = createMockAdapter({ shouldDecline: () => true });
    await assert.doesNotReject(async () => {
      const receipt = await adapter.pay(baseIntent());
      assert.equal(receipt.status, 'failed');
    });
  });

  it('every receipt status in tests is allowed', async () => {
    const adapter = createMockAdapter({
      shouldDecline: (intent) => intent.id === 'fail',
    });
    assertAllowedStatus((await adapter.pay(baseIntent())).status);
    assertAllowedStatus((await adapter.pay(baseIntent({ id: 'fail' }))).status);
    const paid = await adapter.pay(baseIntent({ id: 'refund-me' }));
    assertAllowedStatus(paid.status);
    assertAllowedStatus((await adapter.refund!(paid)).status);
  });

  it('refund of a failed receipt throws', async () => {
    const adapter = createMockAdapter({ shouldDecline: () => true });
    const failed = await adapter.pay(baseIntent());
    assert.equal(failed.status, 'failed');
    await assert.rejects(() => adapter.refund!(failed), /non-refundable/);
  });
});
