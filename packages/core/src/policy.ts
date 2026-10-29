import { ceilMinorUnits, currencyDecimals, formatMinor, toMinorUnits } from './money.ts';
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
  ApprovedByHuman: 'approved_by_human',
  RejectedByHuman: 'rejected_by_human',
  /** The policy (or the ledger total passed in) is malformed; evaluate fails closed. */
  InvalidPolicy: 'invalid_policy',
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

const isLimit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Why `policy` / `ledgerState` cannot be evaluated safely, or undefined when they can.
 * perTxMax and dailyMax must be finite numbers >= 0; requireApprovalAbove a number >= 0
 * (Infinity allowed: never ask a human); allowedPayees an array of distinct, non-empty strings
 * without leading/trailing whitespace (exact-string comparison, no case folding; a
 * whitespace-only entry is reported as empty); agentId a string;
 * ledgerState.dailyTotal a finite number >= 0.
 */
export function policyProblem(policy: Policy, ledgerState: LedgerState): string | undefined {
  if (typeof policy !== 'object' || policy === null) return 'policy is not an object';
  if (typeof policy.agentId !== 'string') return 'agentId must be a string';
  if (!isLimit(policy.perTxMax)) return `perTxMax must be a finite number >= 0, got ${String(policy.perTxMax)}`;
  if (!isLimit(policy.dailyMax)) return `dailyMax must be a finite number >= 0, got ${String(policy.dailyMax)}`;
  const t = policy.requireApprovalAbove;
  if (typeof t !== 'number' || Number.isNaN(t) || t < 0) return `requireApprovalAbove must be a number >= 0, got ${String(t)}`;
  if (!Array.isArray(policy.allowedPayees)) return 'allowedPayees must be an array';
  const payees = new Set<string>();
  for (const [i, p] of policy.allowedPayees.entries()) {
    if (typeof p !== 'string') return `allowedPayees[${i}] must be a string`;
    if (p.trim() === '') return `allowedPayees[${i}] is empty`;
    if (p.trim() !== p) return `allowedPayees[${i}] ${JSON.stringify(p)} has leading or trailing whitespace`;
    if (payees.has(p)) return `allowedPayees[${i}] ${JSON.stringify(p)} is a duplicate`;
    payees.add(p);
  }
  if (policy.currency !== undefined && typeof policy.currency !== 'string') return 'currency must be a string';
  const currency = (policy.currency ?? DEFAULT_CURRENCY).toUpperCase();
  const decimals = currencyDecimals(currency);
  if (decimals === undefined) return `currency "${currency}" is not supported (no minor-unit definition)`;
  for (const key of ['perTxMax', 'dailyMax', 'requireApprovalAbove'] as const) {
    const v = policy[key];
    if (v !== Number.POSITIVE_INFINITY && toMinorUnits(v, decimals) === undefined) {
      return `${key} ${v} has more than ${decimals} decimal places for ${currency}`;
    }
  }
  if (!isLimit(ledgerState?.dailyTotal)) return `ledger daily total must be a finite number >= 0, got ${String(ledgerState?.dailyTotal)}`;
  const minor = ledgerState.dailyTotalMinor;
  if (minor !== undefined && (typeof minor !== 'bigint' || minor < 0n)) return 'ledger daily total (minor units) must be a bigint >= 0';
  return undefined;
}

/**
 * Pure policy check. No I/O, no clock. Checks run in this order and the first
 * failure wins: policy validity (invalid_policy, fail closed), agent, currency,
 * amount, payee, per-tx limit, daily limit, approval threshold. All limits are
 * inclusive (amount == limit passes).
 */
export function evaluate(policy: Policy, intent: PaymentIntent, ledgerState: LedgerState): Decision {
  const problem = policyProblem(policy, ledgerState);
  if (problem) return reject(ReasonCode.InvalidPolicy, problem);
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
  // Limits and totals are compared in integer minor units (validated representable above).
  const decimals = currencyDecimals(policyCurrency)!;
  const amountMinor = toMinorUnits(amount, decimals);
  if (amountMinor === undefined) {
    return reject(ReasonCode.InvalidAmount, `${policyCurrency} allows at most ${decimals} decimal places, got ${amount}`);
  }
  if (typeof intent.payee !== 'string' || intent.payee.trim() === '') {
    return reject(ReasonCode.PayeeNotAllowed, `payee must be a non-empty string, got ${JSON.stringify(intent.payee)}`);
  }
  if (!policy.allowedPayees.includes(intent.payee)) {
    return reject(ReasonCode.PayeeNotAllowed, `payee "${intent.payee}" is not in the allowed list`);
  }
  if (amountMinor > toMinorUnits(policy.perTxMax, decimals)!) {
    return reject(ReasonCode.PerTxLimitExceeded, `amount ${amount} exceeds per-transaction max ${policy.perTxMax}`);
  }
  const totalMinor = ledgerState.dailyTotalMinor ?? ceilMinorUnits(ledgerState.dailyTotal, decimals)!;
  const projected = totalMinor + amountMinor;
  if (projected > toMinorUnits(policy.dailyMax, decimals)!) {
    const fmt = (m: bigint) => formatMinor(m, decimals);
    return reject(
      ReasonCode.DailyLimitExceeded,
      `today's total ${fmt(totalMinor)} + ${fmt(amountMinor)} = ${fmt(projected)} exceeds daily max ${policy.dailyMax}`,
    );
  }
  const threshold = policy.requireApprovalAbove;
  if (threshold !== Number.POSITIVE_INFINITY && amountMinor > toMinorUnits(threshold, decimals)!) {
    return {
      status: 'needs_approval',
      reason: `${ReasonCode.ApprovalRequired}: amount ${amount} is above approval threshold ${policy.requireApprovalAbove}`,
    };
  }
  return { status: 'approved', reason: `${ReasonCode.WithinPolicy}: amount ${amount} ${policyCurrency} to "${intent.payee}" is within policy` };
}
