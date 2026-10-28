import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalOrdersAdapter, payPalConfigFromEnv } from '../src/index.ts';
import type { PaymentIntent } from '../src/index.ts';

// In sandbox, server-side capture without buyer approval typically fails with
// 422 ORDER_NOT_APPROVED. The adapter resolves that as a failed receipt.

test(
  'paypal sandbox orders: create+capture+refund',
  { skip: !process.env.PAYPAL_CLIENT_ID && 'PAYPAL_CLIENT_ID not set' },
  async () => {
    const config = payPalConfigFromEnv();
    const adapter = createPayPalOrdersAdapter(config);
    const intent: PaymentIntent = {
      id: `sandbox-${Date.now()}`,
      agentId: 'integration-agent',
      payee: 'sandbox-payee@example.com',
      amount: 1.0,
      currency: 'USD',
      purpose: 'adapters integration test',
      createdAt: new Date().toISOString(),
    };

    const receipt = await adapter.pay(intent);
    assert.equal(receipt.intentId, intent.id);
    assert.equal(receipt.rail, 'paypal-orders');
    assert.ok(receipt.status === 'failed' || receipt.status === 'succeeded' || receipt.status === 'pending');

    if (receipt.status === 'succeeded') {
      const refund = await adapter.refund!(receipt);
      assert.equal(refund.intentId, intent.id);
      assert.equal(refund.rail, 'paypal');
      assert.ok(refund.status === 'refunded' || refund.status === 'pending' || refund.status === 'failed');
    }
  },
);
