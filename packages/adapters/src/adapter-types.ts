import type { PaymentAdapter, Rail, Receipt } from '@agent-pay/core';

/** Receipt plus optional rail-specific string details (never secrets). Core Receipt has no meta yet; the ledger may drop it. */
export type AdapterReceipt = Receipt & { meta?: Record<string, string> };

/** Adapter-side rail union (core `Rail` plus rails not yet in core). */
export type AdapterRail = Rail | 'paypal-orders';

export type RailReceipt<R extends AdapterRail> = Omit<AdapterReceipt, 'rail'> & { rail: R };

/** A PaymentAdapter that always implements `status` with the same signature as core. */
export type StatusCapableAdapter = PaymentAdapter & {
  status: NonNullable<PaymentAdapter['status']>;
};

export function receiptMeta(r: Receipt): Record<string, string> | undefined {
  return (r as AdapterReceipt).meta;
}
