import type {
  LedgerEntry,
  PaymentIntent,
  PaymentResult,
  Policy,
  Rail,
} from '@agent-pay/core';

/** Intent fields sent to POST /intents (id and createdAt optional). */
export type IntentDraft = Omit<PaymentIntent, 'id' | 'createdAt'> &
  Partial<Pick<PaymentIntent, 'id' | 'createdAt'>>;

export type LedgerSnapshot = {
  entries: LedgerEntry[];
  today: { day: string; totals: Record<string, number> };
};

export interface AgentPayClient {
  readonly kind: 'mock' | 'http';
  getPolicy(): Promise<Policy>;
  /**
   * Submits an intent for policy evaluation and payment when approved.
   * `rail` selects the adapter in the mock client; the HTTP client ignores it (server-chosen rail).
   */
  submitIntent(
    draft: IntentDraft,
    rail: Rail,
  ): Promise<PaymentResult & { intent: PaymentIntent }>;
  approve(intentId: string, approver?: string): Promise<PaymentResult>;
  reject(
    intentId: string,
    opts?: { approver?: string; note?: string },
  ): Promise<PaymentResult>;
  refresh(intentId: string): Promise<PaymentResult & { changed: boolean }>;
  getLedger(): Promise<LedgerSnapshot>;
  getHealth?(): Promise<{ ok: boolean; rail: string }>;
  reset?(): Promise<void>;
}
