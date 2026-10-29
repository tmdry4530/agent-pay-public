import { ReasonCode } from '@agent-pay/core/policy.ts';
import { FailureCode } from '@agent-pay/core/orchestrator.ts';
import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memoryLedger';
import { resolveIntentMemory } from '../memoryResolve';

const intent = {
  id: 'pi_resolve',
  createdAt: '2026-01-01T10:00:00.000Z',
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 12,
  currency: 'USD',
  purpose: 'test',
};

describe('resolveIntentMemory', () => {
  it('intent_not_found when missing', async () => {
    const ledger = new MemoryLedger();
    await expect(
      resolveIntentMemory('missing', ledger, { status: 'succeeded', note: 'ok', resolvedBy: 'ops' }),
    ).rejects.toMatchObject({ code: 'intent_not_found' });
  });

  it('succeeded clears needsManualResolve and sets resolution with previousExternalId', async () => {
    let t = new Date('2026-01-01T12:00:00.000Z').getTime();
    const now = () => new Date(t);
    const ledger = new MemoryLedger({ now });
    await ledger.recordIntent(intent);
    await ledger.recordDecision(intent.id, {
      status: 'approved',
      reason: `${ReasonCode.WithinPolicy}: ok`,
    });
    await ledger.markSubmitting(intent.id, 'mock');
    await ledger.recordPaymentResult(intent.id, {
      status: 'paid',
      receipt: {
        intentId: intent.id,
        rail: 'mock',
        externalId: 'ext_old',
        status: 'pending',
        at: '2026-01-01T11:00:00.000Z',
      },
      needsManualResolve: true,
    });
    t += 1000;
    const result = await resolveIntentMemory(
      intent.id,
      ledger,
      { status: 'succeeded', note: 'confirmed on rail', resolvedBy: 'ops-user' },
      now,
    );
    expect(result.changed).toBe(true);
    expect(result.status).toBe('paid');
    expect(result.receipt?.status).toBe('succeeded');
    expect(result.resolution).toMatchObject({
      status: 'succeeded',
      resolvedBy: 'ops-user',
      note: 'confirmed on rail',
      previousExternalId: 'ext_old',
    });
    const entry = await ledger.get(intent.id);
    expect(entry?.needsManualResolve).toBeUndefined();
    expect(entry?.resolution?.previousExternalId).toBe('ext_old');
  });

  it('failed sets paymentStatus failed and error message', async () => {
    const ledger = new MemoryLedger();
    await ledger.recordIntent(intent);
    await ledger.recordDecision(intent.id, {
      status: 'approved',
      reason: `${ReasonCode.WithinPolicy}: ok`,
    });
    await ledger.recordPaymentResult(intent.id, {
      status: 'paid',
      receipt: {
        intentId: intent.id,
        rail: 'mock',
        externalId: '',
        status: 'pending',
        at: '2026-01-01T11:00:00.000Z',
      },
    });
    const result = await resolveIntentMemory(intent.id, ledger, {
      status: 'failed',
      note: 'never paid',
      resolvedBy: 'ops',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe(`${FailureCode.PaymentFailed}: resolved as failed by ops`);
    const entry = await ledger.get(intent.id);
    expect(entry?.paymentStatus).toBe('failed');
  });

  it('externalId override on resolve', async () => {
    const ledger = new MemoryLedger();
    await ledger.recordIntent(intent);
    await ledger.recordDecision(intent.id, {
      status: 'approved',
      reason: `${ReasonCode.WithinPolicy}: ok`,
    });
    await ledger.recordPaymentResult(intent.id, {
      status: 'paid',
      receipt: {
        intentId: intent.id,
        rail: 'mock',
        externalId: 'old',
        status: 'pending',
        at: '2026-01-01T11:00:00.000Z',
      },
    });
    const result = await resolveIntentMemory(intent.id, ledger, {
      status: 'succeeded',
      note: 'n',
      resolvedBy: 'ops',
      externalId: 'new_ext',
    });
    expect(result.receipt?.externalId).toBe('new_ext');
  });

  it('interrupted submitting entry settles from submission', async () => {
    const ledger = new MemoryLedger();
    await ledger.recordIntent(intent);
    await ledger.recordDecision(intent.id, {
      status: 'approved',
      reason: `${ReasonCode.WithinPolicy}: ok`,
    });
    await ledger.markSubmitting(intent.id, 'mock');
    const result = await resolveIntentMemory(intent.id, ledger, {
      status: 'succeeded',
      note: 'after hang',
      resolvedBy: 'ops',
    });
    expect(result.receipt?.status).toBe('succeeded');
    expect(result.receipt?.externalId).toBe('');
  });

  it('receipt_not_pending on second resolve', async () => {
    const ledger = new MemoryLedger();
    await ledger.recordIntent(intent);
    await ledger.recordDecision(intent.id, {
      status: 'approved',
      reason: `${ReasonCode.WithinPolicy}: ok`,
    });
    await ledger.recordPaymentResult(intent.id, {
      status: 'paid',
      receipt: {
        intentId: intent.id,
        rail: 'mock',
        externalId: 'x',
        status: 'pending',
        at: '2026-01-01T11:00:00.000Z',
      },
    });
    await resolveIntentMemory(intent.id, ledger, {
      status: 'succeeded',
      note: 'first',
      resolvedBy: 'ops',
    });
    await expect(
      resolveIntentMemory(intent.id, ledger, { status: 'failed', note: 'second', resolvedBy: 'ops' }),
    ).rejects.toBeInstanceOf(PaymentError);
    await expect(
      resolveIntentMemory(intent.id, ledger, { status: 'failed', note: 'second', resolvedBy: 'ops' }),
    ).rejects.toMatchObject({ code: 'receipt_not_pending' });
  });

  it('no_receipt when approved but never paid or submitting', async () => {
    const ledger = new MemoryLedger();
    await ledger.recordIntent(intent);
    await ledger.recordDecision(intent.id, {
      status: 'approved',
      reason: `${ReasonCode.WithinPolicy}: ok`,
    });
    await expect(
      resolveIntentMemory(intent.id, ledger, { status: 'succeeded', note: 'n', resolvedBy: 'ops' }),
    ).rejects.toMatchObject({ code: 'no_receipt' });
  });
});
