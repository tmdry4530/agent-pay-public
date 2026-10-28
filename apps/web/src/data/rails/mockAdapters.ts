import type { PaymentAdapter, PaymentIntent, Rail, Receipt } from '@agent-pay/core';

export type PendingSettlementConfig = {
  afterChecks: number;
  outcome?: 'succeeded' | 'failed';
};

export type MockAdapterDeps = {
  now?: () => Date;
  newId?: () => string;
  pendingSettlement?: PendingSettlementConfig;
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
  const pending = deps.pendingSettlement;
  const statusCallCounts = new Map<string, number>();

  const adapter: PaymentAdapter = {
    rail,
    async pay(intent: PaymentIntent): Promise<Receipt> {
      return {
        intentId: intent.id,
        rail,
        externalId: `${externalIdPrefix}${suffix(deps)}`,
        status: pending ? 'pending' : 'succeeded',
        at: now().toISOString(),
      };
    },
  };

  if (pending) {
    adapter.status = async (receipt: Receipt): Promise<Receipt> => {
      const key = receipt.externalId;
      const n = (statusCallCounts.get(key) ?? 0) + 1;
      statusCallCounts.set(key, n);
      if (n < pending.afterChecks) {
        return { ...receipt, status: 'pending' };
      }
      const outcome = pending.outcome ?? 'succeeded';
      return { ...receipt, status: outcome };
    };
  }

  return adapter;
}

/** Clearly mock PaymentAdapter implementations for demo rails. */
export function createMockAdapters(deps: MockAdapterDeps = {}): Record<Rail, PaymentAdapter> {
  return {
    mock: createAdapter('mock', 'mock_', deps),
    paypal: createAdapter('paypal', 'MOCK-PAYPAL-ORDER-', deps),
    near: createAdapter('near', 'mock-near-tx-', deps),
  };
}
