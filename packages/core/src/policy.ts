import type { Decision, LedgerState, PaymentIntent, Policy } from './types.ts';

export const DEFAULT_CURRENCY = 'USD';

export const ReasonCode = {
  AgentMismatch: 'agent_mismatch',
  CurrencyMismatch: 'currency_mismatch',
  InvalidAmount: 'invalid_amount',
  PayeeNotAllowed: 'payee_not_allowed',
  PerTxLimitExceeded: 'per_tx_limit_exceeded',
  DailyLimitExceeded: 'daily_limit_exceeded',
  ApprovalRequired: 'approval_required',
  WithinPolicy: 'within_policy',
} as const;
export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

/** Returns the reason code at the start of a Decision.reason. */
export function reasonCode(decision: Decision): string {
  const i = decision.reason.indexOf(':');
  return i === -1 ? decision.reason : decision.reason.slice(0, i);
}

const reject = (code: ReasonCode, detail: string): Decision => ({
  status: 'rejected',
  reason: `${code}: ${detail}`,
});

/**
 * Pure policy check. No I/O, no clock. Checks run in this order and the first
 * failure wins: agent, currency, amount, payee, per-tx limit, daily limit,
 * approval threshold. All limits are inclusive (amount == limit passes).
 */
export function evaluate(policy: Policy, intent: PaymentIntent, ledgerState: LedgerState): Decision {
  if (intent.agentId !== policy.agentId) {
    return reject(ReasonCode.AgentMismatch, `intent agent "${intent.agentId}" does not match policy agent "${policy.agentId}"`);
  }
  const policyCurrency = (policy.currency ?? DEFAULT_CURRENCY).toUpperCase();
  if (String(intent.currency).toUpperCase() !== policyCurrency) {
    return reject(ReasonCode.CurrencyMismatch, `intent currency "${intent.currency}" does not match policy currency "${policyCurrency}"`);
  }
  const amount = intent.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return reject(ReasonCode.InvalidAmount, `amount must be a finite number > 0, got ${String(amount)}`);
  }
  if (!policy.allowedPayees.includes(intent.payee)) {
    return reject(ReasonCode.PayeeNotAllowed, `payee "${intent.payee}" is not in the allowed list`);
  }
  if (amount > policy.perTxMax) {
    return reject(ReasonCode.PerTxLimitExceeded, `amount ${amount} exceeds per-transaction max ${policy.perTxMax}`);
  }
  const projected = ledgerState.dailyTotal + amount;
  if (projected > policy.dailyMax) {
    return reject(
      ReasonCode.DailyLimitExceeded,
      `today's total ${ledgerState.dailyTotal} + ${amount} = ${projected} exceeds daily max ${policy.dailyMax}`,
    );
  }
  if (amount > policy.requireApprovalAbove) {
    return {
      status: 'needs_approval',
      reason: `${ReasonCode.ApprovalRequired}: amount ${amount} is above approval threshold ${policy.requireApprovalAbove}`,
    };
  }
  return { status: 'approved', reason: `${ReasonCode.WithinPolicy}: amount ${amount} ${policyCurrency} to "${intent.payee}" is within policy` };
}
