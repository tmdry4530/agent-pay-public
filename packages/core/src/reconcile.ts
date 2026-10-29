import type { PaymentAdapter } from './adapter.ts';
import { LedgerError, type Ledger } from './ledger.ts';
import { FailureCode, PaymentError, type PaymentResult } from './orchestrator.ts';
import type { Rail, Receipt, ReceiptStatus } from './types.ts';

export interface ReconcileSummary {
  rail: Rail;
  supported: boolean;
  checked: number;
  updated: { intentId: string; from: ReceiptStatus; to: ReceiptStatus }[];
  unchanged: number;
  errors: { intentId: string; error: string }[];
}

export type RefreshResult = PaymentResult & { changed: boolean };

const STATUS_VALUES: ReadonlySet<string> = new Set(['succeeded', 'pending', 'failed']);

function validateStatusReceipt(
  receipt: unknown,
  intentId: string,
  rail: Rail,
): string | undefined {
  if (receipt === null || typeof receipt !== 'object') return `adapter returned ${String(receipt)} instead of a receipt`;
  const r = receipt as Receipt;
  if (r.intentId !== intentId) return `receipt intentId "${r.intentId}" does not match intent "${intentId}"`;
  if (r.rail !== rail) return `receipt rail "${r.rail}" does not match adapter rail "${rail}"`;
  if (!STATUS_VALUES.has(r.status)) return `receipt status "${r.status}" is not a valid status() status`;
  return undefined;
}

/**
 * Asks `adapter.status` about every ledger entry that is paid with a `pending`
 * receipt on this adapter's rail (except needsManualResolve entries, which only
 * resolveIntent settles), and settles the ones the rail reports as
 * `succeeded` or `failed` (Ledger.settleReceipt; `failed` also marks the payment
 * failed, so it drops out of the daily total).
 *
 * - No `status` method: returns `supported: false`, checked 0, writes nothing.
 * - Still `pending`: counted in `unchanged`, nothing written.
 * - `status` throws (`adapter_error: …`) or returns a receipt with the wrong
 *   intentId / rail / status (`receipt_mismatch: …`): an `errors` item, nothing
 *   stored; the remaining entries are still processed.
 * - Idempotent: once settled, an entry is no longer pending, so a second run
 *   checks nothing and writes nothing.
 */
export async function reconcile(ledger: Ledger, adapter: PaymentAdapter): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    rail: adapter.rail,
    supported: adapter.status !== undefined,
    checked: 0,
    updated: [],
    unchanged: 0,
    errors: [],
  };
  if (!summary.supported) return summary;

  const entries = await ledger.list();
  for (const entry of entries) {
    if (entry.paymentStatus !== 'paid' || entry.needsManualResolve === true) continue;
    const stored = entry.receipt;
    if (!stored || stored.status !== 'pending' || stored.rail !== adapter.rail) continue;

    const intentId = entry.intent.id;
    summary.checked += 1;
    let fresh: Receipt;
    try {
      fresh = await adapter.status!(structuredClone(stored));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      summary.errors.push({ intentId, error: `${FailureCode.AdapterError}: ${detail}` });
      continue;
    }
    const mismatch = validateStatusReceipt(fresh, intentId, adapter.rail);
    if (mismatch) {
      summary.errors.push({ intentId, error: `${FailureCode.ReceiptMismatch}: ${mismatch}` });
      continue;
    }
    if (fresh.status === 'pending') {
      summary.unchanged += 1;
      continue;
    }
    try {
      await ledger.settleReceipt(intentId, fresh);
    } catch (err) {
      // LedgerError: a concurrent settle won the compare-and-set; nothing was written by this run.
      const detail = err instanceof Error ? err.message : String(err);
      summary.errors.push({ intentId, error: `${err instanceof LedgerError && err.code === 'precondition_failed' ? 'ledger_conflict' : 'ledger_error'}: ${detail}` });
      continue;
    }
    summary.updated.push({ intentId, from: 'pending', to: fresh.status });
  }
  return summary;
}

/**
 * Single-intent variant of reconcile (used by POST /intents/:id/refresh).
 * Returns the PaymentResult shape of runPayment/approve plus `changed`
 * (false = still pending, nothing written). Throws PaymentError:
 * intent_not_found, no_receipt, receipt_not_pending (already settled),
 * status_unsupported (no adapter.status or another rail), status_check_failed
 * (status threw or returned a mismatched receipt; nothing stored).
 */
export async function refreshIntent(
  intentId: string,
  ledger: Ledger,
  adapter: PaymentAdapter,
): Promise<RefreshResult> {
  const entry = await ledger.get(intentId);
  if (!entry) throw new PaymentError('intent_not_found', `intent ${intentId} is not recorded`);
  if (!entry.receipt) {
    throw new PaymentError('no_receipt', `intent ${intentId} has no receipt stored`);
  }
  if (entry.receipt.status !== 'pending') {
    throw new PaymentError(
      'receipt_not_pending',
      `intent ${intentId} receipt status is ${entry.receipt.status}, not pending`,
    );
  }
  if (entry.needsManualResolve === true) {
    throw new PaymentError(
      'status_unsupported',
      `intent ${intentId} needs a manual resolve (the rail outcome of the payment is unknown)`,
    );
  }
  if (adapter.status === undefined || entry.receipt.rail !== adapter.rail) {
    throw new PaymentError(
      'status_unsupported',
      `status check is not supported for intent ${intentId} on rail ${entry.receipt.rail}`,
    );
  }

  const decision = entry.decision!;
  const base = { intentId, decision };
  const stored = entry.receipt;

  let fresh: Receipt;
  try {
    fresh = await adapter.status(structuredClone(stored));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PaymentError('status_check_failed', `${FailureCode.AdapterError}: ${detail}`);
  }
  const mismatch = validateStatusReceipt(fresh, intentId, adapter.rail);
  if (mismatch) {
    throw new PaymentError('status_check_failed', `${FailureCode.ReceiptMismatch}: ${mismatch}`);
  }

  if (fresh.status === 'pending') {
    // Nothing is written; report the stored receipt so the response matches the ledger.
    return { ...base, status: 'paid', receipt: stored, changed: false };
  }

  try {
    await ledger.settleReceipt(intentId, fresh);
  } catch (err) {
    if (err instanceof LedgerError && err.code === 'precondition_failed') {
      const again = await ledger.get(intentId);
      if (again?.receipt && again.receipt.status !== 'pending') {
        throw new PaymentError(
          'receipt_not_pending',
          `intent ${intentId} receipt status is ${again.receipt.status}, not pending`,
        );
      }
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new PaymentError('status_check_failed', detail);
  }

  if (fresh.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      receipt: fresh,
      changed: true,
      error: `${FailureCode.PaymentDeclined}: ${adapter.rail} reported ${fresh.externalId} as failed on status check`,
    };
  }
  return { ...base, status: 'paid', receipt: fresh, changed: true };
}
