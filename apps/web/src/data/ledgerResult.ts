import type { Decision, LedgerEntry } from '@agent-pay/core';
import { FailureCode } from '@agent-pay/core/orchestrator.ts';
import type { PaymentResult } from '../types';
import { isSubmitting } from './compat';

function latestDecision(entry: LedgerEntry): Decision {
  if (entry.decisions.length > 0) return entry.decisions[entry.decisions.length - 1]!;
  if (entry.decision) return entry.decision;
  throw new Error(`ledger entry ${entry.intent.id} has no decision`);
}

/** Reconstruct pipeline PaymentResult from a ledger entry (e.g. after race-loss refresh). */
export function paymentResultFromLedgerEntry(entry: LedgerEntry): PaymentResult {
  const decision = latestDecision(entry);
  const base = { intentId: entry.intent.id, decision };

  if (decision.status === 'rejected' || decision.status === 'needs_approval') {
    return { ...base, status: decision.status };
  }

  if (isSubmitting(entry)) {
    return { ...base, status: 'submitting' as PaymentResult['status'] };
  }

  if (entry.paymentStatus === 'failed' || entry.receipt?.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      ...(entry.receipt ? { receipt: entry.receipt } : {}),
      error: `${FailureCode.PaymentFailed}: recorded as failed`,
    };
  }

  if (entry.paymentStatus === 'paid' || entry.receipt) {
    return {
      ...base,
      status: 'paid',
      ...(entry.receipt ? { receipt: entry.receipt } : {}),
    };
  }

  return { ...base, status: 'paid' };
}
