import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPayPalAdapter,
  mapPayoutStatus,
  isValidEmail,
  PayPalApiError,
} from '../src/paypal.ts';
import { receiptMeta } from '../src/adapter-types.ts';
import { AdapterValidationError } from '../src/validate.ts';
import type { PaymentIntent, Receipt, ReceiptStatus } from '../src/index.ts';

const TEST_CLIENT = 'test-client-id';
const TEST_SECRET = 'test-client-secret';
const BASE = 'https://api-m.sandbox.paypal.com';

const ALLOWED: ReadonlySet<ReceiptStatus> = new Set([
  'succeeded',
  'pending',
  'failed',
  'refunded',
]);

function assertAllowedStatus(status: ReceiptStatus): void {
  assert.ok(ALLOWED.has(status), `unexpected status: ${status}`);
}

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

function payoutSuccessBody(batchId = 'BATCH-1', overrides: Record<string, unknown> = {}) {
  return {
    batch_header: {
      payout_batch_id: batchId,
      batch_status: 'PENDING',
      sender_batch_header: { sender_batch_id: 'intent-abc' },
    },
    items: [
      {
        payout_item_id: 'ITEM-1',
        transaction_status: 'PENDING',
      },
    ],
    ...overrides,
  };
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

describe('mapPayoutStatus', () => {
  const itemCases: Array<[string, ReceiptStatus]> = [
    ['SUCCESS', 'succeeded'],
    ['PENDING', 'pending'],
    ['UNCLAIMED', 'pending'],
    ['ONHOLD', 'pending'],
    ['REFUNDED', 'refunded'],
    ['FAILED', 'failed'],
    ['RETURNED', 'failed'],
    ['BLOCKED', 'failed'],
    ['REVERSED', 'failed'],
    ['WEIRD', 'failed'],
  ];

  for (const [item, expected] of itemCases) {
    it(`item ${item} -> ${expected}`, () => {
      assert.equal(mapPayoutStatus('IGNORED', item), expected);
    });
  }

  const batchCases: Array<[string, ReceiptStatus]> = [
    ['SUCCESS', 'succeeded'],
    ['PENDING', 'pending'],
    ['PROCESSING', 'pending'],
    ['DENIED', 'failed'],
    ['CANCELED', 'failed'],
    ['UNKNOWN', 'failed'],
  ];

  for (const [batch, expected] of batchCases) {
    it(`batch ${batch} (no item) -> ${expected}`, () => {
      assert.equal(mapPayoutStatus(batch), expected);
    });
  }
});

describe('isValidEmail', () => {
  it('accepts a normal address', () => {
    assert.equal(isValidEmail('payee@example.com'), true);
  });
});

describe('request shape', () => {
  it('POST payouts with bearer token and batch payload', async () => {
    const { fetchMock, calls } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => jsonResponse(payoutSuccessBody(), 201),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    await adapter.pay(baseIntent());

    const payoutCall = calls.find((c) => c.url.includes('/v1/payments/payouts') && c.method === 'POST');
    assert.ok(payoutCall);
    assert.equal(payoutCall.headers.authorization, 'Bearer tok-abc');
    const body = payoutCall.body as {
      sender_batch_header: { sender_batch_id: string };
      items: Array<{
        recipient_type: string;
        receiver: string;
        amount: { value: string; currency: string };
      }>;
    };
    assert.equal(body.sender_batch_header.sender_batch_id, 'intent-abc');
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]?.recipient_type, 'EMAIL');
    assert.equal(body.items[0]?.receiver, 'payee@example.com');
    assert.equal(body.items[0]?.amount.value, '12.50');
    assert.equal(body.items[0]?.amount.currency, 'USD');
  });
});

describe('contract', () => {
  it('intentId and rail on pay outcomes and status()', async () => {
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          jsonResponse(
            {
              batch_header: {
                payout_batch_id: 'B-OK',
                batch_status: 'SUCCESS',
              },
              items: [{ transaction_status: 'SUCCESS' }],
            },
            201,
          ),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const intent = baseIntent();
    const ok = await adapter.pay(intent);
    assert.equal(ok.intentId, intent.id);
    assert.equal(ok.rail, adapter.rail);
    assertAllowedStatus(ok.status);

    const { fetchMock: pendingFetch } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => jsonResponse({ name: 'INTERNAL' }, 500),
      },
    ]);
    const pendingAdapter = createPayPalAdapter(adapterConfig(pendingFetch));
    const pending = await pendingAdapter.pay(baseIntent({ id: 'p1' }));
    assert.equal(pending.intentId, 'p1');
    assert.equal(pending.rail, 'paypal');
    assert.equal(pending.status, 'pending');
    assertAllowedStatus(pending.status);

    const { fetchMock: failFetch } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => jsonResponse({ name: 'INVALID_REQUEST', message: 'bad' }, 400),
      },
    ]);
    const failAdapter = createPayPalAdapter(adapterConfig(failFetch));
    const failed = await failAdapter.pay(baseIntent({ id: 'f1' }));
    assert.equal(failed.intentId, 'f1');
    assert.equal(failed.rail, 'paypal');
    assert.equal(failed.status, 'failed');
    assertAllowedStatus(failed.status);

    const { fetchMock: statusFetch } = createFetchMock([
      tokenRoute(),
      {
        method: 'GET',
        path: '/v1/payments/payouts/B-REF',
        handler: () =>
          jsonResponse({
            batch_header: { batch_status: 'SUCCESS', payout_batch_id: 'B-REF' },
            items: [{ transaction_status: 'REFUNDED', payout_item_id: 'PI-1' }],
          }),
      },
    ]);
    const statusAdapter = createPayPalAdapter(adapterConfig(statusFetch));
    const updated = await statusAdapter.status({
      intentId: 'r1',
      rail: 'paypal',
      externalId: 'B-REF',
      status: 'pending',
      at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(updated.intentId, 'r1');
    assert.equal(updated.rail, 'paypal');
    assert.equal(updated.status, 'refunded');
    assertAllowedStatus(updated.status);
  });
});

describe('idempotency', () => {
  it('duplicate sender_batch_id with link GETs existing batch', async () => {
    let postAttempts = 0;
    let successfulPosts = 0;
    const { fetchMock, calls } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => {
          postAttempts++;
          if (postAttempts === 1) {
            successfulPosts++;
            return jsonResponse(payoutSuccessBody('BATCH-ORIG'), 201);
          }
          return jsonResponse(
            {
              name: 'USER_BUSINESS_ERROR',
              message: 'sender_batch_id already used',
              links: [
                {
                  href: `${BASE}/v1/payments/payouts/BATCH-ORIG`,
                  rel: 'self',
                },
              ],
            },
            400,
          );
        },
      },
      {
        method: 'GET',
        path: '/v1/payments/payouts/BATCH-ORIG',
        handler: () =>
          jsonResponse({
            batch_header: { payout_batch_id: 'BATCH-ORIG', batch_status: 'SUCCESS' },
            items: [{ transaction_status: 'SUCCESS' }],
          }),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const intent = baseIntent();
    const first = await adapter.pay(intent);
    const second = await adapter.pay(intent);
    assert.equal(first.externalId, 'BATCH-ORIG');
    assert.equal(second.externalId, 'BATCH-ORIG');
    assert.equal(receiptMeta(second)?.duplicateSenderBatchId, 'true');
    assert.equal(receiptMeta(second)?.errorName, 'USER_BUSINESS_ERROR');
    assert.equal(receiptMeta(second)?.needsManualResolve, undefined);
    const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/payouts'));
    assert.equal(posts.length, 2);
    assert.equal(successfulPosts, 1);
    const gets = calls.filter((c) => c.method === 'GET' && c.url.includes('BATCH-ORIG'));
    assert.equal(gets.length, 1);
  });

  it('duplicate error without link -> pending with duplicateSenderBatchId meta', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          jsonResponse(
            {
              name: 'USER_BUSINESS_ERROR',
              message: 'duplicate sender_batch_id',
            },
            400,
          ),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.duplicateSenderBatchId, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
    assert.equal(receiptMeta(receipt)?.errorName, 'USER_BUSINESS_ERROR');
    assert.ok(errors.length > 0);
  });

  it('duplicate with link but GET non-2xx -> pending with batch externalId', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          jsonResponse(
            {
              name: 'USER_BUSINESS_ERROR',
              message: 'sender_batch_id already used',
              links: [{ href: `${BASE}/v1/payments/payouts/BATCH-DUP`, rel: 'self' }],
            },
            400,
          ),
      },
      {
        method: 'GET',
        path: '/v1/payments/payouts/BATCH-DUP',
        handler: () => jsonResponse({ name: 'NOT_FOUND' }, 404),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, 'BATCH-DUP');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, undefined);
    assert.ok(errors.length > 0);
  });

  it('duplicate with link but GET throws -> pending with batch externalId', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          jsonResponse(
            {
              name: 'USER_BUSINESS_ERROR',
              message: 'duplicate sender_batch_id',
              links: [{ href: `${BASE}/v1/payments/payouts/BATCH-NET`, rel: 'self' }],
            },
            400,
          ),
      },
      {
        method: 'GET',
        path: '/v1/payments/payouts/BATCH-NET',
        handler: () => {
          throw new TypeError('network down');
        },
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, 'BATCH-NET');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.duplicateSenderBatchId, 'true');
    assert.equal(receiptMeta(receipt)?.errorName, 'USER_BUSINESS_ERROR');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, undefined);
    assert.ok(errors.length > 0);
  });
});

describe('email validation', () => {
  const invalid = ['', 'bob', 'bob@', '@x.com', 'a b@x.com'];

  for (const payee of invalid) {
    it(`rejects payee ${JSON.stringify(payee)}`, async () => {
      const { fetchMock, calls } = createFetchMock([tokenRoute()]);
      const adapter = createPayPalAdapter(adapterConfig(fetchMock));
      await assert.rejects(
        () => adapter.pay(baseIntent({ payee })),
        (err: unknown) => err instanceof AdapterValidationError,
      );
      assert.equal(calls.length, 0);
    });
  }
});

describe('outcome rules on POST', () => {
  it('5xx -> pending with empty externalId and onError', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => jsonResponse({ name: 'INTERNAL' }, 500),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
    assert.ok(errors.length > 0);
  });

  it('TypeError from fetch -> pending', async () => {
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
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
  });

  it('TimeoutError DOMException -> pending', async () => {
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => {
          throw new DOMException('The operation timed out', 'TimeoutError');
        },
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
  });

  it('4xx validation errors -> failed', async () => {
    for (const status of [400, 422]) {
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'POST',
          path: '/v1/payments/payouts',
          handler: () => jsonResponse({ name: 'INVALID', message: 'nope' }, status),
        },
      ]);
      const adapter = createPayPalAdapter(adapterConfig(fetchMock));
      const receipt = await adapter.pay(baseIntent({ id: `fail-${status}` }));
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.externalId, '');
    }
  });

  it('2xx POST with invalid JSON body -> pending', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          new Response('not-json', {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
    assert.ok(errors.length > 0);
  });

  it('2xx POST missing payout_batch_id -> pending', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          jsonResponse(
            {
              batch_header: { batch_status: 'PENDING' },
              items: [{ transaction_status: 'PENDING' }],
            },
            201,
          ),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
    assert.ok(errors.length > 0);
  });

  it('generic Error thrown on POST fetch -> pending', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => {
          throw new Error('unexpected handler failure');
        },
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
    assert.ok(errors.length > 0);
  });
});

describe('status()', () => {
  it('updates pending receipt to succeeded with meta', async () => {
    const { fetchMock, calls } = createFetchMock([
      tokenRoute(),
      {
        method: 'GET',
        path: '/v1/payments/payouts/BATCH-ST',
        handler: () =>
          jsonResponse({
            batch_header: { payout_batch_id: 'BATCH-ST', batch_status: 'SUCCESS' },
            items: [{ payout_item_id: 'PI-99', transaction_status: 'SUCCESS' }],
          }),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const input: Receipt = {
      intentId: 'intent-abc',
      rail: 'paypal',
      externalId: 'BATCH-ST',
      status: 'pending',
      at: '2026-01-01T00:00:00.000Z',
    };
    const out = await adapter.status(input);
    assert.equal(out.status, 'succeeded');
    assert.equal(receiptMeta(out)?.payoutItemId, 'PI-99');
    assert.match(calls[1]?.url ?? '', /BATCH-ST/);
  });

  it('GET error returns unchanged receipt and onError', async () => {
    const errors: unknown[] = [];
    const input: Receipt = {
      intentId: 'i',
      rail: 'paypal',
      externalId: 'BATCH-ERR',
      status: 'pending',
      at: '2026-01-01T00:00:00.000Z',
    };
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'GET',
        path: '/v1/payments/payouts/BATCH-ERR',
        handler: () => jsonResponse({ name: 'NOT_FOUND' }, 404),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const out = await adapter.status(input);
    assert.deepEqual(out, input);
    assert.ok(errors[0] instanceof PayPalApiError);
  });

  it('empty externalId -> unchanged, no fetch', async () => {
    const { fetchMock, calls } = createFetchMock([tokenRoute()]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const input: Receipt = {
      intentId: 'i',
      rail: 'paypal',
      externalId: '',
      status: 'pending',
      at: '2026-01-01T00:00:00.000Z',
    };
    const out = await adapter.status(input);
    assert.deepEqual(out, input);
    assert.equal(calls.length, 0);
  });

  it('wrong rail throws', async () => {
    const { fetchMock } = createFetchMock([tokenRoute()]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    await assert.rejects(
      () =>
        adapter.status({
          intentId: 'i',
          rail: 'mock',
          externalId: 'x',
          status: 'pending',
          at: '2026-01-01T00:00:00.000Z',
        }),
      /another rail/,
    );
  });

  it('succeeds from a plain core Receipt with no meta property', async () => {
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'GET',
        path: '/v1/payments/payouts/B-NOMETA',
        handler: () =>
          jsonResponse({
            batch_header: { payout_batch_id: 'B-NOMETA', batch_status: 'SUCCESS' },
            items: [{ transaction_status: 'SUCCESS', payout_item_id: 'PI-NM' }],
          }),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const plain: Receipt = {
      intentId: 'intent-plain',
      rail: 'paypal',
      externalId: 'B-NOMETA',
      status: 'pending',
      at: '2026-01-01T00:00:00.000Z',
    };
    assert.equal('meta' in plain, false);
    const out = await adapter.status(plain);
    assert.equal(out.status, 'succeeded');
    assert.equal(out.externalId, 'B-NOMETA');
    assert.equal(receiptMeta(out)?.payoutItemId, 'PI-NM');
  });

  it('failed item status from plain Receipt with no meta', async () => {
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'GET',
        path: '/v1/payments/payouts/B-FAIL',
        handler: () =>
          jsonResponse({
            batch_header: { payout_batch_id: 'B-FAIL', batch_status: 'SUCCESS' },
            items: [{ transaction_status: 'FAILED' }],
          }),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const out = await adapter.status({
      intentId: 'i-fail',
      rail: 'paypal',
      externalId: 'B-FAIL',
      status: 'pending',
      at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(out.status, 'failed');
  });
});

describe('meta', () => {
  it('includes payoutItemId from POST items and all meta values are strings', async () => {
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          jsonResponse(
            {
              batch_header: {
                payout_batch_id: 'B-M',
                batch_status: 'PENDING',
              },
              items: [
                {
                  payout_item_id: 'ITEM-XYZ',
                  transaction_status: 'PENDING',
                },
              ],
            },
            201,
          ),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receiptMeta(receipt)?.payoutItemId, 'ITEM-XYZ');
    assert.equal(receiptMeta(receipt)?.batchStatus, 'PENDING');
    assert.equal(receiptMeta(receipt)?.transactionStatus, 'PENDING');
    for (const v of Object.values(receiptMeta(receipt) ?? {})) {
      assert.equal(typeof v, 'string');
    }
  });
});

describe('token', () => {
  it('reuses token across two pays', async () => {
    const { fetchMock, calls } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () => jsonResponse(payoutSuccessBody('B1'), 201),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock));
    await adapter.pay(baseIntent({ id: 'a' }));
    await adapter.pay(baseIntent({ id: 'b' }));
    const tokenCalls = calls.filter((c) => c.url.endsWith('/oauth2/token'));
    assert.equal(tokenCalls.length, 1);
  });

  it('token failure -> failed pay', async () => {
    const errors: unknown[] = [];
    const { fetchMock, calls } = createFetchMock([
      {
        method: 'POST',
        path: '/v1/oauth2/token',
        handler: () => jsonResponse({ error: 'invalid_client' }, 401),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.externalId, '');
    assert.equal(calls.filter((c) => c.url.includes('/payouts')).length, 0);
    assert.ok(errors.length > 0);
  });
});
