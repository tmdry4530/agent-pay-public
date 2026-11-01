import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalAdapter, mapPayoutStatus, payoutReceiptStatus } from '../src/paypal.ts';
import { receiptMeta } from '../src/adapter-types.ts';
import type { PaymentIntent, Receipt } from '../src/index.ts';

const BASE = 'https://api-m.sandbox.paypal.com';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** fetch mock: token route plus a queue of GET batch bodies (one per status() call). */
function mockPayPal(createBody: unknown, batchBodies: unknown[]) {
  const gets: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/v1/oauth2/token')) {
      return jsonResponse({ access_token: 'tok-test', token_type: 'Bearer', expires_in: 3600 });
    }
    if (method === 'POST' && url.endsWith('/v1/payments/payouts')) return jsonResponse(createBody, 201);
    if (method === 'GET' && url.includes('/v1/payments/payouts/')) {
      gets.push(url);
      const next = batchBodies.shift();
      if (next === undefined) throw new Error('no more batch bodies');
      return jsonResponse(next);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetchMock, gets };
}

const intent: PaymentIntent = {
  id: 'intent-batch',
  agentId: 'agent-1',
  payee: 'payee@example.com',
  amount: 10,
  currency: 'USD',
  purpose: 'batch final status',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const batch = (batchStatus: string, itemStatus?: string) => ({
  batch_header: { payout_batch_id: 'BATCH-F', batch_status: batchStatus },
  items: itemStatus ? [{ payout_item_id: 'ITEM-F', transaction_status: itemStatus }] : [],
});

describe('payoutReceiptStatus', () => {
  for (const batchStatus of ['PENDING', 'PROCESSING']) {
    for (const item of ['SUCCESS', 'FAILED', 'RETURNED', 'REFUNDED', 'PENDING', 'UNCLAIMED']) {
      it(`batch ${batchStatus} + item ${item} -> pending (batch not final)`, () => {
        assert.equal(payoutReceiptStatus(batchStatus, item), 'pending');
      });
    }
  }
  for (const [batchStatus, item] of [
    ['SUCCESS', 'SUCCESS'],
    ['SUCCESS', 'UNCLAIMED'],
    ['SUCCESS', 'FAILED'],
    ['DENIED', undefined],
    ['CANCELED', undefined],
    ['SUCCESS', undefined],
  ] as const) {
    it(`batch ${batchStatus} + item ${item ?? '(none)'} matches mapPayoutStatus`, () => {
      assert.equal(payoutReceiptStatus(batchStatus, item), mapPayoutStatus(batchStatus, item));
    });
  }
});

describe('status(): final batchStatus is recorded', () => {
  it('PENDING create -> PROCESSING/item SUCCESS stays pending -> SUCCESS settles with batchStatus SUCCESS', async () => {
    const { fetchMock, gets } = mockPayPal(batch('PENDING'), [batch('PROCESSING', 'SUCCESS'), batch('SUCCESS', 'SUCCESS')]);
    const adapter = createPayPalAdapter({
      clientId: 'id',
      clientSecret: 'secret',
      baseUrl: BASE,
      fetch: fetchMock,
      now: () => 1_700_000_000_000,
    });
    const paid = await adapter.pay(intent);
    assert.equal(paid.status, 'pending');
    assert.equal(receiptMeta(paid)?.batchStatus, 'PENDING');

    const first = await adapter.status(paid as Receipt);
    assert.equal(first.status, 'pending', 'item SUCCESS inside a PROCESSING batch must not settle yet');
    assert.equal(receiptMeta(first)?.batchStatus, 'PROCESSING');
    assert.equal(receiptMeta(first)?.transactionStatus, 'SUCCESS');

    const second = await adapter.status(first as Receipt);
    assert.equal(second.status, 'succeeded');
    assert.equal(receiptMeta(second)?.batchStatus, 'SUCCESS');
    assert.equal(receiptMeta(second)?.transactionStatus, 'SUCCESS');
    assert.equal(receiptMeta(second)?.payoutItemId, 'ITEM-F');
    assert.equal(gets.length, 2);
  });

  it('create response already PROCESSING with item SUCCESS -> pending, not succeeded', async () => {
    const { fetchMock } = mockPayPal(batch('PROCESSING', 'SUCCESS'), []);
    const adapter = createPayPalAdapter({ clientId: 'id', clientSecret: 'secret', baseUrl: BASE, fetch: fetchMock });
    const paid = await adapter.pay(intent);
    assert.equal(paid.status, 'pending');
    assert.equal(receiptMeta(paid)?.batchStatus, 'PROCESSING');
  });

  it('batch DENIED after PROCESSING -> failed with batchStatus DENIED', async () => {
    const { fetchMock } = mockPayPal(batch('PENDING'), [batch('PROCESSING', 'FAILED'), batch('DENIED', 'FAILED')]);
    const adapter = createPayPalAdapter({ clientId: 'id', clientSecret: 'secret', baseUrl: BASE, fetch: fetchMock });
    const paid = await adapter.pay(intent);
    const first = await adapter.status(paid as Receipt);
    assert.equal(first.status, 'pending');
    const second = await adapter.status(first as Receipt);
    assert.equal(second.status, 'failed');
    assert.equal(receiptMeta(second)?.batchStatus, 'DENIED');
  });
});
