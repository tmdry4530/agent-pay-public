import { ReasonCode } from '@agent-pay/core/policy.ts';
import type { LedgerEntry } from '@agent-pay/core';
import { describe, expect, it } from 'vitest';
import { deriveIntentFlow } from '../intentFlow';

function entry(partial: Partial<LedgerEntry> & Pick<LedgerEntry, 'intent'>): LedgerEntry {
  return {
    decisions: [],
    recordedAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:01.000Z',
    ...partial,
  };
}

const baseIntent = {
  id: 'i1',
  createdAt: '2026-01-01T12:00:00.000Z',
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 12,
  currency: 'USD',
  purpose: 'Buy API credits',
};

describe('deriveIntentFlow', () => {
  it('direct approval skips human approval and completes paid', () => {
    const flow = deriveIntentFlow(
      entry({
        intent: baseIntent,
        decision: {
          status: 'approved',
          reason: `${ReasonCode.WithinPolicy}: ok`,
        },
        decisions: [
          { status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok`, actor: 'policy' },
        ],
        paymentStatus: 'paid',
        receipt: {
          status: 'succeeded',
          rail: 'mock',
          externalId: 'mock_1',
          at: '2026-01-01T12:00:02.000Z',
        },
      }),
    );
    expect(flow.overall).toBe('paid');
    expect(flow.stages.find((s) => s.id === 'approval')?.state).toBe('skipped');
    expect(flow.stages.find((s) => s.id === 'receipt')?.state).toBe('done');
  });

  it('needs approval waits on approval stage', () => {
    const flow = deriveIntentFlow(
      entry({
        intent: baseIntent,
        decisions: [
          {
            status: 'needs_approval',
            reason: `${ReasonCode.ApprovalRequired}: threshold`,
            actor: 'policy',
          },
        ],
        decision: {
          status: 'needs_approval',
          reason: `${ReasonCode.ApprovalRequired}: threshold`,
        },
      }),
    );
    expect(flow.overall).toBe('awaiting_approval');
    expect(flow.stages.find((s) => s.id === 'approval')?.state).toBe('waiting');
  });

  it('human approved then paid', () => {
    const flow = deriveIntentFlow(
      entry({
        intent: { ...baseIntent, amount: 75 },
        decisions: [
          {
            status: 'needs_approval',
            reason: `${ReasonCode.ApprovalRequired}: threshold`,
            actor: 'policy',
          },
          {
            status: 'approved',
            reason: `${ReasonCode.ApprovedByHuman}: approved by "demo-operator"`,
            actor: 'demo-operator',
          },
        ],
        paymentStatus: 'paid',
        receipt: {
          status: 'succeeded',
          rail: 'paypal',
          externalId: 'x',
          at: '2026-01-01T12:00:03.000Z',
        },
      }),
    );
    expect(flow.overall).toBe('paid');
    expect(flow.stages.find((s) => s.id === 'approval')?.state).toBe('done');
  });

  it('human rejected', () => {
    const flow = deriveIntentFlow(
      entry({
        intent: { ...baseIntent, amount: 75 },
        decisions: [
          {
            status: 'needs_approval',
            reason: `${ReasonCode.ApprovalRequired}: threshold`,
            actor: 'policy',
          },
          {
            status: 'rejected',
            reason: `${ReasonCode.RejectedByHuman}: rejected by "demo-operator"`,
            actor: 'demo-operator',
          },
        ],
      }),
    );
    expect(flow.overall).toBe('rejected_by_human');
    expect(flow.stages.find((s) => s.id === 'approval')?.state).toBe('rejected');
    expect(flow.stages.find((s) => s.id === 'payment')?.state).toBe('upcoming');
  });

  it('policy rejected', () => {
    const flow = deriveIntentFlow(
      entry({
        intent: baseIntent,
        decisions: [
          {
            status: 'rejected',
            reason: `${ReasonCode.PerTxLimitExceeded}: too big`,
            actor: 'policy',
          },
        ],
      }),
    );
    expect(flow.overall).toBe('rejected_by_policy');
    expect(flow.stages.find((s) => s.id === 'policy')?.state).toBe('rejected');
    expect(flow.stages.find((s) => s.id === 'approval')?.state).toBe('skipped');
  });

  it('payment failed', () => {
    const flow = deriveIntentFlow(
      entry({
        intent: baseIntent,
        decisions: [
          { status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok`, actor: 'policy' },
        ],
        paymentStatus: 'failed',
      }),
    );
    expect(flow.overall).toBe('failed');
    expect(flow.stages.find((s) => s.id === 'payment')?.state).toBe('failed');
  });

  it('pending receipt', () => {
    const flow = deriveIntentFlow(
      entry({
        intent: baseIntent,
        decisions: [
          { status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok`, actor: 'policy' },
        ],
        paymentStatus: 'paid',
        receipt: {
          status: 'pending',
          rail: 'mock',
          externalId: 'mock_p',
          at: '2026-01-01T12:00:02.000Z',
        },
      }),
    );
    expect(flow.overall).toBe('pending');
    expect(flow.stages.find((s) => s.id === 'receipt')?.state).toBe('pending');
  });

  it('resolved via operator', () => {
    const flow = deriveIntentFlow(
      entry({
        intent: baseIntent,
        decisions: [
          { status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok`, actor: 'policy' },
        ],
        paymentStatus: 'paid',
        receipt: {
          status: 'succeeded',
          rail: 'mock',
          externalId: 'mock_2',
          at: '2026-01-01T12:00:02.000Z',
        },
        resolution: {
          status: 'succeeded',
          resolvedBy: 'ops',
          note: 'manual',
          at: '2026-01-01T12:10:00.000Z',
          previousExternalId: 'mock_p',
        },
      }),
    );
    expect(flow.overall).toBe('resolved');
  });
});
