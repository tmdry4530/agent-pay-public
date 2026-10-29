import { type Ledger, LedgerError, type ReceiptResolution } from './ledger.ts';
import { FailureCode, PaymentError, type PaymentResult } from './orchestrator.ts';
import type { Receipt } from './types.ts';

export type ResolveStatus = 'succeeded' | 'failed' | 'refunded';

export const RESOLVE_STATUSES: readonly ResolveStatus[] = ['succeeded', 'failed', 'refunded'];

export interface ResolveInput {
  status: ResolveStatus;
  note: string;
  externalId?: string;
  /** Operator who resolved the receipt (required, non-empty, max 128 chars; self-reported, no auth). */
  resolvedBy: string;
}

export type ResolveResult = PaymentResult & { changed: true; resolution: ReceiptResolution };

const RESOLVE_STATUS_SET: ReadonlySet<string> = new Set(RESOLVE_STATUSES);

function assertValidResolveInput(input: ResolveInput): void {
  if (!RESOLVE_STATUS_SET.has(input.status)) {
    throw new TypeError(`invalid_resolve: status must be one of ${RESOLVE_STATUSES.join(', ')}`);
  }
  if (typeof input.note !== 'string' || input.note.trim() === '') {
    throw new TypeError('invalid_resolve: note must be a non-empty string');
  }
  if (typeof input.resolvedBy !== 'string' || input.resolvedBy.trim() === '') {
    throw new TypeError('invalid_resolve: resolvedBy must be a non-empty string');
  }
  if (input.resolvedBy.length > 128) {
    throw new TypeError('invalid_resolve: resolvedBy must be at most 128 characters');
  }
}

/**
 * Manually settles a stuck `pending` receipt (operator endpoint POST /intents/:id/resolve).
 * Never calls `adapter.pay()` or `adapter.status()`; use when status polling cannot settle
 * (e.g. PayPal `meta.needsManualResolve`, duplicate `sender_batch_id` guesses).
 *
 * Daily totals follow existing ledger rules via `settleReceipt`: `failed` sets
 * `paymentStatus` to `failed` and drops the amount from the daily total; `succeeded` and
 * `refunded` keep counting (`countsTowardDailyTotal`: refunds do not free budget).
 */
export async function resolveIntent(
  intentId: string,
  ledger: Ledger,
  input: ResolveInput,
  now: () => Date = () => new Date(),
): Promise<ResolveResult> {
  assertValidResolveInput(input);

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

  const decision = entry.decision!;
  const base = { intentId, decision };
  const stored = entry.receipt;
  const at = now().toISOString();
  const resolvedBy = input.resolvedBy;
  const status = input.status;

  const newReceipt: Receipt = {
    ...stored,
    status,
    externalId: input.externalId ?? stored.externalId,
    at,
  };

  const resolution: ReceiptResolution = {
    status,
    resolvedBy,
    note: input.note,
    at,
    previousExternalId: stored.externalId,
  };

  try {
    await ledger.settleReceipt(intentId, newReceipt, resolution);
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
    throw new PaymentError('receipt_not_pending', detail);
  }

  if (status === 'failed') {
    return {
      ...base,
      status: 'failed',
      receipt: newReceipt,
      changed: true,
      resolution,
      error: `${FailureCode.PaymentFailed}: resolved as failed by ${resolvedBy}`,
    };
  }
  return { ...base, status: 'paid', receipt: newReceipt, changed: true, resolution };
}
