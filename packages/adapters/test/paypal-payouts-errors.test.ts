import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PaymentIntent, Receipt, ReceiptStatus } from '../src/index.ts';
import type { AdapterReceipt } from '../src/adapter-types.ts';
import { createPayPalAdapter, mapPayoutStatus, PayPalApiError } from '../src/paypal.ts';
import { receiptMeta } from '../src/adapter-types.ts';
import {
  BATCH_STATUS_VALUES,
  CREATE_PAYOUT_201,
  INTERNAL_SERVER_ERROR_500,
  OAUTH_INVALID_CLIENT_401,
  PAYOUTS_ERROR_MESSAGES,
  SENDER_EMAIL_UNCONFIRMED_ERROR,
  SERVICE_UNAVAILABLE_503,
  SHOW_PAYOUT_BATCH_200,
  TRANSACTION_STATUS_VALUES,
} from './fixtures/paypal-payouts-errors.ts';

const TEST_CLIENT = 'test-client-id';
const TEST_SECRET = 'test-client-secret';
const BASE = 'https://api-m.sandbox.paypal.com';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type RouteSpec = {
  method: string;
  path: string | RegExp;
  handler: (call: RecordedCall) => Response | Promise<Response>;
};

function recordCall(input: RequestInfo | URL, init?: RequestInit): RecordedCall {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (init?.headers) {
    const h = new Headers(init.headers);
    h.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
  }
  let body: unknown = undefined;
  if (init?.body && typeof init.body === 'string') {
    const ct = headers['content-type'] ?? '';
    if (ct.includes('application/json')) {
      body = JSON.parse(init.body);
    } else {
      body = init.body;
    }
  }
  return { url, method, headers, body };
}

function createFetchMock(routes: RouteSpec[]) {
  const calls: RecordedCall[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const call = recordCall(input, init);
    calls.push(call);
    for (const route of routes) {
      const pathOk =
        typeof route.path === 'string'
          ? call.url.includes(route.path)
          : route.path.test(call.url);
      if (call.method === route.method && pathOk) {
        return route.handler(call);
      }
    }
    throw new Error(`fetch mock: no route for ${call.method} ${call.url}`);
  };
  return { fetchMock, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenRoute(token = 'tok-abc') {
  return {
    method: 'POST',
    path: '/v1/oauth2/token',
    handler: () => jsonResponse({ access_token: token, token_type: 'Bearer', expires_in: 3600 }),
  } satisfies RouteSpec;
}

function baseIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'intent-abc',
    agentId: 'agent-1',
    payee: 'payee@example.com',
    amount: 12.5,
    currency: 'USD',
    purpose: 'demo payout',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function adapterConfig(fetchMock: typeof fetch, onError?: (e: unknown) => void) {
  return {
    clientId: TEST_CLIENT,
    clientSecret: TEST_SECRET,
    baseUrl: BASE,
    fetch: fetchMock,
    now: () => 1_700_000_000_000,
    onError: onError
      ? (error: unknown, _ctx: { intentId: string; op: string }) => {
          onError(error);
        }
      : undefined,
  };
}

const BATCH_STATUS_EXPECTED: Record<(typeof BATCH_STATUS_VALUES)[number], ReceiptStatus> = {
  SUCCESS: 'succeeded',
  PENDING: 'pending',
  PROCESSING: 'pending',
  DENIED: 'failed',
  CANCELED: 'failed',
};

const ITEM_STATUS_EXPECTED: Record<(typeof TRANSACTION_STATUS_VALUES)[number], ReceiptStatus> = {
  SUCCESS: 'succeeded',
  PENDING: 'pending',
  UNCLAIMED: 'pending',
  ONHOLD: 'pending',
  REFUNDED: 'refunded',
  FAILED: 'failed',
  RETURNED: 'failed',
  BLOCKED: 'failed',
  REVERSED: 'failed',
};

describe('mapPayoutStatus — batch fixtures', () => {
  assert.deepEqual(Object.keys(BATCH_STATUS_EXPECTED).sort(), [...BATCH_STATUS_VALUES].sort());

  for (const batchStatus of BATCH_STATUS_VALUES) {
    it(`batch ${batchStatus} -> ${BATCH_STATUS_EXPECTED[batchStatus]}`, () => {
      assert.equal(mapPayoutStatus(batchStatus), BATCH_STATUS_EXPECTED[batchStatus]);
    });
  }
});

describe('mapPayoutStatus — item fixtures', () => {
  assert.deepEqual(Object.keys(ITEM_STATUS_EXPECTED).sort(), [...TRANSACTION_STATUS_VALUES].sort());

  for (const itemStatus of TRANSACTION_STATUS_VALUES) {
    for (const batchStatus of ['SUCCESS', 'PENDING'] as const) {
      it(`item ${itemStatus} with batch ${batchStatus} -> ${ITEM_STATUS_EXPECTED[itemStatus]}`, () => {
        assert.equal(mapPayoutStatus(batchStatus, itemStatus), ITEM_STATUS_EXPECTED[itemStatus]);
      });
    }
  }
});

describe('pay() — payout error fixtures', () => {
  it('CREATE_PAYOUT_201 at 201 -> pending with batch id and meta.batchStatus PENDING', async () => {
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => jsonResponse(CREATE_PAYOUT_201, 201),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '3TRXJ4Z8XJ8QY');
    assert.equal(receiptMeta(receipt)?.batchStatus, 'PENDING');
  });

  for (const batchStatus of BATCH_STATUS_VALUES) {
    it(`CREATE_PAYOUT_201 clone batch_status ${batchStatus}`, async () => {
      const body = structuredClone(CREATE_PAYOUT_201);
      body.batch_header.batch_status = batchStatus;
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'POST',
          path: '/v1/payments/payouts',
          handler: () => jsonResponse(body, 201),
        },
      ]);
      const adapter = createPayPalAdapter(adapterConfig(fetchMock));
      const receipt = await adapter.pay(baseIntent({ id: `batch-${batchStatus}` }));
      assert.equal(receipt.status, mapPayoutStatus(batchStatus));
      assert.equal(receipt.externalId, '3TRXJ4Z8XJ8QY');
    });
  }

  for (const status of [400, 403] as const) {
    it(`SENDER_EMAIL_UNCONFIRMED_ERROR at ${status} -> failed, PayPalApiError name`, async () => {
      const errors: unknown[] = [];
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'POST',
          path: '/v1/payments/payouts',
          handler: () => jsonResponse(SENDER_EMAIL_UNCONFIRMED_ERROR, status),
        },
      ]);
      const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
      const receipt = await adapter.pay(baseIntent({ id: `sender-${status}` }));
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.externalId, '');
      assert.equal(errors.length, 1);
      const err = errors[0];
      assert.ok(err instanceof PayPalApiError);
      assert.equal(err.name, 'SENDER_EMAIL_UNCONFIRMED');
    });
  }

  for (const { name, body, status } of [
    { name: 'INTERNAL_SERVER_ERROR_500', body: INTERNAL_SERVER_ERROR_500, status: 500 },
    { name: 'SERVICE_UNAVAILABLE_503', body: SERVICE_UNAVAILABLE_503, status: 503 },
  ]) {
    it(`${name} at ${status} -> pending with unknownOutcome`, async () => {
      const errors: unknown[] = [];
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'POST',
          path: '/v1/payments/payouts',
          handler: () => jsonResponse(body, status),
        },
      ]);
      const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
      const receipt = await adapter.pay(baseIntent({ id: name }));
      assert.equal(receipt.status, 'pending');
      assert.equal(receipt.externalId, '');
      assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
      assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
      const expectedErrorName =
        name === 'INTERNAL_SERVER_ERROR_500' ? 'INTERNAL_SERVER_ERROR' : 'SERVICE_UNAVAILABLE';
      assert.equal(receiptMeta(receipt)?.errorName, expectedErrorName);
      assert.ok(errors.length > 0);
    });
  }

  it('OAUTH_INVALID_CLIENT_401 -> failed, no payouts POST, error name invalid_client', async () => {
    const errors: unknown[] = [];
    const { fetchMock, calls } = createFetchMock([
      {
        method: 'POST',
        path: '/v1/oauth2/token',
        handler: () => jsonResponse(OAUTH_INVALID_CLIENT_401, 401),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.externalId, '');
    assert.equal(calls.filter((c) => c.url.includes('/v1/payments/payouts')).length, 0);
    assert.equal(errors.length, 1);
    const err = errors[0];
    assert.ok(err instanceof PayPalApiError);
    assert.equal(err.name, 'invalid_client');
  });

  for (const entry of PAYOUTS_ERROR_MESSAGES) {
    if (entry.name === 'DUPLICATE_ITEM' || entry.name === 'USER_BUSINESS_ERROR') {
      it(`${entry.name} at 400 -> pending duplicate-guess (body undocumented; 400 is test choice)`, async () => {
        const errors: unknown[] = [];
        const { fetchMock } = createFetchMock([
          tokenRoute(),
          {
            method: 'POST',
            path: '/v1/payments/payouts',
            handler: () => jsonResponse({ name: entry.name, message: entry.message }, 400),
          },
        ]);
        const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
        const receipt = await adapter.pay(baseIntent({ id: entry.name }));
        assert.equal(receipt.status, 'pending');
        assert.equal(receipt.externalId, '');
        assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
        assert.equal(receiptMeta(receipt)?.duplicateSenderBatchId, 'true');
        assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
        assert.equal(receiptMeta(receipt)?.errorName, entry.name);
        assert.ok(errors.length > 0);
      });
    } else {
      it(`${entry.name} at 400 -> failed`, async () => {
        const errors: unknown[] = [];
        const { fetchMock } = createFetchMock([
          tokenRoute(),
          {
            method: 'POST',
            path: '/v1/payments/payouts',
            handler: () => jsonResponse({ name: entry.name, message: entry.message }, 400),
          },
        ]);
        const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
        const receipt = await adapter.pay(baseIntent({ id: entry.name }));
        assert.equal(receipt.status, 'failed');
        assert.equal(receipt.externalId, '');
        assert.ok(errors.length > 0);
      });
    }
  }

  it('POST payouts fetch throws -> pending, needsManualResolve, no errorName', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => {
          throw new TypeError('network down');
        },
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent({ id: 'post-throw' }));
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
    assert.equal(receiptMeta(receipt)?.errorName, undefined);
    assert.ok(errors.length > 0);
  });

  it('duplicate error with batch link -> receipt from GET, duplicateSenderBatchId, no needsManualResolve', async () => {
    const { fetchMock, calls } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          jsonResponse(
            {
              name: 'USER_BUSINESS_ERROR',
              message: 'sender_batch_id already used',
              links: [{ href: `${BASE}/v1/payments/payouts/LINKED-BATCH`, rel: 'self' }],
            },
            400,
          ),
      },
      {
        method: 'GET',
        path: '/v1/payments/payouts/LINKED-BATCH',
        handler: () => jsonResponse(SHOW_PAYOUT_BATCH_200),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const receipt = await adapter.pay(baseIntent({ id: 'dup-link' }));
    assert.equal(receipt.externalId, 'MJ77GF8MQ2TF6');
    assert.equal(receiptMeta(receipt)?.duplicateSenderBatchId, 'true');
    assert.equal(receiptMeta(receipt)?.errorName, 'USER_BUSINESS_ERROR');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, undefined);
    const getCalls = calls.filter((c) => c.method === 'GET' && c.url.includes('LINKED-BATCH'));
    assert.equal(getCalls.length, 1);
  });
});

describe('status() — payout batch fixtures', () => {
  const pendingReceipt: Receipt = {
    intentId: 'intent-status-1',
    rail: 'paypal',
    externalId: 'MJ77GF8MQ2TF6',
    status: 'pending',
    at: '2026-01-01T00:00:00.000Z',
  };

  it('SHOW_PAYOUT_BATCH_200 -> pending with meta from first item', async () => {
    const { fetchMock, calls } = createFetchMock([
      tokenRoute(),
      {
        method: 'GET',
        path: '/v1/payments/payouts/MJ77GF8MQ2TF6',
        handler: () => jsonResponse(SHOW_PAYOUT_BATCH_200),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const out = await adapter.status(pendingReceipt);
    assert.equal(out.status, 'pending');
    assert.equal(receiptMeta(out)?.batchStatus, 'SUCCESS');
    assert.equal(receiptMeta(out)?.transactionStatus, 'UNCLAIMED');
    assert.equal(receiptMeta(out)?.payoutItemId, 'CX64X3KPCVYLC');
    const getCall = calls.find((c) => c.method === 'GET' && c.url.includes('/v1/payments/payouts/'));
    assert.ok(getCall);
    assert.ok(getCall.url.endsWith('/v1/payments/payouts/MJ77GF8MQ2TF6'));
  });

  for (const itemStatus of TRANSACTION_STATUS_VALUES) {
    it(`SHOW_PAYOUT_BATCH_200 clone items[0].transaction_status ${itemStatus}`, async () => {
      const body = structuredClone(SHOW_PAYOUT_BATCH_200);
      const first = body.items[0];
      assert.ok(first);
      first.transaction_status = itemStatus;
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'GET',
          path: '/v1/payments/payouts/MJ77GF8MQ2TF6',
          handler: () => jsonResponse(body),
        },
      ]);
      const adapter = createPayPalAdapter(adapterConfig(fetchMock));
      const out = await adapter.status(pendingReceipt);
      assert.equal(out.status, mapPayoutStatus('SUCCESS', itemStatus));
    });
  }

  for (const batchStatus of BATCH_STATUS_VALUES) {
    it(`SHOW_PAYOUT_BATCH_200 clone batch_status ${batchStatus} with empty items`, async () => {
      const body = structuredClone(SHOW_PAYOUT_BATCH_200);
      body.batch_header.batch_status = batchStatus;
      body.items = [];
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'GET',
          path: '/v1/payments/payouts/MJ77GF8MQ2TF6',
          handler: () => jsonResponse(body),
        },
      ]);
      const adapter = createPayPalAdapter(adapterConfig(fetchMock));
      const out = await adapter.status(pendingReceipt);
      assert.equal(out.status, mapPayoutStatus(batchStatus));
    });
  }

  it('empty externalId with needsManualResolve -> unchanged, no GET', async () => {
    const manualReceipt: AdapterReceipt = {
      intentId: 'intent-manual',
      rail: 'paypal',
      externalId: '',
      status: 'pending',
      at: '2026-01-01T00:00:00.000Z',
      meta: {
        unknownOutcome: 'true',
        needsManualResolve: 'true',
        duplicateSenderBatchId: 'true',
        errorName: 'USER_BUSINESS_ERROR',
      },
    };
    const { fetchMock, calls } = createFetchMock([tokenRoute()]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const out = await adapter.status(manualReceipt);
    assert.deepEqual(out, manualReceipt);
    assert.equal(calls.filter((c) => c.method === 'GET').length, 0);
  });

  for (const { name, body, status } of [
    { name: 'INTERNAL_SERVER_ERROR_500', body: INTERNAL_SERVER_ERROR_500, status: 500 },
    { name: 'SERVICE_UNAVAILABLE_503', body: SERVICE_UNAVAILABLE_503, status: 503 },
  ]) {
    it(`status GET ${name} at ${status} -> unchanged receipt, onError`, async () => {
      const errors: unknown[] = [];
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'GET',
          path: '/v1/payments/payouts/MJ77GF8MQ2TF6',
          handler: () => jsonResponse(body, status),
        },
      ]);
      const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
      const out = await adapter.status(pendingReceipt);
      assert.deepEqual(out, pendingReceipt);
      assert.ok(errors.length > 0);
    });
  }
});
