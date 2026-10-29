/**
 * Compatibility parsers for in-flight API/core shape changes (align with main ~2026-10-31).
 *
 * Assumptions (update this header when shapes land):
 * A. Submitting: LedgerEntry.paymentStatus may be 'submitting'; also entry.status/state === 'submitting';
 *    PaymentResult.status may be 'submitting'.
 * B. Manual resolve: receipt.meta.needsManualResolve 'true'|true with receipt.status 'pending' (or missing
 *    receipt with paymentStatus paid/submitting); top-level entry.needsManualResolve; result.needsManualResolve.
 *    False once receipt is succeeded/failed/refunded or entry.resolution is set.
 * C. Race loss: HTTP 409 with code not_pending | already_paid; on approve/reject any 409 except intent_conflict
 *    counts as race loss when action is approve|reject.
 * D. Decision reasons: "code: detail"; invalid_policy and invalid_amount labels documented below.
 * E. Ledger today totals: primary Record<agentId, Record<CURRENCY, number>>; alternate totalsByCurrency;
 *    legacy per-agent number maps to fallbackCurrency; flat Record<CUR,number> when keys look like currency
 *    codes and no agentId key is present at the top level (heuristic: all own keys match /^[A-Z]{3,4}$/ and
 *    values are finite numbers).
 *
 * All tolerant parsing lives in this module; consumers use the exported helpers only.
 */

import { ReasonCode } from '@agent-pay/core/policy.ts';
import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import { ApiError, apiErrorCode } from './apiError';

const CURRENCY_KEY = /^[A-Z]{3,4}$/;

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as LooseRecord;
}

function readStringField(obj: LooseRecord, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function readSubmittingFlag(obj: LooseRecord): boolean {
  const status = readStringField(obj, 'status');
  const state = readStringField(obj, 'state');
  return status === 'submitting' || state === 'submitting';
}

function readNeedsManualResolveFlag(obj: LooseRecord): boolean {
  const v = obj.needsManualResolve;
  if (v === true || v === 'true') return true;
  return false;
}

function receiptBlocksManualResolve(receipt: LooseRecord | undefined): boolean {
  if (!receipt) return false;
  const status = readStringField(receipt, 'status');
  return status === 'succeeded' || status === 'failed' || status === 'refunded';
}

function metaNeedsManualResolve(receipt: LooseRecord | undefined): boolean {
  if (!receipt) return false;
  const meta = asRecord(receipt.meta);
  if (!meta) return false;
  const v = meta.needsManualResolve;
  return v === true || v === 'true';
}

/** True when a ledger entry (or compatible object) represents payment in flight. */
export function isSubmitting(entry: unknown): boolean {
  const obj = asRecord(entry);
  if (!obj) return false;
  if (obj.paymentStatus === 'submitting') return true;
  if (readSubmittingFlag(obj)) return true;
  return false;
}

/** True when a payment result indicates submitting (future core shape). */
export function isSubmittingResult(result: unknown): boolean {
  const obj = asRecord(result);
  if (!obj) return false;
  if (obj.status === 'submitting') return true;
  return isSubmitting(obj);
}

/**
 * True when operator manual resolution is needed (pending / unknown outcome).
 * False once receipt is terminal or entry.resolution exists.
 */
export function needsManualResolve(entry: unknown): boolean {
  const obj = asRecord(entry);
  if (!obj) return false;
  if (obj.resolution !== undefined && obj.resolution !== null) return false;

  const receipt = asRecord(obj.receipt);
  if (receipt && receiptBlocksManualResolve(receipt)) return false;

  const topLevel = readNeedsManualResolveFlag(obj);
  const fromMeta = metaNeedsManualResolve(receipt);
  const flagged = topLevel || fromMeta;
  if (!flagged) return false;

  if (!receipt) {
    const ps = obj.paymentStatus;
    return ps === 'paid' || ps === 'submitting';
  }

  const status = readStringField(receipt, 'status');
  return status === 'pending' || status === undefined;
}

export type AlreadyProcessedOptions = {
  action?: 'approve' | 'reject';
};

const RACE_CODES = new Set(['not_pending', 'already_paid']);

/** True when approve/reject lost a race (intent already processed). */
export function isAlreadyProcessed(err: unknown, options: AlreadyProcessedOptions = {}): boolean {
  if (err instanceof PaymentError) {
    return RACE_CODES.has(err.code);
  }
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const code = apiErrorCode(err);
  if (code && RACE_CODES.has(code)) return true;
  if (options.action === 'approve' || options.action === 'reject') {
    if (code === 'intent_conflict') return false;
    return true;
  }
  return false;
}

const REASON_LABELS: Record<string, { label: string; explanation?: string }> = {
  [ReasonCode.AgentMismatch]: { label: 'Agent mismatch' },
  [ReasonCode.CurrencyMismatch]: { label: 'Currency mismatch' },
  [ReasonCode.InvalidAmount]: {
    label: 'Invalid amount',
    explanation: 'The payment amount is not a valid positive number.',
  },
  [ReasonCode.PayeeNotAllowed]: { label: 'Payee not allowed' },
  [ReasonCode.PerTxLimitExceeded]: { label: 'Per-transaction limit exceeded' },
  [ReasonCode.DailyLimitExceeded]: { label: 'Daily limit exceeded' },
  [ReasonCode.ApprovalRequired]: { label: 'Approval required' },
  [ReasonCode.WithinPolicy]: { label: 'Within policy' },
  [ReasonCode.ApprovedByHuman]: { label: 'Approved by operator' },
  [ReasonCode.RejectedByHuman]: { label: 'Rejected by operator' },
  invalid_policy: {
    label: 'Invalid policy',
    explanation:
      'The spending policy is malformed (e.g. a missing or non-numeric limit), so the agent fails closed and rejects every payment until the policy is fixed.',
  },
};

function humanizeCode(code: string): string {
  return code
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Parses "code: detail" decision / error reasons for display. */
export function reasonInfo(reason: string): {
  code: string;
  label: string;
  explanation?: string;
  detail: string;
} {
  const i = reason.indexOf(':');
  const code = i === -1 ? reason.trim() : reason.slice(0, i).trim();
  const detail = i === -1 ? '' : reason.slice(i + 1).trim();
  const mapped = REASON_LABELS[code];
  return {
    code,
    label: mapped?.label ?? humanizeCode(code),
    explanation: mapped?.explanation,
    detail,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mergeCurrencyMap(
  target: Record<string, number>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    const n = finiteNumber(value);
    if (n === undefined) continue;
    const cur = key.toUpperCase();
    target[cur] = (target[cur] ?? 0) + n;
  }
}

function looksLikeFlatCurrencyTotals(obj: LooseRecord, agentId: string): boolean {
  if (agentId in obj) return false;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  return keys.every((k) => CURRENCY_KEY.test(k.toUpperCase()) && finiteNumber(obj[k]) !== undefined);
}

/**
 * Normalizes GET /ledger `today` (or compatible) to currency -> amount for one agent.
 */
export function normalizeTotals(
  today: unknown,
  opts: { agentId: string; fallbackCurrency: string },
): Record<string, number> {
  const out: Record<string, number> = {};
  const fallback = opts.fallbackCurrency.toUpperCase();
  const root = asRecord(today);
  if (!root) return out;

  const totalsByCurrency = asRecord(root.totalsByCurrency);
  if (totalsByCurrency) {
    const perAgent = asRecord(totalsByCurrency[opts.agentId]);
    if (perAgent) mergeCurrencyMap(out, perAgent);
  }

  const totals = root.totals;
  if (totals === null || totals === undefined) {
    return out;
  }

  if (typeof totals === 'number') {
    if (Number.isFinite(totals)) out[fallback] = totals;
    return out;
  }

  const totalsObj = asRecord(totals);
  if (!totalsObj) return out;

  if (looksLikeFlatCurrencyTotals(totalsObj, opts.agentId)) {
    mergeCurrencyMap(out, totalsObj);
    return out;
  }

  const agentTotals = totalsObj[opts.agentId];
  if (typeof agentTotals === 'number') {
    if (Number.isFinite(agentTotals)) out[fallback] = (out[fallback] ?? 0) + agentTotals;
    return out;
  }

  const perCur = asRecord(agentTotals);
  if (perCur) mergeCurrencyMap(out, perCur);

  return out;
}

/** Reads normalized daily spend for one currency from a ledger snapshot `today` block. */
export function dailyTotalForAgent(
  today: unknown,
  opts: { agentId: string; fallbackCurrency: string; currency?: string },
): number {
  const map = normalizeTotals(today, opts);
  const cur = (opts.currency ?? opts.fallbackCurrency).toUpperCase();
  return map[cur] ?? 0;
}
