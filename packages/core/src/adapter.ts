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
 */
export interface PaymentAdapter {
  readonly rail: Rail;
  pay(intent: PaymentIntent): Promise<Receipt>;
  refund?(receipt: Receipt): Promise<Receipt>;
}
