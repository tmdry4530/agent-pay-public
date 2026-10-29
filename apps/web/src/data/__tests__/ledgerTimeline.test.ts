import { ReasonCode } from '@agent-pay/core/policy.ts';
import type { LedgerEntry, PaymentIntent } from '@agent-pay/core';
import { describe, expect, it } from 'vitest';
import { entriesToTimeline } from '../ledgerTimeline';

const baseIntent: PaymentIntent = {
  id: 'intent-75',
  createdAt: '2026-01-01T10:00:00.000Z',
  agentId: 'demo-agent',
  payee: 'near-compute',
  amount: 75,
  currency: 'USD',
  purpose: 'NEAR compute',
};

function entry(partial: Partial<LedgerEntry> & Pick<LedgerEntry, 'intent'>): LedgerEntry {
  return {
    decisions: [],
    recordedAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    ...partial,
  };
}

describe('entriesToTimeline', () => {
  it('$75 two-step history: needs_approval then human approve', () => {
    const e = entry({
      intent: baseIntent,
      recordedAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:05:00.000Z',
      decision: {
        status: 'approved',
        reason: `${ReasonCode.ApprovedByHuman}: approved by "demo-operator"; 75 USD to "near-compute" is within hard limits`,
      },
      decisions: [
        {
          status: 'needs_approval',
          reason: `${ReasonCode.ApprovalRequired}: amount 75 is above approval threshold 50`,
          at: '2026-01-01T10:01:00.000Z',
          actor: 'policy',
        },
        {
          status: 'approved',
          reason: `${ReasonCode.ApprovedByHuman}: approved by "demo-operator"; 75 USD to "near-compute" is within hard limits`,
          at: '2026-01-01T10:02:00.000Z',
          actor: 'demo-operator',
        },
      ],
      paymentStatus: 'paid',
    });

    const events = entriesToTimeline([e]);
    const decisions = events.filter((ev) => ev.kind === 'decision');

    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      id: 'intent-75-decision-1',
      label: 'human approved',
      actor: 'demo-operator',
      at: '2026-01-01T10:02:00.000Z',
    });
    expect(decisions[1]).toMatchObject({
      id: 'intent-75-decision-0',
      label: 'approval required',
      actor: 'policy',
      at: '2026-01-01T10:01:00.000Z',
    });
  });

  it('falls back to entry.decision when decisions is empty', () => {
    const e = entry({
      intent: { ...baseIntent, id: 'legacy' },
      updatedAt: '2026-01-01T11:00:00.000Z',
      decision: { status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok` },
      decisions: [],
    });

    const events = entriesToTimeline([e]);
    const decisions = events.filter((ev) => ev.kind === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      id: 'legacy-decision-0',
      label: 'policy decision',
      at: '2026-01-01T11:00:00.000Z',
    });
  });

  it('includes resolution event fields', () => {
    const e = entry({
      intent: { ...baseIntent, id: 'resolved' },
      decision: { status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok` },
      decisions: [{ status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok`, at: '2026-01-01T10:00:00.000Z' }],
      paymentStatus: 'paid',
      resolution: {
        status: 'refunded',
        resolvedBy: 'ops-user',
        note: 'customer refund',
        at: '2026-01-01T12:00:00.000Z',
        previousExternalId: 'mock_old_123',
      },
    });

    const events = entriesToTimeline([e]);
    const resolution = events.find((ev) => ev.kind === 'resolution');
    expect(resolution).toMatchObject({
      id: 'resolved-resolution',
      label: 'resolved refunded',
      detail: 'customer refund',
      actor: 'ops-user',
      at: '2026-01-01T12:00:00.000Z',
      previousExternalId: 'mock_old_123',
    });
  });

  it('includes payment submitting and manual resolve receipt events', () => {
    const submitting = entry({
      intent: { ...baseIntent, id: 'sub' },
      decisions: [{ status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok`, at: '2026-01-01T10:00:00.000Z' }],
      paymentStatus: 'submitting' as unknown as LedgerEntry['paymentStatus'],
      updatedAt: '2026-01-01T10:01:00.000Z',
    });
    expect(entriesToTimeline([submitting]).some((e) => e.label === 'payment submitting')).toBe(true);

    const manual = entry({
      intent: { ...baseIntent, id: 'manual' },
      decisions: [{ status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok`, at: '2026-01-01T10:00:00.000Z' }],
      paymentStatus: 'paid',
      receipt: {
        intentId: 'manual',
        status: 'pending',
        rail: 'mock',
        externalId: '',
        at: '2026-01-01T10:02:00.000Z',
        meta: { needsManualResolve: 'true', error: 'timeout' },
      } as LedgerEntry['receipt'],
    });
    const manualEv = entriesToTimeline([manual]).find((e) => e.label === 'receipt needs manual resolution');
    expect(manualEv?.warn).toBe(true);
  });

  it('tie-breaks equal timestamps within one intent (resolution > receipt > payment > decisions > intent)', () => {
    const same = '2026-01-01T10:00:00.000Z';
    const e = entry({
      intent: { ...baseIntent, id: 'tie' },
      recordedAt: same,
      updatedAt: same,
      decision: { status: 'approved', reason: `${ReasonCode.WithinPolicy}: ok` },
      decisions: [
        { status: 'needs_approval', reason: `${ReasonCode.ApprovalRequired}: first`, at: same, actor: 'policy' },
        { status: 'approved', reason: `${ReasonCode.ApprovedByHuman}: second`, at: same, actor: 'demo-operator' },
      ],
      paymentStatus: 'paid',
      receipt: {
        intentId: 'tie',
        rail: 'mock',
        status: 'succeeded',
        externalId: 'mock_ext',
        at: same,
      },
      resolution: {
        status: 'succeeded',
        resolvedBy: 'ops',
        note: 'manual fix',
        at: same,
        previousExternalId: 'prev_id',
      },
    });

    const order = entriesToTimeline([e]).map((ev) => ev.id);
    expect(order).toEqual([
      'tie-resolution',
      'tie-receipt',
      'tie-paid',
      'tie-decision-1',
      'tie-decision-0',
      'tie-intent',
    ]);
  });
});
