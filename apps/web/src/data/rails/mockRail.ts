import type { PaymentIntent, Receipt } from '../../types';
import type { PaymentRail } from './types';

function suffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function createMockRail(
  id: 'mock' | 'paypal' | 'near',
  label: string,
  externalIdPrefix: string,
  clock: () => string,
): PaymentRail {
  return {
    id,
    label,
    async pay(intent: PaymentIntent): Promise<Receipt> {
      const externalId = `${externalIdPrefix}${suffix()}`;
      return {
        intentId: intent.id,
        rail: id,
        externalId,
        status: 'settled',
        at: clock(),
      };
    },
  };
}

export function createMockRails(deps: {
  clock: () => string;
  idGen: () => string;
}): PaymentRail[] {
  return [
    createMockRail('mock', 'Mock', 'MOCK-TX-', deps.clock),
    createMockRail('paypal', 'PayPal', 'MOCK-PAYPAL-ORDER-', deps.clock),
    createMockRail('near', 'NEAR', 'mock-near-tx-', deps.clock),
  ];
}
