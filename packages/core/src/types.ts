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

/**
 * One element of LedgerEntry.decisions: a recorded decision plus when and by whom.
 * Kept in the order the decisions were recorded (oldest first).
 */
export interface DecisionRecord extends Decision {
  /**
   * ISO time from the ledger's injected clock when the decision was recorded.
   * Absent only on records back-filled from a ledger file written before decision history existed.
   */
  at?: string;
  /**
   * Who made the decision, when known: 'policy' for the automatic evaluation (including the
   * re-check that runs on approval), or the approver name passed to approve/reject.
   */
  actor?: string;
}

export type ReceiptStatus = 'succeeded' | 'pending' | 'failed' | 'refunded';

export interface Receipt {
  intentId: string;
  rail: Rail;
  /** Rail-side id: PayPal order/capture id, NEAR tx hash, mock id. */
  externalId: string;
  status: ReceiptStatus;
  /** ISO 8601 timestamp. */
  at: string;
}

/** Snapshot of ledger data that `evaluate` needs. */
export interface LedgerState {
  /**
   * Amount already counted for this agent, in the intent's currency, on the current UTC day
   * of the ledger's server clock (Ledger) or of intent.createdAt (legacy ledgers).
   */
  dailyTotal: number;
}
