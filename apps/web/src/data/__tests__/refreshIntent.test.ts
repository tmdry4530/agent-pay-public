import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import type { PaymentAdapter } from '@agent-pay/core';
import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIOS } from '../../types';
import { DEMO_POLICY, createInMemoryClient } from '../inMemoryClient';
import type { IntentDraft } from '../agentPayClient';
import { normalizeTotals } from '../compat';
import { MemoryLedger } from '../memoryLedger';
import { refreshIntent } from '../refreshIntent';

describe('refreshIntent (in-memory client)', () => {
  const fixedNow = () => new Date('2026-01-15T12:00:00.000Z');
  let idCounter = 0;
  const newId = () => `test-id-${++idCounter}`;

  function draft(task: (typeof DEMO_SCENARIOS)[0]['task']): IntentDraft {
    return {
      agentId: DEMO_POLICY.agentId,
      payee: task.payee,
      amount: task.amount,
      currency: 'USD',
      purpose: task.purpose,
    };
  }

  function agentTotal(snap: Awaited<ReturnType<ReturnType<typeof createInMemoryClient>['getLedger']>>): number {
    return (
      normalizeTotals(snap.today, {
        agentId: DEMO_POLICY.agentId,
        fallbackCurrency: 'USD',
      }).USD ?? 0
    );
  }

  it('pending -> refresh unchanged -> refresh changed succeeded; gauge unchanged', async () => {
    idCounter = 0;
    const client = createInMemoryClient({
      now: fixedNow,
      newId,
      pendingSettlement: { afterChecks: 2 },
    });
    const out = await client.submitIntent(draft(DEMO_SCENARIOS[0]!.task), 'mock');
    expect(out.receipt?.status).toBe('pending');
    const before = agentTotal(await client.getLedger());
    expect(before).toBe(12);

    const first = await client.refresh(out.intentId);
    expect(first.changed).toBe(false);
    expect(first.receipt?.status).toBe('pending');

    const second = await client.refresh(out.intentId);
    expect(second.changed).toBe(true);
    expect(second.receipt?.status).toBe('succeeded');
    const snap = await client.getLedger();
    expect(snap.entries[0]?.receipt?.status).toBe('succeeded');
    expect(agentTotal(snap)).toBe(before);
  });

  it('outcome failed drops out of daily total', async () => {
    idCounter = 0;
    const client = createInMemoryClient({
      now: fixedNow,
      newId,
      pendingSettlement: { afterChecks: 1, outcome: 'failed' },
    });
    const out = await client.submitIntent(draft(DEMO_SCENARIOS[0]!.task), 'mock');
    expect(agentTotal(await client.getLedger())).toBe(12);
    const refreshed = await client.refresh(out.intentId);
    expect(refreshed.status).toBe('failed');
    expect(refreshed.changed).toBe(true);
    expect(agentTotal(await client.getLedger())).toBe(0);
  });

  it('pending receipt with adapter lacking status -> status_unsupported', async () => {
    const ledger = new MemoryLedger({ now: fixedNow });
    const intentId = 'pend-no-status';
    await ledger.recordIntent({
      id: intentId,
      agentId: DEMO_POLICY.agentId,
      payee: 'openai-api',
      amount: 12,
      currency: 'USD',
      purpose: 'x',
      createdAt: fixedNow().toISOString(),
    });
    await ledger.recordDecision(intentId, { status: 'approved', reason: 'within_policy: ok' });
    await ledger.recordPayment(intentId, 'paid');
    await ledger.recordReceipt(intentId, {
      intentId,
      rail: 'mock',
      externalId: 'mock_x',
      status: 'pending',
      at: fixedNow().toISOString(),
    });
    const adapter: PaymentAdapter = {
      rail: 'mock',
      async pay(i) {
        return {
          intentId: i.id,
          rail: 'mock',
          externalId: 'mock_y',
          status: 'pending',
          at: fixedNow().toISOString(),
        };
      },
    };
    await expect(refreshIntent(intentId, ledger, adapter)).rejects.toMatchObject({
      code: 'status_unsupported',
    });
  });

  it('unknown id -> intent_not_found', async () => {
    const client = createInMemoryClient({ now: fixedNow, newId });
    await expect(client.refresh('missing')).rejects.toMatchObject({ code: 'intent_not_found' });
    await expect(client.refresh('missing')).rejects.toBeInstanceOf(PaymentError);
  });

  it('second refresh after settle -> receipt_not_pending', async () => {
    idCounter = 0;
    const client = createInMemoryClient({
      now: fixedNow,
      newId,
      pendingSettlement: { afterChecks: 1 },
    });
    const out = await client.submitIntent(draft(DEMO_SCENARIOS[0]!.task), 'mock');
    await client.refresh(out.intentId);
    await expect(client.refresh(out.intentId)).rejects.toMatchObject({ code: 'receipt_not_pending' });
  });

  it('rejected intent -> no_receipt', async () => {
    idCounter = 0;
    const client = createInMemoryClient({ now: fixedNow, newId });
    const out = await client.submitIntent(draft(DEMO_SCENARIOS[1]!.task), 'mock');
    expect(out.status).toBe('rejected');
    await expect(client.refresh(out.intentId)).rejects.toMatchObject({ code: 'no_receipt' });
  });
});
