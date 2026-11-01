import type { PaymentAdapter } from './adapter.ts';
import { LedgerError } from './errors.ts';
import type { Ledger, LedgerEntry, PaymentOutcome } from './ledger.ts';
import { ReasonCode, evaluate, policyProblem } from './policy.ts';
import { AdapterTimeoutError, DEFAULT_PAY_TIMEOUT_MS, checkTimeout, withTimeout } from './timeout.ts';
import type { Decision, DecisionStatus, LedgerState, PaymentIntent, Policy, Receipt } from './types.ts';

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
  /**
   * "<FailureCode>: <detail>". Set when status is 'failed', and when needsManualResolve
   * is true (why the outcome is unknown).
   */
  error?: string;
  /**
   * The rail outcome is unknown (adapter.pay threw, timed out, or returned an invalid
   * receipt). status is 'paid' with a placeholder 'pending' receipt (externalId ''); the
   * amount keeps holding the limit and the payment is never re-sent. Settle it with
   * resolveIntent (POST /intents/:id/resolve) after checking the rail.
   */
  needsManualResolve?: true;
  /** True when runPayment found the intent already recorded and returned its stored outcome. */
  replayed?: true;
}

/** Codes at the start of PaymentResult.error. */
export const FailureCode = {
  /** The rail resolved with a receipt whose status is 'failed'. */
  PaymentDeclined: 'payment_declined',
  /** adapter.pay threw (outcome unknown: needsManualResolve). Also used for adapter.status throwing. */
  AdapterError: 'adapter_error',
  /** adapter.pay / adapter.status did not settle within the timeout (pay: needsManualResolve). */
  AdapterTimeout: 'adapter_timeout',
  /** The receipt's intentId/rail/status violates the PaymentAdapter contract (pay: needsManualResolve). */
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

/** `actor` of history records made by policy evaluation (see DecisionRecord). */
const POLICY_ACTOR = 'policy';

/** Options for runPayment / approve. */
export interface PaymentOptions {
  /** Timeout for adapter.pay in ms (default DEFAULT_PAY_TIMEOUT_MS = 60000; Infinity disables). */
  payTimeoutMs?: number;
}

export interface ApproveOptions extends PaymentOptions {
  policy: Policy;
  ledger: Ledger;
  adapter: PaymentAdapter;
  /** Who approved; recorded in the decision reason and as the history record's `actor`. */
  approver?: string;
}

export interface RejectOptions {
  ledger: Ledger;
  /** Who rejected; recorded in the decision reason and as the history record's `actor`. */
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
  options: PaymentOptions = {},
): Promise<PaymentResult> {
  checkTimeout('payTimeoutMs', options.payTimeoutMs);
  const decide = (state: LedgerState) => ({ decision: evaluate(policy, intent, state), actor: POLICY_ACTOR });
  let decision: Decision;
  if (typeof ledger.recordIntentAndDecide === 'function') {
    // Intent + decision in one write: no undecided orphan if anything fails in between.
    const { entry, created } = await ledger.recordIntentAndDecide(intent, decide);
    if (!created) return replay(entry, intent);
    decision = entry.decision!;
  } else {
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
    decision = await decideAtomically(ledger, intent.id, decide);
  }
  if (decision.status !== 'approved') {
    return { intentId: intent.id, status: decision.status, decision };
  }
  return payApproved(intent, decision, ledger, adapter, options);
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
  checkTimeout('payTimeoutMs', options.payTimeoutMs);
  const entry = await pendingEntry(ledger, intentId);
  const by = approver === undefined ? 'a human' : `"${approver}"`;
  const { amount, currency, payee } = entry.intent;
  const decide = (state: LedgerState): { decision: Decision; actor?: string } => {
    // Validate the policy exactly as given (the same check evaluate() runs for runPayment)
    // before overriding the threshold, so an invalid requireApprovalAbove fails closed too.
    const problem = policyProblem(policy, state);
    const recheck: Decision = problem
      ? { status: 'rejected', reason: `${ReasonCode.InvalidPolicy}: ${problem}` }
      : evaluate({ ...policy, requireApprovalAbove: Number.POSITIVE_INFINITY }, entry.intent, state);
    if (recheck.status !== 'approved') {
      // The policy re-check made this decision; the reason names who triggered it.
      return {
        decision: { status: 'rejected', reason: `${recheck.reason} (re-checked on approval by ${by})` },
        actor: POLICY_ACTOR,
      };
    }
    return {
      decision: {
        status: 'approved',
        reason: `${ReasonCode.ApprovedByHuman}: approved by ${by}; ${amount} ${currency} to "${payee}" is within hard limits`,
      },
      actor: approver,
    };
  };
  // ifStatus guards against two concurrent approvals both paying; the re-check and the
  // decision are one atomic step so concurrent approvals cannot exceed the daily limit.
  const decision = await decideAtomically(ledger, intentId, decide, 'needs_approval').catch((err: unknown) =>
    raceLost(ledger, intentId, err),
  );
  if (decision.status !== 'approved') return { intentId, status: 'rejected', decision };
  return payApproved(entry.intent, decision, ledger, adapter, options);
}

type DecideFn = (state: LedgerState) => { decision: Decision; actor?: string };

/** Per-ledger-object promise chain for ledgers without an atomic `decide` (see decideAtomically). */
const decisionLocks = new WeakMap<object, Promise<unknown>>();

/**
 * Reads the daily total, evaluates and records the decision as one atomic step.
 * Uses Ledger.decide (a single serialized read-modify-write) when the ledger has it.
 * Ledgers that only implement the older duck-typed API (e.g. the web demo's in-memory
 * ledger) get an in-process mutex around ledgerStateFor + recordDecision instead.
 */
async function decideAtomically(
  ledger: Ledger,
  intentId: string,
  decide: DecideFn,
  ifStatus?: DecisionStatus,
): Promise<Decision> {
  if (typeof ledger.decide === 'function') {
    const entry = await ledger.decide(intentId, (state) => decide(state), ifStatus ? { ifStatus } : {});
    return entry.decision!;
  }
  const prev = decisionLocks.get(ledger) ?? Promise.resolve();
  const run = prev.then(async () => {
    const entry = await ledger.get(intentId);
    if (!entry) throw new PaymentError('intent_not_found', `intent ${intentId} is not recorded`);
    const { decision, actor } = decide(await ledger.ledgerStateFor(entry.intent));
    const opts: { ifStatus?: DecisionStatus; actor?: string } = {};
    if (ifStatus !== undefined) opts.ifStatus = ifStatus;
    if (actor !== undefined) opts.actor = actor;
    await ledger.recordDecision(intentId, decision, opts);
    return decision;
  });
  decisionLocks.set(ledger, run.catch(() => undefined));
  return run;
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
  await ledger
    .recordDecision(intentId, decision, { ifStatus: 'needs_approval', actor: approver })
    .catch((err: unknown) => raceLost(ledger, intentId, err));
  return { intentId, status: 'rejected', decision };
}

/**
 * A conditional decision write (ifStatus 'needs_approval') failed. If the entry is no
 * longer awaiting approval, a concurrent approve/reject won the race: throw the same
 * PaymentError pendingEntry would throw now ('already_paid' / 'not_pending', HTTP 409)
 * instead of the ledger's precondition error. Otherwise rethrow the original error.
 * Works for any ledger implementation (it re-reads instead of trusting the error class).
 */
async function raceLost(ledger: Ledger, intentId: string, err: unknown): Promise<never> {
  if (err instanceof PaymentError) throw err;
  if (err instanceof LedgerError && err.code !== 'precondition_failed') throw err;
  await pendingEntry(ledger, intentId); // throws the PaymentError when the state moved on
  throw err;
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
 * - adapter.pay throws, times out (options.payTimeoutMs, F5), or the receipt's
 *   intentId/rail/status is wrong (F3): the
 *   outcome is unknown, so the payment is recorded 'paid' with a placeholder 'pending'
 *   receipt and needsManualResolve -> 'paid' + needsManualResolve + `error`. The amount
 *   keeps holding the limit; nothing is re-sent; an operator settles it via resolveIntent.
 * With a Ledger (markSubmitting/recordPaymentResult) the entry is 'submitting' while
 * adapter.pay runs (F4) and the outcome + receipt are written in one step.
 */
async function payApproved(
  intent: PaymentIntent,
  decision: Decision,
  ledger: Ledger,
  adapter: PaymentAdapter,
  options: PaymentOptions,
): Promise<PaymentResult> {
  const base = { intentId: intent.id, decision };
  const atomic = typeof ledger.markSubmitting === 'function' && typeof ledger.recordPaymentResult === 'function';
  let submittedAt = new Date().toISOString();
  if (atomic) {
    // F4: recorded before the rail sees the payment, so a crash mid-pay leaves a
    // 'submitting' entry (holds the limit, replays as in_progress, settled via resolve).
    const marked = await ledger.markSubmitting(intent.id, adapter.rail).catch((err: unknown) => {
      if (err instanceof LedgerError && err.code === 'precondition_failed') {
        throw new PaymentError('in_progress', `intent ${intent.id} is already being paid`);
      }
      throw err;
    });
    submittedAt = marked.submission?.at ?? submittedAt;
  }
  const settle = async (status: 'paid' | 'failed', receipt?: Receipt, unknown = false): Promise<void> => {
    if (atomic) {
      const outcome: PaymentOutcome = receipt === undefined ? { status } : { status, receipt };
      if (unknown) outcome.needsManualResolve = true;
      await ledger.recordPaymentResult(intent.id, outcome);
      return;
    }
    await ledger.recordPayment(intent.id, status);
    if (receipt !== undefined) await ledger.recordReceipt(intent.id, receipt);
  };
  // F3: the rail may or may not have moved money. Keep the amount held (paid + placeholder
  // pending receipt) and flag it for an operator instead of marking it failed.
  const unknownOutcome = async (error: string): Promise<PaymentResult> => {
    const placeholder: Receipt = { intentId: intent.id, rail: adapter.rail, externalId: '', status: 'pending', at: submittedAt };
    await settle('paid', placeholder, true);
    return { ...base, status: 'paid', receipt: placeholder, needsManualResolve: true, error };
  };
  let receipt: Receipt;
  try {
    receipt = await withTimeout(adapter.pay(structuredClone(intent)), options.payTimeoutMs ?? DEFAULT_PAY_TIMEOUT_MS, 'pay');
  } catch (err) {
    if (err instanceof AdapterTimeoutError) return unknownOutcome(`${FailureCode.AdapterTimeout}: ${err.message}`);
    const detail = err instanceof Error ? err.message : String(err);
    return unknownOutcome(`${FailureCode.AdapterError}: ${detail}`);
  }
  const mismatch = receiptMismatch(receipt, intent, adapter);
  if (mismatch) return unknownOutcome(`${FailureCode.ReceiptMismatch}: ${mismatch}`);
  const failed = receipt.status === 'failed';
  await settle(failed ? 'failed' : 'paid', receipt);
  if (failed) {
    // Adapters may explain the decline in receipt meta (`meta.error`, already redacted by the adapter).
    const detail = (receipt as { meta?: { error?: unknown } }).meta?.error;
    return { ...base, status: 'failed', receipt, error: declinedMessage(adapter.rail, receipt.externalId, detail) };
  }
  return { ...base, status: 'paid', receipt };
}

/**
 * `payment_declined: <rail> declined <externalId> (<detail>)`, leaving out an empty or whitespace-only
 * external id or detail, so the message never has a double space or empty parentheses.
 */
export function declinedMessage(rail: string, externalId: unknown, detail: unknown): string {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const head = [`${text(rail) || 'rail'} declined`, text(externalId)].filter((p) => p !== '').join(' ');
  const why = text(detail);
  return `${FailureCode.PaymentDeclined}: ${head}${why ? ` (${why})` : ''}`;
}

const PAY_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'pending', 'failed']);

function receiptMismatch(receipt: Receipt, intent: PaymentIntent, adapter: PaymentAdapter): string | undefined {
  if (receipt === null || typeof receipt !== 'object') return `adapter returned ${String(receipt)} instead of a receipt`;
  if (receipt.intentId !== intent.id) return `receipt intentId "${receipt.intentId}" does not match intent "${intent.id}"`;
  if (receipt.rail !== adapter.rail) return `receipt rail "${receipt.rail}" does not match adapter rail "${adapter.rail}"`;
  if (!PAY_STATUSES.has(receipt.status)) return `receipt status "${receipt.status}" is not a valid pay() status`;
  return undefined;
}

/**
 * Whether two intents describe the same payment, for idempotent replay (F14). Ignores
 * properties whose value is undefined, compares `createdAt` by instant (so
 * "…T10:00:00Z", "…T10:00:00.000Z" and "…T19:00:00+09:00" are equal) and `currency`
 * case-insensitively; every other property must be strictly equal (JSON-equal for
 * non-primitive extras). Browser-safe.
 */
export function sameIntent(a: PaymentIntent, b: PaymentIntent): boolean {
  const defined = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined).sort();
  const keysA = defined(a);
  const keysB = defined(b);
  if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) return false;
  for (const key of keysA) {
    const x = (a as unknown as Record<string, unknown>)[key];
    const y = (b as unknown as Record<string, unknown>)[key];
    if (key === 'createdAt' && typeof x === 'string' && typeof y === 'string') {
      const tx = Date.parse(x);
      if (Number.isNaN(tx) || tx !== Date.parse(y)) return false;
    } else if (key === 'currency' && typeof x === 'string' && typeof y === 'string') {
      if (x.trim().toUpperCase() !== y.trim().toUpperCase()) return false;
    } else if (x !== null && y !== null && typeof x === 'object' && typeof y === 'object') {
      if (JSON.stringify(x) !== JSON.stringify(y)) return false;
    } else if (!Object.is(x, y)) {
      return false;
    }
  }
  return true;
}

function replay(entry: LedgerEntry, intent: PaymentIntent): PaymentResult {
  if (!sameIntent(entry.intent, intent)) {
    throw new PaymentError('intent_conflict', `intent ${intent.id} is already recorded with different content`);
  }
  const { decision } = entry;
  if (!decision) throw new PaymentError('in_progress', `intent ${intent.id} is recorded but not yet decided`);
  const base = { intentId: intent.id, decision, replayed: true as const };
  if (decision.status !== 'approved') return { ...base, status: decision.status };
  if (entry.paymentStatus === undefined) {
    throw new PaymentError('in_progress', `intent ${intent.id} is approved but no payment is recorded yet`);
  }
  if (entry.paymentStatus === 'submitting') {
    // Handed to the rail but no outcome stored (in flight, or interrupted). Never re-sent;
    // an operator settles an interrupted one via resolveIntent.
    throw new PaymentError('in_progress', `intent ${intent.id} payment is submitting on ${entry.submission?.rail ?? 'its rail'}`);
  }
  const receipt = entry.receipt ? { receipt: entry.receipt } : {};
  if (entry.needsManualResolve === true && entry.paymentStatus === 'paid') {
    return { ...base, ...receipt, status: 'paid', needsManualResolve: true };
  }
  if (entry.paymentStatus === 'failed' || entry.receipt?.status === 'failed') {
    return { ...base, ...receipt, status: 'failed', error: `${FailureCode.PaymentFailed}: recorded as failed` };
  }
  return { ...base, ...receipt, status: 'paid' };
}
