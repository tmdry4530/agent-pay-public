import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalAdapter, payPalConfigFromEnv } from '../src/index.ts';
import type { PaymentIntent } from '../src/index.ts';

const skipReason =
  !process.env.PAYPAL_CLIENT_ID ||
  !process.env.PAYPAL_CLIENT_SECRET ||
  !process.env.PAYPAL_PAYOUT_RECEIVER
    ? 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_PAYOUT_RECEIVER not set'
    : false;

test(
  'paypal sandbox payouts: pay and status',
  { skip: skipReason },
  async () => {
    const config = payPalConfigFromEnv();
    const adapter = createPayPalAdapter(config);
    const intent: PaymentIntent = {
      id: `payout-${Date.now()}`,
      agentId: 'integration-agent',
      payee: process.env.PAYPAL_PAYOUT_RECEIVER ?? '',
      amount: 0.01,
      currency: 'USD',
      purpose: 'adapters payout integration test',
      createdAt: new Date().toISOString(),
    };

    const receipt = await adapter.pay(intent);
    assert.equal(receipt.intentId, intent.id);
    assert.equal(receipt.rail, 'paypal');
    assert.ok(['succeeded', 'pending', 'failed'].includes(receipt.status));

    if (receipt.externalId !== '') {
      const updated = await adapter.status(receipt);
      assert.equal(updated.intentId, intent.id);
      assert.equal(updated.rail, 'paypal');
      assert.equal(updated.externalId, receipt.externalId);
    }
  },
);
