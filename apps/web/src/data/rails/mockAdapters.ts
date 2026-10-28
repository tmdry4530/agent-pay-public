import type { PaymentAdapter, PaymentIntent, Rail, Receipt } from '@agent-pay/core';

export type MockAdapterDeps = {
  now?: () => Date;
  newId?: () => string;
};

function suffix(deps: MockAdapterDeps): string {
  return (deps.newId ?? (() => crypto.randomUUID().slice(0, 8)))();
}

function createAdapter(
  rail: Rail,
  externalIdPrefix: string,
  deps: MockAdapterDeps,
): PaymentAdapter {
  const now = deps.now ?? (() => new Date());
  return {
    rail,
    async pay(intent: PaymentIntent): Promise<Receipt> {
      return {
        intentId: intent.id,
        rail,
        externalId: `${externalIdPrefix}${suffix(deps)}`,
        status: 'succeeded',
        at: now().toISOString(),
      };
    },
  };
}

/** Clearly mock PaymentAdapter implementations for demo rails. */
export function createMockAdapters(deps: MockAdapterDeps = {}): Record<Rail, PaymentAdapter> {
  return {
    mock: createAdapter('mock', 'mock_', deps),
    paypal: createAdapter('paypal', 'MOCK-PAYPAL-ORDER-', deps),
    near: createAdapter('near', 'mock-near-tx-', deps),
  };
}
