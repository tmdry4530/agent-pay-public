import type { PaymentAdapter, PaymentIntent, Receipt } from '@agent-pay/core';

/** Receipt plus optional rail-specific string details (never secrets). Core Receipt has no meta yet; the ledger may drop it. */
export type AdapterReceipt = Receipt & { meta?: Record<string, string> };

/** A PaymentAdapter that also re-checks a receipt's status. Structurally still a PaymentAdapter. */
export interface StatusCapableAdapter extends PaymentAdapter {
  pay(intent: PaymentIntent): Promise<AdapterReceipt>;
  status(receipt: Receipt): Promise<AdapterReceipt>;
}
