import type { Decision, PaymentIntent, Policy } from '../types';

export interface PolicyEngine {
  evaluate(intent: PaymentIntent, spentToday: number): Decision;
}

export function createPolicyEngine(policy: Policy): PolicyEngine {
  return {
    evaluate(intent: PaymentIntent, spentToday: number): Decision {
      if (intent.currency !== policy.currency) {
        return {
          status: 'rejected',
          reason: `Currency ${intent.currency} does not match policy (${policy.currency}).`,
        };
      }

      if (!policy.allowedPayees.includes(intent.payee)) {
        return {
          status: 'rejected',
          reason: `Payee "${intent.payee}" is not on the allowed list.`,
        };
      }

      if (intent.amount > policy.perTxCap) {
        return {
          status: 'rejected',
          reason: `Amount $${intent.amount.toFixed(2)} exceeds per-transaction cap $${policy.perTxCap.toFixed(2)}.`,
        };
      }

      if (spentToday + intent.amount > policy.dailyLimit) {
        return {
          status: 'rejected',
          reason: `Would exceed daily limit ($${policy.dailyLimit.toFixed(2)}); spent today $${spentToday.toFixed(2)}.`,
        };
      }

      if (intent.amount >= policy.autoApproveBelow) {
        return {
          status: 'needs_approval',
          reason: `Amount $${intent.amount.toFixed(2)} is at or above auto-approve threshold $${policy.autoApproveBelow.toFixed(2)}; human review required.`,
        };
      }

      return {
        status: 'approved',
        reason: `Within limits and below auto-approve threshold ($${policy.autoApproveBelow.toFixed(2)}).`,
      };
    },
  };
}
