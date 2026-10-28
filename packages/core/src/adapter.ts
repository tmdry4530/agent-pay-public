import type { PaymentIntent, Rail, Receipt } from './types.ts';

/**
 * A payment rail. Implementations (mock, PayPal sandbox, NEAR testnet) live in
 * packages/adapters. Core only defines the contract.
 *
 * - `pay` is called only for intents whose decision is 'approved'.
 * - `pay` should resolve with a Receipt (status 'succeeded' | 'pending' | 'failed')
 *   whose `intentId` equals `intent.id` and whose `rail` equals the adapter's `rail`.
 *   Throw only for unexpected errors; a declined payment should resolve with status 'failed'.
 * - `refund` is optional; it resolves with a new Receipt (status 'refunded' on success).
 * - `status` is optional; it re-checks a receipt (typically 'pending') with the rail and resolves with an
 *   updated Receipt with the same intentId and rail. It does not throw for a definite rail answer;
 *   network/unknown outcomes keep status 'pending'.
 */
export interface PaymentAdapter {
  readonly rail: Rail;
  pay(intent: PaymentIntent): Promise<Receipt>;
  refund?(receipt: Receipt): Promise<Receipt>;
  status?(receipt: Receipt): Promise<Receipt>;
}
