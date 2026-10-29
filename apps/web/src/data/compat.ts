/**
 * Compatibility parsers for in-flight API/core shape changes.
 *
 * CONFIRMED by packages/core (2026-10):
 * - Submitting: LedgerEntry.paymentStatus === 'submitting'; submission { rail, at }.
 * - Manual resolve: top-level LedgerEntry.needsManualResolve and PaymentResult.needsManualResolve;
 *   uncertain outcome is status paid + receipt pending + needsManualResolve (never show as PAID).
 * - FailureCode prefix on PaymentResult.error (adapter_error, adapter_timeout, receipt_mismatch,
 *   payment_declined, payment_failed).
 * - invalid_policy via ReasonCode.InvalidPolicy / policyProblem.
 * - Per-currency dailyTotals / dailyTotal (normalizeCurrency upper-case keys).
 *
 * ASSUMED pending API on main:
 * - HTTP 409 race body/code (not_pending | already_paid); normalizeTotals stays tolerant.
 * - GET /ledger today.totals may still be { agentId: number }; we accept per-currency maps too.
 *
 * Legacy fallback only: receipt.meta.needsManualResolve string/boolean (pre-core API responses).
 *
 * All tolerant parsing lives in this module; consumers use the exported helpers only.
 */

import { ReasonCode } from '@agent-pay/core/policy.ts';
import { FailureCode, PaymentError } from '@agent-pay/core/orchestrator.ts';
import { DEFAULT_PAY_TIMEOUT_MS } from '@agent-pay/core/timeout.ts';
import type { LedgerEntry } from '@agent-pay/core';
import type { PaymentResult } from '../types';
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

/** UI label for uncertain rail outcomes (never display as PAID). */
export const NEEDS_CHECK_PENDING_LABEL = 'Needs check (pending)';

export const STUCK_SUBMITTING_MS = DEFAULT_PAY_TIMEOUT_MS;

export const STUCK_LABEL = 'Stuck — needs check';

const RACE_409_SET = new Set<string>(['not_pending', 'already_paid', 'in_progress', 'status_unsupported']);

export const RACE_409_CODES = ['not_pending', 'already_paid', 'in_progress', 'status_unsupported'] as const;

export type Race409Code = (typeof RACE_409_CODES)[number];

export function race409Message(code: Race409Code): { title: string; message: string } {
  switch (code) {
    case 'not_pending':
      return {
        title: 'Already processed',
        message:
          'This intent was already approved or rejected by someone else. Showing the latest state.',
      };
    case 'already_paid':
      return {
        title: 'Already paid',
        message: 'This intent has already been paid. No second payment was made. Showing the latest state.',
      };
    case 'in_progress':
      return {
        title: 'Payment in progress',
        message:
          'A payment for this intent is already being submitted. Wait for it to finish; showing the latest state.',
      };
    case 'status_unsupported':
      return {
        title: 'Status check not supported',
        message:
          'This payment rail cannot report payment status, so it cannot be re-checked automatically. Use Resolve to record the outcome manually.',
      };
  }
}

/** Parsed 409 race code from ApiError or PaymentError, when recognized. */
export function parseRace409(err: unknown): Race409Code | null {
  if (err instanceof PaymentError) {
    if (RACE_409_SET.has(err.code)) return err.code as Race409Code;
    return null;
  }
  if (err instanceof ApiError && err.status === 409) {
    const code = apiErrorCode(err);
    if (code && RACE_409_SET.has(code)) return code as Race409Code;
  }
  return null;
}

export function isStuckSubmitting(
  entry: LedgerEntry,
  now: Date,
  thresholdMs = STUCK_SUBMITTING_MS,
): boolean {
  if (entry.paymentStatus !== 'submitting') return false;
  const anchor = entry.submission?.at ?? entry.updatedAt;
  const started = Date.parse(anchor);
  if (Number.isNaN(started)) return false;
  return now.getTime() - started > thresholdMs;
}

export function needsResolve(entry: LedgerEntry, now: Date): boolean {
  return needsManualResolve(entry) || isStuckSubmitting(entry, now);
}

export type ResolveFormStatus = 'succeeded' | 'failed';

export type ResolveRequest = {
  status: ResolveFormStatus;
  note: string;
  resolvedBy: string;
  externalId?: string;
};

const RESOLVE_FORM_STATUSES = new Set<string>(['succeeded', 'failed']);

export function validateResolveRequest(input: {
  status?: string;
  note?: string;
  resolvedBy?: string;
  externalId?: string;
}):
  | { ok: true; value: ResolveRequest }
  | { ok: false; errors: Partial<Record<'status' | 'note' | 'resolvedBy' | 'externalId', string>> } {
  const errors: Partial<Record<'status' | 'note' | 'resolvedBy' | 'externalId', string>> = {};

  const status = typeof input.status === 'string' ? input.status.trim() : '';
  if (!status) {
    errors.status = 'Status is required';
  } else if (!RESOLVE_FORM_STATUSES.has(status)) {
    errors.status = 'Status must be succeeded or failed';
  }

  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!note) {
    errors.note = 'Note is required for the audit record';
  } else if (note.length > 1000) {
    errors.note = 'Note must be at most 1000 characters';
  }

  const resolvedBy = typeof input.resolvedBy === 'string' ? input.resolvedBy.trim() : '';
  if (!resolvedBy) {
    errors.resolvedBy = 'Resolved by is required';
  } else if (resolvedBy.length > 128) {
    errors.resolvedBy = 'Resolved by must be at most 128 characters';
  }

  let externalId: string | undefined;
  if (input.externalId !== undefined && input.externalId !== '') {
    const ext = typeof input.externalId === 'string' ? input.externalId.trim() : '';
    if (ext.length > 256) {
      errors.externalId = 'External ID must be at most 256 characters';
    } else if (ext.length > 0) {
      externalId = ext;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      status: status as ResolveFormStatus,
      note,
      resolvedBy,
      ...(externalId !== undefined ? { externalId } : {}),
    },
  };
}

const CONFLICT_409_FALLBACK =
  'The server reported a conflict with the current state. Showing the latest ledger.';

/** Human message from a 409 ApiError (detail, legacy after `:`, or fallback). */
export function conflict409ServerMessage(err: ApiError): string {
  const fromDetail =
    err.detail ??
    (err.message.includes(':') ? err.message.slice(err.message.indexOf(':') + 1).trim() : err.message);
  const trimmed = fromDetail.trim();
  // A bare code (e.g. body `{error: "duplicate_intent"}` with no message) is not a human message.
  if (trimmed.length === 0 || trimmed === apiErrorCode(err)) return CONFLICT_409_FALLBACK;
  return trimmed;
}

export function describeResolveError(err: unknown): { title: string; message: string } {
  if (err instanceof PaymentError) {
    switch (err.code) {
      case 'no_receipt':
        return {
          title: 'Nothing to resolve',
          message: 'This intent has no receipt to settle manually.',
        };
      case 'receipt_not_pending':
        return {
          title: 'Already resolved',
          message: 'Someone else resolved this receipt already. Showing the latest state.',
        };
      case 'intent_not_found':
        return {
          title: 'Intent not found',
          message: 'This intent is not in the ledger.',
        };
      default:
        break;
    }
  }

  if (err instanceof ApiError) {
    const code = apiErrorCode(err);
    const detail = err.detail ?? (err.message.includes(':') ? err.message.slice(err.message.indexOf(':') + 1).trim() : err.message);
    if (err.status === 0 || code === 'network_error') {
      return {
        title: 'API unreachable',
        message: detail || 'Cannot reach the API.',
      };
    }
    if (code === 'no_receipt') {
      return { title: 'Nothing to resolve', message: detail || 'No receipt stored for this intent.' };
    }
    if (code === 'receipt_not_pending') {
      return {
        title: 'Already resolved',
        message: detail || 'Someone else resolved this receipt already. Showing the latest state.',
      };
    }
    if (code === 'intent_not_found') {
      return { title: 'Intent not found', message: detail || 'This intent is not in the ledger.' };
    }
    if (code === 'invalid_body') {
      return { title: 'Invalid resolve request', message: detail || err.message };
    }
    if (err.status === 409) {
      const resolvedCode = code ?? 'conflict';
      if (!RACE_409_SET.has(resolvedCode)) {
        return { title: 'Conflict', message: conflict409ServerMessage(err) };
      }
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return { title: 'Resolve failed', message };
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
    if (ps === 'paid' || ps === 'submitting') return true;
    if (obj.status === 'paid' && topLevel) return true;
    return false;
  }

  const status = readStringField(receipt, 'status');
  return status === 'pending' || status === undefined;
}

/** Reads a failure/operator error string from a ledger entry (legacy meta or none). */
export function manualResolveErrorFromEntry(entry: LedgerEntry): string | undefined {
  const meta = (entry.receipt as { meta?: Record<string, string> } | undefined)?.meta;
  if (meta?.error) return meta.error;
  return undefined;
}

const FAILURE_INFO: Record<
  string,
  { label: string; explanation: string }
> = {
  [FailureCode.AdapterError]: {
    label: 'Rail error',
    explanation:
      'The rail call threw; the outcome is unknown, the amount stays held, and the payment must not be retried.',
  },
  [FailureCode.AdapterTimeout]: {
    label: 'Rail timeout',
    explanation:
      'The rail did not answer within the timeout; the outcome is unknown, the amount stays held, and the payment must not be retried.',
  },
  [FailureCode.ReceiptMismatch]: {
    label: 'Receipt mismatch',
    explanation:
      'The rail returned a receipt for a different intent, rail, or status; the outcome is unknown and the amount stays held.',
  },
  [FailureCode.PaymentDeclined]: {
    label: 'Payment declined',
    explanation: 'The rail declined the payment with a failed receipt.',
  },
  [FailureCode.PaymentFailed]: {
    label: 'Payment failed',
    explanation: 'The payment was recorded as failed.',
  },
};

const GENERIC_FAILURE = {
  code: 'unknown',
  label: 'Unknown outcome',
  explanation: 'The payment outcome could not be confirmed automatically.',
};

/** Parses PaymentResult.error or compatible "code: detail" strings for display. */
export function failureInfo(error?: string): { code: string; label: string; explanation: string } {
  if (!error?.trim()) return { ...GENERIC_FAILURE };
  const i = error.indexOf(':');
  const code = (i === -1 ? error : error.slice(0, i)).trim();
  const detail = i === -1 ? '' : error.slice(i + 1).trim();
  const mapped = FAILURE_INFO[code];
  if (mapped) {
    return {
      code,
      label: mapped.label,
      explanation: detail ? `${mapped.explanation} (${detail})` : mapped.explanation,
    };
  }
  return {
    code,
    label: humanizeCode(code),
    explanation: detail || GENERIC_FAILURE.explanation,
  };
}

const MANUAL_RESOLVE_FOOTER =
  'The amount stays reserved and is not marked failed. An operator must check the rail and settle it (POST /intents/:id/resolve). Do not retry the payment.';

/** Banner body for uncertain outcomes (manual-resolve box). */
export function manualResolveBannerText(error?: string): string {
  const info = failureInfo(error);
  return `${info.label}. ${info.explanation} ${MANUAL_RESOLVE_FOOTER}`;
}

/** Result badge / pipeline label: never "paid" for uncertain outcomes. */
export function displayRunStatus(result: PaymentResult | null, entry?: LedgerEntry): string | null {
  if (!result) return null;
  if (needsManualResolve(result) || (entry !== undefined && needsManualResolve(entry))) {
    return NEEDS_CHECK_PENDING_LABEL;
  }
  return result.status.replace('_', ' ');
}

export type AlreadyProcessedOptions = {
  action?: 'approve' | 'reject';
};

const RACE_CODES = new Set<string>(RACE_409_CODES);

/** True when approve/reject lost a race (intent already processed). */
export function isAlreadyProcessed(err: unknown, options: AlreadyProcessedOptions = {}): boolean {
  if (parseRace409(err)) return true;
  if (err instanceof PaymentError) {
    return RACE_CODES.has(err.code);
  }
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const code = apiErrorCode(err);
  if (code && RACE_CODES.has(code)) return true;
  if (options.action === 'approve' || options.action === 'reject') {
    if (!code || code.length === 0) return true;
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

/** Whether the Decision UI should show reason-label (avoid extra lines on happy-path codes). */
export function showReasonLabelForDecision(code: string): boolean {
  return code === 'invalid_policy' || !(code in REASON_LABELS);
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
