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
    let entry = await ledger.get(intent.id);
    expect(entry?.decisions).toHaveLength(1);
    await ledger.recordDecision(
      intent.id,
      { status: 'approved', reason: 'approved_by_human: ok' },
      { ifStatus: 'needs_approval' },
    );
    entry = await ledger.get(intent.id);
    expect(entry?.decision?.status).toBe('approved');
    expect(entry?.decisions).toHaveLength(2);
  });

  it('recordDecision appends history with at and actor; decision mirrors latest', async () => {
    const ledger = new MemoryLedger({ now });
    await ledger.recordIntent(baseIntent);
    await ledger.recordDecision(
      baseIntent.id,
      { status: 'needs_approval', reason: 'approval_required: threshold' },
      { actor: 'policy' },
    );
    await ledger.recordDecision(
      baseIntent.id,
      { status: 'approved', reason: 'approved_by_human: ok' },
      { ifStatus: 'needs_approval', actor: 'demo-operator' },
    );
    const entry = await ledger.get(baseIntent.id);
    expect(entry?.decisions).toHaveLength(2);
    expect(entry?.decisions[0]).toMatchObject({
      status: 'needs_approval',
      reason: 'approval_required: threshold',
      at: now().toISOString(),
      actor: 'policy',
    });
    expect(entry?.decisions[1]).toMatchObject({
      status: 'approved',
      reason: 'approved_by_human: ok',
      at: now().toISOString(),
      actor: 'demo-operator',
    });
    expect(entry?.decision).toEqual({ status: 'approved', reason: 'approved_by_human: ok' });
    expect(entry?.updatedAt).toBe(now().toISOString());
  });

  it('failed ifStatus guard appends no decision history', async () => {
    const ledger = new MemoryLedger({ now });
    await ledger.recordIntent(baseIntent);
    await ledger.recordDecision(baseIntent.id, {
      status: 'needs_approval',
      reason: 'approval_required: threshold',
    });
    await expect(
      ledger.recordDecision(
        baseIntent.id,
        { status: 'approved', reason: 'within_policy: ok' },
        { ifStatus: 'approved' },
      ),
    ).rejects.toThrow();
    const entry = await ledger.get(baseIntent.id);
    expect(entry?.decisions).toHaveLength(1);
  });

  it('settleReceipt with resolution stores resolution', async () => {
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
    const resolution = {
      status: 'succeeded' as const,
      resolvedBy: 'ops',
      note: 'confirmed',
      at: now().toISOString(),
      previousExternalId: 'mock_1',
    };
    await ledger.settleReceipt(
      baseIntent.id,
      {
        intentId: baseIntent.id,
        rail: 'mock',
        externalId: 'mock_1',
        status: 'succeeded',
        at: now().toISOString(),
      },
      resolution,
    );
    const entry = await ledger.get(baseIntent.id);
    expect(entry?.resolution).toEqual(resolution);
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
