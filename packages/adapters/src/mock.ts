import { createHash } from 'node:crypto';
import type { PaymentAdapter, PaymentIntent, Receipt } from '@agent-pay/core';
import { validateIntent } from './validate.ts';

function hashHex(input: string, length = 16): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

function externalIdForIntent(intentId: string): string {
  return `mock_${hashHex(intentId)}`;
}

function refundExternalId(originalExternalId: string): string {
  return `mock_refund_${hashHex(originalExternalId)}`;
}

export interface MockAdapterOptions {
  now?: () => Date;
  shouldDecline?: (intent: PaymentIntent) => boolean;
}

export function createMockAdapter(opts?: MockAdapterOptions): PaymentAdapter {
  const now = opts?.now ?? (() => new Date());
  const shouldDecline = opts?.shouldDecline ?? (() => false);
  const paid = new Map<string, Receipt>();
  const refunded = new Map<string, Receipt>();

  return {
    rail: 'mock',

    async pay(intent: PaymentIntent): Promise<Receipt> {
      validateIntent(intent);
      const existing = paid.get(intent.id);
      if (existing) {
        return existing;
      }
      const externalId = externalIdForIntent(intent.id);
      const declined = shouldDecline(intent);
      const receipt: Receipt = {
        intentId: intent.id,
        rail: 'mock',
        externalId,
        status: declined ? 'failed' : 'succeeded',
        at: now().toISOString(),
      };
      paid.set(intent.id, receipt);
      return receipt;
    },

    async refund(receipt: Receipt): Promise<Receipt> {
      if (receipt.rail !== 'mock') {
        throw new Error('Cannot refund a receipt from another rail');
      }
      const existingRefund = refunded.get(receipt.externalId);
      if (existingRefund) {
        return existingRefund;
      }
      const original = [...paid.values()].find((r) => r.externalId === receipt.externalId);
      if (!original || original.status !== 'succeeded') {
        throw new Error('Unknown or non-refundable receipt');
      }
      const refundReceipt: Receipt = {
        intentId: receipt.intentId,
        rail: 'mock',
        externalId: refundExternalId(receipt.externalId),
        status: 'refunded',
        at: now().toISOString(),
      };
      refunded.set(receipt.externalId, refundReceipt);
      return refundReceipt;
    },
  };
}
