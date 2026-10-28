import { ReasonCode } from '@agent-pay/core/policy.ts';
import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIOS } from '../../types';
import { DEMO_POLICY, createInMemoryClient } from '../inMemoryClient';
import type { IntentDraft, Rail } from '../agentPayClient';

describe('AgentPay in-memory client', () => {
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

  it('paid path with receipt succeeded per rail and labelled ids', async () => {
    const rails: Rail[] = ['mock', 'paypal', 'near'];
    for (const rail of rails) {
      idCounter = 0;
      const client = createInMemoryClient({ now: fixedNow, newId });
      const out = await client.submitIntent(draft(DEMO_SCENARIOS[0]!.task), rail);
      expect(out.status).toBe('paid');
      expect(out.receipt?.status).toBe('succeeded');
      if (rail === 'mock') {
        expect(out.receipt?.externalId).toMatch(/^mock_/);
      } else if (rail === 'paypal') {
        expect(out.receipt?.externalId).toMatch(/^MOCK-PAYPAL-ORDER-/);
      } else {
        expect(out.receipt?.externalId).toMatch(/^mock-near-tx-/);
      }
    }
  });

  it('rejects per_tx_limit_exceeded scenario', async () => {
    const client = createInMemoryClient({ now: fixedNow, newId });
    const out = await client.submitIntent(draft(DEMO_SCENARIOS[1]!.task), 'mock');
    expect(out.status).toBe('rejected');
    expect(out.decision.reason).toMatch(new RegExp(ReasonCode.PerTxLimitExceeded));
  });

  it('rejects payee_not_allowed', async () => {
    const client = createInMemoryClient({ now: fixedNow, newId });
    const out = await client.submitIntent(
      {
        ...draft(DEMO_SCENARIOS[0]!.task),
        payee: 'unknown-vendor',
      },
      'mock',
    );
    expect(out.status).toBe('rejected');
    expect(out.decision.reason).toMatch(new RegExp(ReasonCode.PayeeNotAllowed));
  });

  it('rejects when daily limit exceeded', async () => {
    const client = createInMemoryClient({ now: fixedNow, newId });
    for (let i = 0; i < 16; i++) {
      await client.submitIntent(draft(DEMO_SCENARIOS[0]!.task), 'mock');
    }
    const snap = await client.getLedger();
    expect(snap.today.totals[DEMO_POLICY.agentId]).toBe(192);
    const out = await client.submitIntent(draft(DEMO_SCENARIOS[0]!.task), 'mock');
    expect(out.status).toBe('rejected');
    expect(out.decision.reason).toMatch(new RegExp(ReasonCode.DailyLimitExceeded));
  });

  it('needs_approval then approve yields paid with approved_by_human', async () => {
    const client = createInMemoryClient({ now: fixedNow, newId });
    const submitted = await client.submitIntent(draft(DEMO_SCENARIOS[2]!.task), 'paypal');
    expect(submitted.status).toBe('needs_approval');
    const approved = await client.approve(submitted.intentId);
    expect(approved.status).toBe('paid');
    expect(approved.decision.reason).toMatch(new RegExp(ReasonCode.ApprovedByHuman));
    const snap = await client.getLedger();
    expect(snap.today.totals[DEMO_POLICY.agentId]).toBe(75);
  });

  it('needs_approval then reject yields rejected_by_human; approve after reject throws', async () => {
    const client = createInMemoryClient({ now: fixedNow, newId });
    const submitted = await client.submitIntent(draft(DEMO_SCENARIOS[2]!.task), 'near');
    const rejected = await client.reject(submitted.intentId);
    expect(rejected.status).toBe('rejected');
    expect(rejected.decision.reason).toMatch(new RegExp(ReasonCode.RejectedByHuman));
    await expect(client.approve(submitted.intentId)).rejects.toBeInstanceOf(PaymentError);
  });

  it('reset clears ledger totals', async () => {
    const client = createInMemoryClient({ now: fixedNow, newId });
    await client.submitIntent(draft(DEMO_SCENARIOS[0]!.task), 'mock');
    expect((await client.getLedger()).today.totals[DEMO_POLICY.agentId]).toBe(12);
    await client.reset!();
    expect((await client.getLedger()).entries).toHaveLength(0);
    expect((await client.getLedger()).today.totals[DEMO_POLICY.agentId]).toBeUndefined();
  });
});
