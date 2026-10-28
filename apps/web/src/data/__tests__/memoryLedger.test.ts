import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memoryLedger';

describe('MemoryLedger', () => {
  const now = () => new Date('2026-01-01T12:00:00.000Z');

  it('recordDecision honors ifStatus guard', async () => {
    const ledger = new MemoryLedger({ now });
    const intent = {
      id: 'i1',
      agentId: 'a',
      payee: 'p',
      amount: 10,
      currency: 'USD',
      purpose: 'x',
      createdAt: now().toISOString(),
    };
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
});
