import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memoryLedger';
import { isSubmitting } from '../compat';

describe('MemoryLedger submitting', () => {
  const now = () => new Date('2026-01-01T12:00:00.000Z');
  const intent = {
    id: 'i1',
    agentId: 'a',
    payee: 'p',
    amount: 10,
    currency: 'USD',
    purpose: 'x',
    createdAt: now().toISOString(),
  };

  it('markSubmitting then recordPayment from submitting', async () => {
    const ledger = new MemoryLedger({ now });
    await ledger.recordIntent(intent);
    await ledger.recordDecision(intent.id, { status: 'approved', reason: 'within_policy: ok' });
    await ledger.markSubmitting(intent.id);
    let entry = await ledger.get(intent.id);
    expect(isSubmitting(entry)).toBe(true);
    await ledger.recordPayment(intent.id, 'paid');
    entry = await ledger.get(intent.id);
    expect(entry?.paymentStatus).toBe('paid');
  });
});
