import { ReasonCode, reasonCode } from '@agent-pay/core/policy.ts';
import type { LedgerEntry } from '@agent-pay/core';

export type TimelineEvent = {
  id: string;
  at: string;
  label: string;
  detail?: string;
};

export function entriesToTimeline(entries: LedgerEntry[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const entry of entries) {
    events.push({
      id: `${entry.intent.id}-intent`,
      at: entry.recordedAt,
      label: 'intent recorded',
      detail: `${entry.intent.purpose} · ${entry.intent.payee}`,
    });
    if (entry.decision) {
      const code = reasonCode(entry.decision);
      if (code === ReasonCode.ApprovedByHuman) {
        events.push({
          id: `${entry.intent.id}-human-approved`,
          at: entry.updatedAt,
          label: 'human approved',
          detail: entry.decision.reason,
        });
      } else if (code === ReasonCode.RejectedByHuman) {
        events.push({
          id: `${entry.intent.id}-human-rejected`,
          at: entry.updatedAt,
          label: 'human rejected',
          detail: entry.decision.reason,
        });
      } else {
        events.push({
          id: `${entry.intent.id}-decision`,
          at: entry.updatedAt,
          label: 'policy decision',
          detail: entry.decision.reason,
        });
      }
    }
    if (entry.paymentStatus === 'paid') {
      events.push({
        id: `${entry.intent.id}-paid`,
        at: entry.updatedAt,
        label: 'payment paid',
      });
    } else if (entry.paymentStatus === 'failed') {
      events.push({
        id: `${entry.intent.id}-failed`,
        at: entry.updatedAt,
        label: 'payment failed',
      });
    }
    if (entry.receipt) {
      events.push({
        id: `${entry.intent.id}-receipt`,
        at: entry.receipt.at,
        label: `receipt ${entry.receipt.status}`,
        detail: `${entry.receipt.rail} · ${entry.receipt.externalId}`,
      });
    }
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
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
