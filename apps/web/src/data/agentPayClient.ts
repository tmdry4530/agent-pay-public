import type {
  LedgerEntry,
  PaymentIntent,
  PaymentResult,
  Policy,
  Rail,
  ReceiptResolution,
} from '@agent-pay/core';
import type { ResolveRequest } from './compat';

export type { Rail };

/** Intent fields sent to POST /intents (id and createdAt optional). */
export type IntentDraft = Omit<PaymentIntent, 'id' | 'createdAt'> &
  Partial<Pick<PaymentIntent, 'id' | 'createdAt'>>;

export type LedgerTodayTotals =
  | Record<string, number>
  | Record<string, Record<string, number>>
  | Record<string, number | Record<string, number>>;

export type LedgerSnapshot = {
  entries: LedgerEntry[];
  today: {
    day: string;
    totals: LedgerTodayTotals;
    totalsByCurrency?: Record<string, Record<string, number>>;
  };
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
  resolve(
    intentId: string,
    req: ResolveRequest,
  ): Promise<PaymentResult & { changed: true; resolution: ReceiptResolution }>;
  getLedger(): Promise<LedgerSnapshot>;
  getHealth?(): Promise<{ ok: boolean; rail: string }>;
  /** HTTP client: ms to add to local time so it matches server `Date` (0 when unknown). */
  serverClockOffsetMs?(): number;
  reset?(): Promise<void>;
}
