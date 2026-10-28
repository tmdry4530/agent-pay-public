import type { LedgerEntry, Rail, Receipt } from '@agent-pay/core';
import type { PaymentAdapter } from '@agent-pay/core';
import { FailureCode, PaymentError, type PaymentResult } from '@agent-pay/core/orchestrator.ts';
import { MemoryLedgerError } from './memoryLedger';

export type RefreshResult = PaymentResult & { changed: boolean };

const STATUS_VALUES: ReadonlySet<string> = new Set(['succeeded', 'pending', 'failed']);

export type RefreshLedger = {
  get(intentId: string): Promise<LedgerEntry | undefined>;
  settleReceipt(intentId: string, receipt: Receipt): Promise<LedgerEntry>;
};

function validateStatusReceipt(
  receipt: unknown,
  intentId: string,
  rail: Rail,
): string | undefined {
  if (receipt === null || typeof receipt !== 'object') {
    return `adapter returned ${String(receipt)} instead of a receipt`;
  }
  const r = receipt as Receipt;
  if (r.intentId !== intentId) {
    return `receipt intentId "${r.intentId}" does not match intent "${intentId}"`;
  }
  if (r.rail !== rail) return `receipt rail "${r.rail}" does not match adapter rail "${rail}"`;
  if (!STATUS_VALUES.has(r.status)) {
    return `receipt status "${r.status}" is not a valid status() status`;
  }
  return undefined;
}

/** Browser-safe mirror of packages/core/src/reconcile.ts `refreshIntent`. */
export async function refreshIntent(
  intentId: string,
  ledger: RefreshLedger,
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
    return { ...base, status: 'paid', receipt: stored, changed: false };
  }

  try {
    await ledger.settleReceipt(intentId, fresh);
  } catch (err) {
    if (err instanceof MemoryLedgerError) {
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
