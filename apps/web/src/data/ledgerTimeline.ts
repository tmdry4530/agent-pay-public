import { ReasonCode, reasonCode } from '@agent-pay/core/policy.ts';
import type { Decision, DecisionRecord, LedgerEntry } from '@agent-pay/core';

export type TimelineEventKind = 'intent' | 'decision' | 'payment' | 'receipt' | 'resolution';

export type TimelineEvent = {
  id: string;
  at: string;
  label: string;
  detail?: string;
  actor?: string;
  kind?: TimelineEventKind;
  /** Present on manual resolution events (operator resolve). */
  previousExternalId?: string;
};

/** Lifecycle tie-break when two events share the same `at` within one intent (higher = newer in UI). */
const SEQ = {
  intent: 0,
  decision: (index: number) => 10 + index,
  payment: 100,
  receipt: 200,
  resolution: 300,
} as const;

type SortableEvent = TimelineEvent & { sortSeq: number };

function decisionLabel(record: Decision): string {
  const code = reasonCode(record);
  if (code === ReasonCode.ApprovedByHuman) return 'human approved';
  if (code === ReasonCode.RejectedByHuman) return 'human rejected';
  if (record.status === 'needs_approval') return 'approval required';
  return 'policy decision';
}

function decisionRecords(entry: LedgerEntry): DecisionRecord[] {
  if (entry.decisions.length > 0) return entry.decisions;
  if (entry.decision) {
    return [{ ...entry.decision, at: entry.updatedAt }];
  }
  return [];
}

export function entriesToTimeline(entries: LedgerEntry[]): TimelineEvent[] {
  const events: SortableEvent[] = [];
  for (const entry of entries) {
    const intentId = entry.intent.id;
    events.push({
      id: `${intentId}-intent`,
      at: entry.recordedAt,
      label: 'intent recorded',
      detail: `${entry.intent.purpose} · ${entry.intent.payee}`,
      kind: 'intent',
      sortSeq: SEQ.intent,
    });

    const records = decisionRecords(entry);
    records.forEach((record, i) => {
      events.push({
        id: `${intentId}-decision-${i}`,
        at: record.at ?? entry.updatedAt,
        label: decisionLabel(record),
        detail: record.reason,
        actor: record.actor,
        kind: 'decision',
        sortSeq: SEQ.decision(i),
      });
    });

    if (entry.paymentStatus === 'paid') {
      events.push({
        id: `${intentId}-paid`,
        at: entry.updatedAt,
        label: 'payment paid',
        kind: 'payment',
        sortSeq: SEQ.payment,
      });
    } else if (entry.paymentStatus === 'failed') {
      events.push({
        id: `${intentId}-failed`,
        at: entry.updatedAt,
        label: 'payment failed',
        kind: 'payment',
        sortSeq: SEQ.payment,
      });
    }

    if (entry.receipt) {
      events.push({
        id: `${intentId}-receipt`,
        at: entry.receipt.at,
        label: `receipt ${entry.receipt.status}`,
        detail: `${entry.receipt.rail} · ${entry.receipt.externalId}`,
        kind: 'receipt',
        sortSeq: SEQ.receipt,
      });
    }

    if (entry.resolution) {
      const { status, resolvedBy, note, at, previousExternalId } = entry.resolution;
      events.push({
        id: `${intentId}-resolution`,
        at,
        label: `resolved ${status}`,
        detail: note,
        actor: resolvedBy,
        kind: 'resolution',
        previousExternalId,
        sortSeq: SEQ.resolution,
      });
    }
  }

  events.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return b.sortSeq - a.sortSeq;
  });

  return events.map(({ sortSeq: _sortSeq, ...ev }) => ev);
}

function approverFromReason(decisionReason: string): string | null {
  const approved = decisionReason.match(/approved by "([^"]+)"/);
  if (approved) return approved[1]!;
  const rejected = decisionReason.match(/rejected by "([^"]+)"/);
  if (rejected) return rejected[1]!;
  return null;
}

export function humanOutcomeText(decisionReason: string, approver = 'demo-operator'): string | null {
  const code = reasonCode({ status: 'approved', reason: decisionReason });
  const who = approverFromReason(decisionReason) ?? approver;
  if (code === ReasonCode.ApprovedByHuman) {
    return `Approved by human (${who})`;
  }
  if (code === ReasonCode.RejectedByHuman) {
    return `Rejected by human (${who})`;
  }
  return null;
}
