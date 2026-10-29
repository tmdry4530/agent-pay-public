import type { Ledger, Receipt } from '@agent-pay/core';
import type { ReceiptResolution } from '@agent-pay/core';
import { LedgerError } from '@agent-pay/core/errors.ts';
import { FailureCode, PaymentError, type PaymentResult } from '@agent-pay/core/orchestrator.ts';

export type MemoryResolveInput = {
  status: 'succeeded' | 'failed' | 'refunded';
  note: string;
  resolvedBy: string;
  externalId?: string;
};

export type MemoryResolveResult = PaymentResult & { changed: true; resolution: ReceiptResolution };

/**
 * Browser-local mirror of packages/core/src/resolve.ts `resolveIntent`.
 */
export async function resolveIntentMemory(
  intentId: string,
  ledger: Pick<Ledger, 'get' | 'settleReceipt'>,
  input: MemoryResolveInput,
  now: () => Date = () => new Date(),
): Promise<MemoryResolveResult> {
  const entry = await ledger.get(intentId);
  if (!entry) throw new PaymentError('intent_not_found', `intent ${intentId} is not recorded`);

  const interrupted = entry.paymentStatus === 'submitting' && !entry.receipt && entry.submission;
  const stored: Receipt | undefined = interrupted
    ? {
        intentId,
        rail: entry.submission!.rail,
        externalId: '',
        status: 'pending',
        at: entry.submission!.at,
      }
    : entry.receipt;
  if (!stored) {
    throw new PaymentError('no_receipt', `intent ${intentId} has no receipt stored`);
  }
  if (stored.status !== 'pending') {
    throw new PaymentError(
      'receipt_not_pending',
      `intent ${intentId} receipt status is ${stored.status}, not pending`,
    );
  }

  const decision = entry.decision!;
  const base = { intentId, decision };
  const at = now().toISOString();
  const { resolvedBy, status } = input;

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
