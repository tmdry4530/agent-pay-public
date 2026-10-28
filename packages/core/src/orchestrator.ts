import { isDeepStrictEqual } from 'node:util';
import type { PaymentAdapter } from './adapter.ts';
import type { Ledger, LedgerEntry } from './ledger.ts';
import { ReasonCode, evaluate } from './policy.ts';
import type { Decision, PaymentIntent, Policy, Receipt } from './types.ts';

export type RunStatus = 'paid' | 'rejected' | 'needs_approval' | 'failed';

export interface PaymentResult {
  intentId: string;
  /**
   * 'paid': receipt status 'succeeded' or 'pending' (counts toward the daily total).
   * 'failed': decision was approved but the payment did not go through (does not count).
   */
  status: RunStatus;
  /** The decision as recorded in the ledger. */
  decision: Decision;
  /** Present when the adapter returned a valid receipt (including a declined one). */
  receipt?: Receipt;
  /** Only when status is 'failed': "<FailureCode>: <detail>". */
  error?: string;
  /** True when runPayment found the intent already recorded and returned its stored outcome. */
  replayed?: true;
}

/** Codes at the start of PaymentResult.error. */
export const FailureCode = {
  /** The rail resolved with a receipt whose status is 'failed'. */
  PaymentDeclined: 'payment_declined',
  /** adapter.pay threw. */
  AdapterError: 'adapter_error',
  /** The receipt's intentId/rail/status violates the PaymentAdapter contract. */
  ReceiptMismatch: 'receipt_mismatch',
  /** Replay of an entry stored as failed (the original error text is not persisted). */
  PaymentFailed: 'payment_failed',
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export type PaymentErrorCode =
  | 'intent_conflict' // same id already recorded with different content
  | 'in_progress' // recorded but undecided, or approved with no payment recorded yet
  | 'intent_not_found'
  | 'not_pending' // approve/reject on an intent whose decision is not needs_approval
  | 'already_paid'
  | 'no_receipt' // refreshIntent: no receipt stored on the entry
  | 'receipt_not_pending' // refreshIntent: receipt already settled (succeeded/failed/refunded)
  | 'status_unsupported' // refreshIntent: adapter has no status(), or receipt rail ≠ adapter rail
  | 'status_check_failed'; // refreshIntent: status() threw or returned an invalid receipt; nothing stored

/** Thrown for caller errors (bad state transitions). Payment failures are results, not throws. */
export class PaymentError extends Error {
  override name = 'PaymentError';
  readonly code: PaymentErrorCode;
  constructor(code: PaymentErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface ApproveOptions {
  policy: Policy;
  ledger: Ledger;
  adapter: PaymentAdapter;
  /** Who approved; recorded in the decision reason. */
  approver?: string;
}

export interface RejectOptions {
  ledger: Ledger;
  /** Who rejected; recorded in the decision reason. */
  approver?: string;
  /** Free-text note appended to the reason. */
  note?: string;
}

/**
 * Records `intent`, evaluates it against `policy` and the ledger, records the
 * decision, and pays via `adapter` only when the decision is 'approved'.
 *
 * Idempotent per intent id: if the same intent (deep-equal) is already recorded,
 * its stored outcome is returned with `replayed: true` and the adapter is NOT
 * called again. Throws PaymentError 'intent_conflict' if the id is recorded with
 * different content, and 'in_progress' if the stored entry is mid-flight
 * (undecided, or approved with no payment recorded: another run is paying, or a
 * crash interrupted it and the rail must be reconciled by hand).
 *
 * Adapter failures never throw: see payApproved. Ledger I/O errors do throw.
 */
export async function runPayment(
  intent: PaymentIntent,
  policy: Policy,
  ledger: Ledger,
  adapter: PaymentAdapter,
): Promise<PaymentResult> {
  const existing = await ledger.get(intent.id);
  if (existing) return replay(existing, intent);
  try {
    await ledger.recordIntent(intent);
  } catch (err) {
    // Lost a race with a concurrent runPayment for the same id.
    const raced = await ledger.get(intent.id);
    if (raced) return replay(raced, intent);
    throw err;
  }
  const decision = evaluate(policy, intent, await ledger.ledgerStateFor(intent));
  await ledger.recordDecision(intent.id, decision);
  if (decision.status !== 'approved') {
    return { intentId: intent.id, status: decision.status, decision };
  }
  return payApproved(intent, decision, ledger, adapter);
}

/**
 * Resumes a needs_approval intent after a human approves it.
 *
 * Throws PaymentError 'intent_not_found', 'already_paid' (a payment is recorded)
 * or 'not_pending' (decision is not needs_approval). Re-evaluates the policy
 * against the current ledger with the approval threshold disabled, so the
 * agent, currency, amount, payee, per-tx and daily limits still apply. If that
 * re-check fails, the decision is replaced with the rejection and a 'rejected'
 * result is returned (no payment). Otherwise the decision is replaced with
 * `approved_by_human: ...` and the intent is paid as in runPayment.
 */
export async function approve(intentId: string, options: ApproveOptions): Promise<PaymentResult> {
  const { policy, ledger, adapter, approver } = options;
  const entry = await pendingEntry(ledger, intentId);
  const by = approver === undefined ? 'a human' : `"${approver}"`;
  const recheck = evaluate(
    { ...policy, requireApprovalAbove: Number.POSITIVE_INFINITY },
    entry.intent,
    await ledger.ledgerStateFor(entry.intent),
  );
  if (recheck.status !== 'approved') {
    const decision: Decision = { status: 'rejected', reason: `${recheck.reason} (re-checked on approval by ${by})` };
    await ledger.recordDecision(intentId, decision, { ifStatus: 'needs_approval' });
    return { intentId, status: 'rejected', decision };
  }
  const { amount, currency, payee } = entry.intent;
  const decision: Decision = {
    status: 'approved',
    reason: `${ReasonCode.ApprovedByHuman}: approved by ${by}; ${amount} ${currency} to "${payee}" is within hard limits`,
  };
  // ifStatus guards against two concurrent approvals both paying.
  await ledger.recordDecision(intentId, decision, { ifStatus: 'needs_approval' });
  return payApproved(entry.intent, decision, ledger, adapter);
}

/** Rejects a needs_approval intent. Same errors as approve. Never calls an adapter. */
export async function reject(intentId: string, options: RejectOptions): Promise<PaymentResult> {
  const { ledger, approver, note } = options;
  await pendingEntry(ledger, intentId);
  const by = approver === undefined ? 'a human' : `"${approver}"`;
  const decision: Decision = {
    status: 'rejected',
    reason: `${ReasonCode.RejectedByHuman}: rejected by ${by}${note ? `; ${note}` : ''}`,
  };
  await ledger.recordDecision(intentId, decision, { ifStatus: 'needs_approval' });
  return { intentId, status: 'rejected', decision };
}

async function pendingEntry(ledger: Ledger, intentId: string): Promise<LedgerEntry> {
  const entry = await ledger.get(intentId);
  if (!entry) throw new PaymentError('intent_not_found', `intent ${intentId} is not recorded`);
  if (entry.paymentStatus === 'paid') throw new PaymentError('already_paid', `intent ${intentId} is already paid`);
  if (entry.decision?.status !== 'needs_approval' || entry.paymentStatus !== undefined) {
    const state = entry.paymentStatus === 'failed' ? 'payment failed' : `decision is ${entry.decision?.status ?? 'missing'}`;
    throw new PaymentError('not_pending', `intent ${intentId} is not awaiting approval (${state})`);
  }
  return entry;
}

/**
 * Pays an intent whose 'approved' decision is already recorded.
 * - Valid receipt with status 'succeeded'/'pending': payment 'paid' + receipt -> 'paid'.
 * - Valid receipt with status 'failed' (declined): payment 'failed' + receipt -> 'failed'.
 * - adapter.pay throws, or the receipt's intentId/rail/status is wrong: payment
 *   'failed', no receipt stored -> 'failed' with `error`. A failed payment does
 *   not count toward the daily total. On a mismatch the rail may still have
 *   moved money; reconcile it out of band.
 */
async function payApproved(
  intent: PaymentIntent,
  decision: Decision,
  ledger: Ledger,
  adapter: PaymentAdapter,
): Promise<PaymentResult> {
  const base = { intentId: intent.id, decision };
  let receipt: Receipt;
  try {
    receipt = await adapter.pay(structuredClone(intent));
  } catch (err) {
    await ledger.recordPayment(intent.id, 'failed');
    const detail = err instanceof Error ? err.message : String(err);
    return { ...base, status: 'failed', error: `${FailureCode.AdapterError}: ${detail}` };
  }
  const mismatch = receiptMismatch(receipt, intent, adapter);
  if (mismatch) {
    await ledger.recordPayment(intent.id, 'failed');
    return { ...base, status: 'failed', error: `${FailureCode.ReceiptMismatch}: ${mismatch}` };
  }
  const failed = receipt.status === 'failed';
  await ledger.recordPayment(intent.id, failed ? 'failed' : 'paid');
  await ledger.recordReceipt(intent.id, receipt);
  if (failed) {
    return { ...base, status: 'failed', receipt, error: `${FailureCode.PaymentDeclined}: ${adapter.rail} declined ${receipt.externalId}` };
  }
  return { ...base, status: 'paid', receipt };
}

const PAY_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'pending', 'failed']);

function receiptMismatch(receipt: Receipt, intent: PaymentIntent, adapter: PaymentAdapter): string | undefined {
  if (receipt === null || typeof receipt !== 'object') return `adapter returned ${String(receipt)} instead of a receipt`;
  if (receipt.intentId !== intent.id) return `receipt intentId "${receipt.intentId}" does not match intent "${intent.id}"`;
  if (receipt.rail !== adapter.rail) return `receipt rail "${receipt.rail}" does not match adapter rail "${adapter.rail}"`;
  if (!PAY_STATUSES.has(receipt.status)) return `receipt status "${receipt.status}" is not a valid pay() status`;
  return undefined;
}

function replay(entry: LedgerEntry, intent: PaymentIntent): PaymentResult {
  if (!isDeepStrictEqual(entry.intent, intent)) {
    throw new PaymentError('intent_conflict', `intent ${intent.id} is already recorded with different content`);
  }
  const { decision } = entry;
  if (!decision) throw new PaymentError('in_progress', `intent ${intent.id} is recorded but not yet decided`);
  const base = { intentId: intent.id, decision, replayed: true as const };
  if (decision.status !== 'approved') return { ...base, status: decision.status };
  if (entry.paymentStatus === undefined) {
    throw new PaymentError('in_progress', `intent ${intent.id} is approved but no payment is recorded yet`);
  }
  const receipt = entry.receipt ? { receipt: entry.receipt } : {};
  if (entry.paymentStatus === 'failed' || entry.receipt?.status === 'failed') {
    return { ...base, ...receipt, status: 'failed', error: `${FailureCode.PaymentFailed}: recorded as failed` };
  }
  return { ...base, ...receipt, status: 'paid' };
}
