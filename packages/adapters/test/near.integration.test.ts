import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createNearAdapter,
  createNearRpcClient,
  nearConfigFromEnv,
  type ReceiptStatus,
  receiptMeta,
} from '../src/index.ts';

const missingEnv =
  !process.env.NEAR_ACCOUNT_ID || !process.env.NEAR_PRIVATE_KEY || !process.env.NEAR_RECEIVER_ID;

const ALLOWED: ReadonlySet<ReceiptStatus> = new Set(['succeeded', 'pending', 'failed', 'refunded']);

describe(
  'NEAR testnet transfer',
  { skip: missingEnv && 'NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY / NEAR_RECEIVER_ID not set' },
  () => {
    it('sends 0.001 NEAR and rechecks status', async () => {
      const receiverId = process.env.NEAR_RECEIVER_ID;
      if (!receiverId) {
        throw new Error('NEAR_RECEIVER_ID is required');
      }
      const config = nearConfigFromEnv();
      const client = createNearRpcClient(config);
      const adapter = createNearAdapter({ client, networkId: config.networkId });
      const intent = {
        id: `near-it-${Date.now()}`,
        agentId: 'integration',
        payee: receiverId,
        amount: 0.001,
        currency: 'NEAR',
        purpose: 'near integration',
        createdAt: new Date().toISOString(),
      };
      const receipt = await adapter.pay(intent);
      assert.equal(receipt.intentId, intent.id);
      assert.equal(receipt.rail, 'near');
      assert.ok(ALLOWED.has(receipt.status));
      assert.equal(adapter.refund, undefined);
      assert.equal(receiptMeta(receipt)?.receiverId, receiverId);
      assert.equal(receiptMeta(receipt)?.network, config.networkId);
      assert.equal(typeof adapter.status, 'function');
      if (!adapter.status) {
        throw new Error('expected status()');
      }
      const checked = await adapter.status(receipt);
      assert.equal(checked.intentId, intent.id);
      assert.equal(checked.rail, 'near');
      assert.equal(checked.externalId, receipt.externalId);
      assert.ok(ALLOWED.has(checked.status));
    });
  },
);
