import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memoryLedger';

describe('MemoryLedger', () => {
  const now = () => new Date('2026-01-01T12:00:00.000Z');

  const baseIntent = {
    id: 'i1',
    agentId: 'a',
    payee: 'p',
    amount: 10,
    currency: 'USD',
    purpose: 'x',
    createdAt: now().toISOString(),
  };

  it('recordDecision honors ifStatus guard', async () => {
    const ledger = new MemoryLedger({ now });
    const intent = baseIntent;
    await ledger.recordIntent(intent);
    await ledger.recordDecision(intent.id, {
      status: 'needs_approval',
      reason: 'approval_required: threshold',
    });
    await expect(
      ledger.recordDecision(
        intent.id,
        { status: 'approved', reason: 'within_policy: ok' },
        { ifStatus: 'approved' },
      ),
    ).rejects.toThrow(/expected approved/);
    await ledger.recordDecision(
      intent.id,
      { status: 'approved', reason: 'approved_by_human: ok' },
      { ifStatus: 'needs_approval' },
    );
    const entry = await ledger.get(intent.id);
    expect(entry?.decision?.status).toBe('approved');
  });

  it('settleReceipt replaces pending receipt and marks payment failed when receipt failed', async () => {
    const ledger = new MemoryLedger({ now });
    await ledger.recordIntent(baseIntent);
    await ledger.recordDecision(baseIntent.id, { status: 'approved', reason: 'within_policy: ok' });
    await ledger.recordPayment(baseIntent.id, 'paid');
    await ledger.recordReceipt(baseIntent.id, {
      intentId: baseIntent.id,
      rail: 'mock',
      externalId: 'mock_1',
      status: 'pending',
      at: now().toISOString(),
    });
    await ledger.settleReceipt(baseIntent.id, {
      intentId: baseIntent.id,
      rail: 'mock',
      externalId: 'mock_1',
      status: 'succeeded',
      at: now().toISOString(),
    });
    let entry = await ledger.get(baseIntent.id);
    expect(entry?.receipt?.status).toBe('succeeded');
    expect(entry?.paymentStatus).toBe('paid');

    await ledger.recordIntent({ ...baseIntent, id: 'i2' });
    await ledger.recordDecision('i2', { status: 'approved', reason: 'within_policy: ok' });
    await ledger.recordPayment('i2', 'paid');
    await ledger.recordReceipt('i2', {
      intentId: 'i2',
      rail: 'mock',
      externalId: 'mock_2',
      status: 'pending',
      at: now().toISOString(),
    });
    await ledger.settleReceipt('i2', {
      intentId: 'i2',
      rail: 'mock',
      externalId: 'mock_2',
      status: 'failed',
      at: now().toISOString(),
    });
    entry = await ledger.get('i2');
    expect(entry?.paymentStatus).toBe('failed');

    await expect(
      ledger.settleReceipt(baseIntent.id, {
        intentId: baseIntent.id,
        rail: 'mock',
        externalId: 'mock_1',
        status: 'succeeded',
        at: now().toISOString(),
      }),
    ).rejects.toThrow(/not pending/);
  });
});
