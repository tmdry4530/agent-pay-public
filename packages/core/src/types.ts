/** Currency code, e.g. "USD" (ISO-4217) or "NEAR". Compared case-insensitively. */
export type Currency = string;

export type Rail = 'mock' | 'paypal' | 'near';

export interface PaymentIntent {
  id: string;
  agentId: string;
  payee: string;
  /** Amount in major units of `currency` (e.g. 12.5 USD). Must be > 0. */
  amount: number;
  currency: Currency;
  purpose: string;
  /** ISO 8601 timestamp. Its UTC date decides which day the intent counts toward. */
  createdAt: string;
}

export interface Policy {
  agentId: string;
  /** Max amount for a single intent (inclusive). */
  perTxMax: number;
  /** Max approved total per agent per UTC day (inclusive). */
  dailyMax: number;
  /** Exact-match list of allowed payee identifiers. */
  allowedPayees: string[];
  /** Amounts strictly above this need human approval. */
  requireApprovalAbove: number;
  /**
   * Currency all limits are denominated in. Defaults to DEFAULT_CURRENCY ("USD").
   * Intents in any other currency are rejected; no FX conversion is done.
   */
  currency?: Currency;
}

export type DecisionStatus = 'approved' | 'rejected' | 'needs_approval';

export interface Decision {
  status: DecisionStatus;
  /** Starts with a machine-readable code (see ReasonCode) followed by ": " and detail. */
  reason: string;
}

export type ReceiptStatus = 'succeeded' | 'pending' | 'failed' | 'refunded';

export interface Receipt {
  intentId: string;
  rail: Rail;
  /** Rail-side id: PayPal payout_batch_id (or order/capture id for paypal-orders), NEAR tx hash, mock id. */
  externalId: string;
  status: ReceiptStatus;
  /** ISO 8601 timestamp. */
  at: string;
  /** Optional rail-specific string ids/details (e.g. PayPal payout_item_id). Never put secrets here. */
  meta?: Record<string, string>;
}

/** Snapshot of ledger data that `evaluate` needs. */
export interface LedgerState {
  /** Amount already counted for this agent on the intent's UTC day. */
  dailyTotal: number;
}
