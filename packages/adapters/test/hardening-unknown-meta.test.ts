/**
 * A1 — meta.needsManualResolve === 'true' when uncertain outcome cannot be settled by status polling
 * (empty externalId), or multi-item batch mismatch (covered elsewhere). With a pollable externalId,
 * only unknownOutcome is set. Fake clients only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createNearAdapter,
  createPayPalAdapter,
  type NearClient,
  type NearSendResult,
  type NearTransferRequest,
  type PaymentIntent,
  receiptMeta,
} from '../src/index.ts';

const AT = new Date('2026-04-01T00:00:00.000Z');
const BASE = 'https://api-m.sandbox.paypal.com';

function nearIntent(): PaymentIntent {
  return {
    id: 'intent-a1-near',
    agentId: 'agent-1',
    payee: 'bob.testnet',
    amount: 1,
    currency: 'NEAR',
    purpose: 'a1 meta',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function nearClient(send: () => NearSendResult | Promise<NearSendResult>): NearClient {
  return {
    accountId: 'alice.testnet',
    async sendTransfer(_req: NearTransferRequest) {
      return send();
    },
    async txStatus() {
      return { kind: 'unknown', error: new Error('unused') };
    },
  };
}

type RouteSpec = {
  method: string;
  path: string;
  handler: () => Response | Promise<Response>;
};

function createFetchMock(routes: RouteSpec[]) {
  const fetchMock: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const route of routes) {
      if (method === route.method && url.includes(route.path)) {
        return route.handler();
      }
    }
    throw new Error(`fetch mock: no route for ${method} ${url}`);
  };
  return { fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('A1 — NEAR pay() unknownOutcome receipts', () => {
  it('unknown send result with txHash -> unknownOutcome only, no needsManualResolve', async () => {
    const adapter = createNearAdapter({
      client: nearClient(() => ({ kind: 'unknown', txHash: 'tx-unk', error: 'timeout' })),
      now: () => AT,
    });
    const receipt = await adapter.pay(nearIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, 'tx-unk');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, undefined);
  });

  it('unknown send result without txHash -> needsManualResolve', async () => {
    const adapter = createNearAdapter({
      client: nearClient(() => ({ kind: 'unknown', txHash: '', error: 'timeout' })),
      now: () => AT,
    });
    const receipt = await adapter.pay(nearIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
  });

  it('send throw (empty externalId) -> needsManualResolve', async () => {
    const adapter = createNearAdapter({
      client: nearClient(() => {
        throw new Error('rpc down');
      }),
      now: () => AT,
    });
    const receipt = await adapter.pay(nearIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
  });
});

describe('A1 — PayPal getPayoutBatch unknownOutcome with batch id', () => {
  it('duplicate lookup GET non-2xx -> unknownOutcome only, no needsManualResolve', async () => {
    const batchId = 'BATCH-A1-404';
    const { fetchMock } = createFetchMock([
      {
        method: 'POST',
        path: '/v1/oauth2/token',
        handler: () => jsonResponse({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
      },
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          jsonResponse(
            {
              name: 'USER_BUSINESS_ERROR',
              message: 'sender_batch_id already used',
              links: [{ href: `${BASE}/v1/payments/payouts/${batchId}`, rel: 'self' }],
            },
            400,
          ),
      },
      {
        method: 'GET',
        path: `/v1/payments/payouts/${batchId}`,
        handler: () => jsonResponse({ name: 'NOT_FOUND' }, 404),
      },
    ]);
    const adapter = createPayPalAdapter({
      clientId: 'id',
      clientSecret: 'secret',
      baseUrl: BASE,
      fetch: fetchMock,
      now: () => 1_700_000_000_000,
    });
    const receipt = await adapter.pay({
      id: 'intent-a1-paypal',
      agentId: 'agent-1',
      payee: 'payee@example.com',
      amount: 2,
      currency: 'USD',
      purpose: 'dup',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, batchId);
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, undefined);
  });

  it('duplicate lookup GET network error -> unknownOutcome only, no needsManualResolve', async () => {
    const batchId = 'BATCH-A1-NET';
    const { fetchMock } = createFetchMock([
      {
        method: 'POST',
        path: '/v1/oauth2/token',
        handler: () => jsonResponse({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
      },
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          jsonResponse(
            {
              name: 'USER_BUSINESS_ERROR',
              message: 'duplicate sender_batch_id',
              links: [{ href: `${BASE}/v1/payments/payouts/${batchId}`, rel: 'self' }],
            },
            400,
          ),
      },
      {
        method: 'GET',
        path: `/v1/payments/payouts/${batchId}`,
        handler: () => {
          throw new TypeError('network down');
        },
      },
    ]);
    const adapter = createPayPalAdapter({
      clientId: 'id',
      clientSecret: 'secret',
      baseUrl: BASE,
      fetch: fetchMock,
      now: () => 1_700_000_000_000,
    });
    const receipt = await adapter.pay({
      id: 'intent-a1-paypal-net',
      agentId: 'agent-1',
      payee: 'payee@example.com',
      amount: 2,
      currency: 'USD',
      purpose: 'dup',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, batchId);
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, undefined);
  });
});
