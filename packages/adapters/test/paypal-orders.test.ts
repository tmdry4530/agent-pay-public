import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalOrdersAdapter } from '../src/paypal-orders.ts';
import {
  payPalConfigFromEnv,
  formatAmount,
  requestId,
  PayPalApiError,
} from '../src/paypal-client.ts';
import type { PaymentIntent, ReceiptStatus } from '../src/index.ts';

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

export interface RecordedCall {
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

function baseIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'intent-abc',
    agentId: 'agent-1',
    payee: 'seller@example.com',
    amount: 12.5,
    currency: 'USD',
    purpose: 'demo',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function tokenRoute() {
  return {
    method: 'POST',
    path: '/v1/oauth2/token',
    handler: () => jsonResponse({ access_token: 'tok-abc', token_type: 'Bearer', expires_in: 3600 }),
  } satisfies RouteSpec;
}

function ordersHappyRoutes(captureId = 'CAPTURE-123'): RouteSpec[] {
  return [
    tokenRoute(),
    {
      method: 'POST',
      path: /\/v2\/checkout\/orders$/,
      handler: () => jsonResponse({ id: 'ORDER-1', status: 'CREATED' }),
    },
    {
      method: 'POST',
      path: /\/v2\/checkout\/orders\/ORDER-1\/capture$/,
      handler: () =>
        jsonResponse({
          id: 'ORDER-1',
          status: 'COMPLETED',
          purchase_units: [
            {
              payments: {
                captures: [{ id: captureId, status: 'COMPLETED' }],
              },
            },
          ],
        }),
    },
  ];
}

describe('formatAmount', () => {
  it('formats amounts with two decimals', () => {
    assert.equal(formatAmount(10), '10.00');
    assert.equal(formatAmount(12.5), '12.50');
    assert.equal(formatAmount(0.1 + 0.2), '0.30');
    assert.equal(formatAmount(1.005), '1.01');
    assert.equal(formatAmount(1234.5), '1234.50');
  });
});

describe('requestId', () => {
  it('stays within 38 characters for long intent ids', () => {
    const longId = 'x'.repeat(100);
    const id = requestId(longId, 'capture');
    assert.ok(id.length <= 38);
    assert.equal(id, requestId(longId, 'capture'));
  });
});

describe('createPayPalOrdersAdapter pay happy path', () => {
  it('token -> create -> capture with correct headers and body', async () => {
    const { fetchMock, calls } = createFetchMock(ordersHappyRoutes());
    let now = 1_000_000;
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
      now: () => now,
    });

    const receipt = await adapter.pay(baseIntent());

    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, `${BASE}/v1/oauth2/token`);
    assert.equal(calls[0]?.method, 'POST');
    const expectedBasic = Buffer.from(`${TEST_CLIENT}:${TEST_SECRET}`).toString('base64');
    assert.equal(calls[0]?.headers.authorization, `Basic ${expectedBasic}`);
    assert.equal(calls[0]?.body, 'grant_type=client_credentials');

    assert.equal(calls[1]?.url, `${BASE}/v2/checkout/orders`);
    assert.equal(calls[1]?.headers.authorization, 'Bearer tok-abc');
    const createBody = calls[1]?.body as {
      intent: string;
      purchase_units: Array<{ amount: { value: string; currency_code: string } }>;
    };
    assert.equal(createBody.intent, 'CAPTURE');
    assert.equal(createBody.purchase_units[0]?.amount.value, '12.50');
    assert.equal(createBody.purchase_units[0]?.amount.currency_code, 'USD');
    const createReqId = calls[1]?.headers['paypal-request-id'];
    assert.ok(createReqId);
    assert.equal(createReqId, requestId('intent-abc', 'create'));

    assert.match(calls[2]?.url ?? '', /\/v2\/checkout\/orders\/ORDER-1\/capture$/);
    const captureReqId = calls[2]?.headers['paypal-request-id'];
    assert.notEqual(createReqId, captureReqId);
    assert.equal(captureReqId, requestId('intent-abc', 'capture'));

    assert.equal(receipt.externalId, 'CAPTURE-123');
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.rail, 'paypal');
    assert.equal(receipt.intentId, 'intent-abc');
  });
});

describe('token caching', () => {
  it('reuses token across two pay() calls until expiry', async () => {
    let now = 0;
    const { fetchMock, calls } = createFetchMock([
      ...ordersHappyRoutes('CAP-1'),
      ...ordersHappyRoutes('CAP-2').slice(1),
      ...ordersHappyRoutes('CAP-3'),
    ]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
      now: () => now,
    });

    await adapter.pay(baseIntent({ id: 'i1' }));
    await adapter.pay(baseIntent({ id: 'i2' }));
    const tokenCallsAfterTwo = calls.filter((c) => c.url.endsWith('/oauth2/token'));
    assert.equal(tokenCallsAfterTwo.length, 1);

    now = 3600 * 1000;
    await adapter.pay(baseIntent({ id: 'i3' }));
    const tokenCallsAfterExpiry = calls.filter((c) => c.url.endsWith('/oauth2/token'));
    assert.equal(tokenCallsAfterExpiry.length, 2);
  });
});

describe('401 retry', () => {
  it('refreshes token and retries the API call once', async () => {
    let captureAttempts = 0;
    const { fetchMock, calls } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: /\/v2\/checkout\/orders$/,
        handler: () => jsonResponse({ id: 'ORDER-1', status: 'CREATED' }),
      },
      {
        method: 'POST',
        path: /\/capture$/,
        handler: () => {
          captureAttempts++;
          if (captureAttempts === 1) {
            return jsonResponse({ name: 'AUTHENTICATION_FAILURE', message: 'token expired' }, 401);
          }
          return jsonResponse({
            id: 'ORDER-1',
            status: 'COMPLETED',
            purchase_units: [{ payments: { captures: [{ id: 'CAP-RETRY', status: 'COMPLETED' }] } }],
          });
        },
      },
      tokenRoute(),
    ]);

    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
    });

    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.externalId, 'CAP-RETRY');
    assert.equal(receipt.status, 'succeeded');
    const tokenCalls = calls.filter((c) => c.url.endsWith('/oauth2/token'));
    assert.equal(tokenCalls.length, 2);
  });
});

describe('PayPalApiError mapping via onError', () => {
  async function failedOnCreate(
    status: number,
    body: unknown,
  ): Promise<{ receipt: Awaited<ReturnType<ReturnType<typeof createPayPalOrdersAdapter>['pay']>>; error: PayPalApiError }> {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: /\/v2\/checkout\/orders$/,
        handler: () => jsonResponse(body, status),
      },
    ]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
      onError: (e) => {
        errors.push(e);
      },
    });
    const receipt = await adapter.pay(baseIntent());
    assert.ok(errors[0] instanceof PayPalApiError);
    return { receipt, error: errors[0] as PayPalApiError };
  }

  it('maps 400 INVALID_REQUEST to failed', async () => {
    const { receipt, error } = await failedOnCreate(400, { name: 'INVALID_REQUEST', message: 'bad' });
    assert.equal(receipt.status, 'failed');
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
  });

  it('maps 404 RESOURCE_NOT_FOUND', async () => {
    const { error } = await failedOnCreate(404, { name: 'RESOURCE_NOT_FOUND', message: 'missing' });
    assert.equal(error.code, 'RESOURCE_NOT_FOUND');
  });

  it('maps 422 with issue and debug_id', async () => {
    const { error } = await failedOnCreate(422, {
      name: 'UNPROCESSABLE_ENTITY',
      message: 'not approved',
      debug_id: 'dbg-123',
      details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Buyer must approve' }],
    });
    assert.equal(error.code, 'UNPROCESSABLE_ENTITY');
    assert.equal(error.issue, 'ORDER_NOT_APPROVED');
    assert.equal(error.debugId, 'dbg-123');
  });

  it('maps 429 as retryable failed and 500 as pending', async () => {
    const r429 = await failedOnCreate(429, { name: 'RATE_LIMITED', message: 'slow down' });
    assert.equal(r429.error.code, 'RATE_LIMITED');
    assert.equal(r429.error.retryable, true);
    assert.equal(r429.receipt.status, 'failed');

    const r500 = await failedOnCreate(500, { name: 'INTERNAL', message: 'oops' });
    assert.equal(r500.error.code, 'PAYPAL_SERVER_ERROR');
    assert.equal(r500.error.retryable, true);
    assert.equal(r500.receipt.status, 'pending');
    assert.equal(r500.receipt.externalId, '');
  });

  it('handles non-JSON 500 body as pending', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: /\/v2\/checkout\/orders$/,
        handler: () => new Response('not json', { status: 500, headers: { 'content-type': 'text/plain' } }),
      },
    ]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
      onError: (e) => errors.push(e),
    });
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.ok(errors[0] instanceof PayPalApiError && errors[0].code === 'PAYPAL_SERVER_ERROR');
  });

  it('token 401 maps AUTHENTICATION_FAILED without secret in message', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      {
        method: 'POST',
        path: '/v1/oauth2/token',
        handler: () =>
          jsonResponse(
            { error: 'invalid_client', error_description: 'Client Authentication failed' },
            401,
          ),
      },
    ]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
      onError: (e) => errors.push(e),
    });
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.externalId, '');
    const err = errors[0];
    assert.ok(err instanceof PayPalApiError);
    assert.equal(err.code, 'AUTHENTICATION_FAILED');
    assert.ok(!err.message.includes(TEST_SECRET));
  });
});

describe('refund', () => {
  it('POSTs to capture refund URL with request id', async () => {
    const { fetchMock, calls } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v2/payments/captures/CAP-999/refund',
        handler: () => jsonResponse({ id: 'REFUND-1', status: 'COMPLETED' }),
      },
    ]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
    });
    const receipt = await adapter.refund!({
      intentId: 'intent-abc',
      rail: 'paypal',
      externalId: 'CAP-999',
      status: 'succeeded',
      at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.url, `${BASE}/v2/payments/captures/CAP-999/refund`);
    assert.equal(calls[1]?.headers['paypal-request-id'], requestId('intent-abc', 'refund'));
    assert.equal(receipt.status, 'refunded');
    assert.equal(receipt.externalId, 'REFUND-1');
  });

  it('maps PENDING refund status', async () => {
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/refund',
        handler: () => jsonResponse({ id: 'REFUND-P', status: 'PENDING' }),
      },
    ]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
    });
    const receipt = await adapter.refund!({
      intentId: 'i',
      rail: 'paypal',
      externalId: 'CAP-1',
      status: 'succeeded',
      at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(receipt.status, 'pending');
  });

  it('rejects non-paypal receipt', async () => {
    const { fetchMock } = createFetchMock([tokenRoute()]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      fetch: fetchMock,
    });
    await assert.rejects(
      () =>
        adapter.refund!({
          intentId: 'i',
          rail: 'mock',
          externalId: 'x',
          status: 'succeeded',
          at: '2026-01-01T00:00:00.000Z',
        }),
      /another rail/,
    );
  });

  it('rejects non-succeeded receipt', async () => {
    const { fetchMock } = createFetchMock([tokenRoute()]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      fetch: fetchMock,
    });
    await assert.rejects(
      () =>
        adapter.refund!({
          intentId: 'i',
          rail: 'paypal',
          externalId: 'CAP-1',
          status: 'failed',
          at: '2026-01-01T00:00:00.000Z',
        }),
      /succeeded/,
    );
  });
});

describe('validation before fetch', () => {
  it('invalid intent performs zero fetch calls', async () => {
    const { fetchMock, calls } = createFetchMock([tokenRoute()]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      fetch: fetchMock,
    });
    await assert.rejects(() => adapter.pay(baseIntent({ amount: 0 })));
    assert.equal(calls.length, 0);
  });
});

describe('payPalConfigFromEnv', () => {
  it('throws when credentials missing', () => {
    assert.throws(() => payPalConfigFromEnv({}), /PAYPAL_CLIENT_ID/);
    assert.throws(
      () => payPalConfigFromEnv({ PAYPAL_CLIENT_ID: 'id' }),
      /PAYPAL_CLIENT_SECRET/,
    );
  });

  it('uses default baseUrl and allows override', () => {
    const cfg = payPalConfigFromEnv({
      PAYPAL_CLIENT_ID: 'a',
      PAYPAL_CLIENT_SECRET: 'b',
    });
    assert.equal(cfg.clientId, 'a');
    assert.equal(cfg.clientSecret, 'b');
    assert.equal(cfg.baseUrl, undefined);

    const cfg2 = payPalConfigFromEnv({
      PAYPAL_CLIENT_ID: 'a',
      PAYPAL_CLIENT_SECRET: 'b',
      PAYPAL_BASE_URL: 'https://custom.example',
    });
    assert.equal(cfg2.baseUrl, 'https://custom.example');
  });
});

describe('contract', () => {
  it('receipt.intentId equals intent.id on pay (success and failed)', async () => {
    const { fetchMock } = createFetchMock(ordersHappyRoutes());
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
    });
    const intent = baseIntent({ id: 'my-intent' });
    const ok = await adapter.pay(intent);
    assert.equal(ok.intentId, intent.id);

    const { fetchMock: failFetch } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: /\/v2\/checkout\/orders$/,
        handler: () => jsonResponse({ id: 'ORDER-X', status: 'CREATED' }),
      },
      {
        method: 'POST',
        path: /\/capture$/,
        handler: () =>
          jsonResponse(
            {
              name: 'UNPROCESSABLE_ENTITY',
              details: [{ issue: 'ORDER_NOT_APPROVED' }],
            },
            422,
          ),
      },
    ]);
    const failAdapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: failFetch,
    });
    const failed = await failAdapter.pay(baseIntent({ id: 'fail-intent' }));
    assert.equal(failed.intentId, 'fail-intent');
    assert.equal(failed.status, 'failed');
  });

  it('receipt.rail equals adapter.rail on pay, failed pay, and refund', async () => {
    const { fetchMock } = createFetchMock(ordersHappyRoutes());
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
    });
    const paid = await adapter.pay(baseIntent());
    assert.equal(paid.rail, 'paypal');

    const { fetchMock: failFetch } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: /\/v2\/checkout\/orders$/,
        handler: () => jsonResponse({ name: 'INTERNAL' }, 500),
      },
    ]);
    const failAdapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: failFetch,
    });
    const failed = await failAdapter.pay(baseIntent());
    assert.equal(failed.rail, 'paypal');
    assert.equal(failed.status, 'pending');

    const { fetchMock: refundFetch } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/refund',
        handler: () => jsonResponse({ id: 'REF-1', status: 'COMPLETED' }),
      },
    ]);
    const refundAdapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: refundFetch,
    });
    const refunded = await refundAdapter.refund!({
      intentId: paid.intentId,
      rail: 'paypal',
      externalId: 'CAP-1',
      status: 'succeeded',
      at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(refunded.rail, 'paypal');
    assert.equal(refunded.intentId, paid.intentId);
  });

  it('unknown outcome on create/capture resolves without throwing', async () => {
    await assert.doesNotReject(async () => {
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'POST',
          path: /\/v2\/checkout\/orders$/,
          handler: () => jsonResponse({ id: 'ORDER-1', status: 'CREATED' }),
        },
        {
          method: 'POST',
          path: /\/capture$/,
          handler: () =>
            jsonResponse(
              {
                name: 'UNPROCESSABLE_ENTITY',
                details: [{ issue: 'ORDER_NOT_APPROVED' }],
              },
              422,
            ),
        },
      ]);
      const adapter = createPayPalOrdersAdapter({
        clientId: TEST_CLIENT,
        clientSecret: TEST_SECRET,
        baseUrl: BASE,
        fetch: fetchMock,
      });
      const r = await adapter.pay(baseIntent());
      assert.equal(r.status, 'failed');
      assert.equal(r.externalId, 'ORDER-1');
    });

    await assert.doesNotReject(async () => {
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'POST',
          path: /\/v2\/checkout\/orders$/,
          handler: () => jsonResponse({ id: 'ORDER-2', status: 'CREATED' }),
        },
        {
          method: 'POST',
          path: /\/capture$/,
          handler: () =>
            jsonResponse({
              id: 'ORDER-2',
              status: 'COMPLETED',
              purchase_units: [
                { payments: { captures: [{ id: 'CAP-D', status: 'DECLINED' }] } },
              ],
            }),
        },
      ]);
      const adapter = createPayPalOrdersAdapter({
        clientId: TEST_CLIENT,
        clientSecret: TEST_SECRET,
        baseUrl: BASE,
        fetch: fetchMock,
      });
      const r = await adapter.pay(baseIntent());
      assert.equal(r.status, 'failed');
      assert.equal(r.externalId, 'CAP-D');
    });

    await assert.doesNotReject(async () => {
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'POST',
          path: /\/v2\/checkout\/orders$/,
          handler: () => jsonResponse({ name: 'INTERNAL' }, 500),
        },
      ]);
      const adapter = createPayPalOrdersAdapter({
        clientId: TEST_CLIENT,
        clientSecret: TEST_SECRET,
        baseUrl: BASE,
        fetch: fetchMock,
      });
      const r = await adapter.pay(baseIntent());
      assert.equal(r.status, 'pending');
      assert.equal(r.externalId, '');
    });

    await assert.doesNotReject(async () => {
      const { fetchMock } = createFetchMock([
        tokenRoute(),
        {
          method: 'POST',
          path: /\/v2\/checkout\/orders$/,
          handler: () => {
            throw new TypeError('fetch failed');
          },
        },
      ]);
      const adapter = createPayPalOrdersAdapter({
        clientId: TEST_CLIENT,
        clientSecret: TEST_SECRET,
        baseUrl: BASE,
        fetch: fetchMock,
      });
      const r = await adapter.pay(baseIntent());
      assert.equal(r.status, 'pending');
      assert.equal(r.externalId, '');
    });

    await assert.doesNotReject(async () => {
      const { fetchMock } = createFetchMock([
        {
          method: 'POST',
          path: '/v1/oauth2/token',
          handler: () => {
            throw new TypeError('fetch failed');
          },
        },
      ]);
      const adapter = createPayPalOrdersAdapter({
        clientId: TEST_CLIENT,
        clientSecret: TEST_SECRET,
        baseUrl: BASE,
        fetch: fetchMock,
      });
      const r = await adapter.pay(baseIntent());
      assert.equal(r.status, 'failed');
    });
  });

  it('every receipt status in tests is allowed', async () => {
    const { fetchMock } = createFetchMock(ordersHappyRoutes());
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
    });
    assertAllowedStatus((await adapter.pay(baseIntent())).status);

    const { fetchMock: pendingFetch } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: /\/v2\/checkout\/orders$/,
        handler: () => jsonResponse({ id: 'ORDER-P', status: 'CREATED' }),
      },
      {
        method: 'POST',
        path: /\/capture$/,
        handler: () =>
          jsonResponse({
            id: 'ORDER-P',
            status: 'COMPLETED',
            purchase_units: [
              { payments: { captures: [{ id: 'CAP-P', status: 'PENDING' }] } },
            ],
          }),
      },
    ]);
    const pendingAdapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: pendingFetch,
    });
    assertAllowedStatus((await pendingAdapter.pay(baseIntent())).status);

    const { fetchMock: failFetch } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: /\/v2\/checkout\/orders$/,
        handler: () => jsonResponse({ id: 'ORDER-F', status: 'CREATED' }),
      },
      {
        method: 'POST',
        path: /\/capture$/,
        handler: () => jsonResponse({ name: 'UNPROCESSABLE_ENTITY' }, 422),
      },
    ]);
    const failAdapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: failFetch,
    });
    assertAllowedStatus((await failAdapter.pay(baseIntent())).status);

    const { fetchMock: refundFetch } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/refund',
        handler: () => jsonResponse({ id: 'REF-1', status: 'COMPLETED' }),
      },
    ]);
    const refundAdapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: refundFetch,
    });
    assertAllowedStatus(
      (
        await refundAdapter.refund!({
          intentId: 'i',
          rail: 'paypal',
          externalId: 'CAP-1',
          status: 'succeeded',
          at: '2026-01-01T00:00:00.000Z',
        })
      ).status,
    );
  });

  it('PayPal refund API error resolves with status failed', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/refund',
        handler: () => jsonResponse({ name: 'RESOURCE_NOT_FOUND' }, 404),
      },
    ]);
    const adapter = createPayPalOrdersAdapter({
      clientId: TEST_CLIENT,
      clientSecret: TEST_SECRET,
      baseUrl: BASE,
      fetch: fetchMock,
      onError: (e) => errors.push(e),
    });
    const result = await adapter.refund!({
      intentId: 'intent-abc',
      rail: 'paypal',
      externalId: 'CAP-404',
      status: 'succeeded',
      at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.intentId, 'intent-abc');
    assert.equal(result.rail, 'paypal');
    assert.equal(result.externalId, 'CAP-404');
    assert.ok(errors[0] instanceof PayPalApiError);
  });
});
