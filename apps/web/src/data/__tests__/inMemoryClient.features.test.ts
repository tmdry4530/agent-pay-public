import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../apiError';
import { isAlreadyProcessed, isSubmitting, needsManualResolve, normalizeTotals } from '../compat';
import { DEMO_POLICY, createInMemoryClient } from '../inMemoryClient';
import { MemoryLedger, countsTowardDailyTotal, utcDay } from '../memoryLedger';
import type { IntentDraft } from '../agentPayClient';

describe('inMemoryClient data-layer scenarios', () => {
  const fixedNow = () => new Date('2026-01-15T12:00:00.000Z');
  let idCounter = 0;
  const newId = () => `test-id-${++idCounter}`;

  const smallDraft: IntentDraft = {
    agentId: DEMO_POLICY.agentId,
    payee: 'openai-api',
    amount: 12,
    currency: 'USD',
    purpose: 'test',
  };

  it('getLedger returns per-currency totals (two currencies)', async () => {
    const ledger = new MemoryLedger({ now: fixedNow });
    const day = utcDay(fixedNow());
    await ledger.recordIntent({
      ...smallDraft,
      id: 'u1',
      createdAt: fixedNow().toISOString(),
      currency: 'USD',
    });
    await ledger.recordDecision('u1', { status: 'approved', reason: 'within_policy: ok' });
    await ledger.recordIntent({
      ...smallDraft,
      id: 'u2',
      createdAt: fixedNow().toISOString(),
      currency: 'eur',
      amount: 5,
    });
    await ledger.recordDecision('u2', { status: 'approved', reason: 'within_policy: ok' });
    await ledger.recordPayment('u2', 'paid');

    const entries = await ledger.list();
    const totals: Record<string, Record<string, number>> = {};
    for (const e of entries) {
      if (utcDay(e.intent.createdAt) === day && countsTowardDailyTotal(e)) {
        const cur = String(e.intent.currency).toUpperCase();
        const agent = e.intent.agentId;
        totals[agent] ??= {};
        totals[agent][cur] = (totals[agent][cur] ?? 0) + e.intent.amount;
      }
    }
    expect(totals[DEMO_POLICY.agentId]).toEqual({ USD: 12, EUR: 5 });
  });

  it('submitting visible during delayed pay then cleared', async () => {
    vi.useFakeTimers();
    try {
      idCounter = 0;
      const client = createInMemoryClient({ now: fixedNow, newId, payDelayMs: 500 });
      const payPromise = client.submitIntent(smallDraft, 'mock');
      await vi.advanceTimersByTimeAsync(100);
      const snap = await client.getLedger();
      expect(snap.entries.length).toBeGreaterThan(0);
      expect(isSubmitting(snap.entries[0]!)).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      const result = await payPromise;
      expect(result.status).toBe('paid');
      const after = await client.getLedger();
      expect(isSubmitting(after.entries[0]!)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual-resolve payOutcome keeps pending, counts toward total, refresh unchanged', async () => {
    idCounter = 0;
    const client = createInMemoryClient({ now: fixedNow, newId, payOutcome: 'timeout', payDelayMs: 0 });
    const out = await client.submitIntent(smallDraft, 'mock');
    expect(out.status).toBe('paid');
    expect(out.receipt?.status).toBe('pending');
    const entry = (await client.getLedger()).entries[0]!;
    expect(needsManualResolve(entry)).toBe(true);
    const total =
      normalizeTotals((await client.getLedger()).today, {
        agentId: DEMO_POLICY.agentId,
        fallbackCurrency: 'USD',
      }).USD ?? 0;
    expect(total).toBe(12);
    const refreshed = await client.refresh(out.intentId);
    expect(refreshed.changed).toBe(false);
    expect(refreshed.receipt?.status).toBe('pending');
  });

  it('invalidPolicy rejects with invalid_policy reason', async () => {
    idCounter = 0;
    const client = createInMemoryClient({ now: fixedNow, newId, invalidPolicy: true });
    const out = await client.submitIntent(smallDraft, 'mock');
    expect(out.status).toBe('rejected');
    expect(out.decision.reason).toMatch(/^invalid_policy:/);
  });

  it('double approve throws ApiError 409 recognized by isAlreadyProcessed', async () => {
    idCounter = 0;
    const client = createInMemoryClient({ now: fixedNow, newId });
    const draft: IntentDraft = { ...smallDraft, amount: 75 };
    const submitted = await client.submitIntent(draft, 'mock');
    expect(submitted.status).toBe('needs_approval');
    await client.approve(submitted.intentId);
    let err: unknown;
    try {
      await client.approve(submitted.intentId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect(isAlreadyProcessed(err, { action: 'approve' })).toBe(true);
  });
});
