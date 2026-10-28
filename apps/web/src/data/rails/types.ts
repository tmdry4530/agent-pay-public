import type { PaymentIntent, Rail, Receipt } from '../../types';

export interface PaymentRail {
  id: Rail;
  label: string;
  pay(intent: PaymentIntent): Promise<Receipt>;
}
