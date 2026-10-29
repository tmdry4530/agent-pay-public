/**
 * H4 — PayPal payout JSON parse failures must not throw from pay(); unknown outcomes carry manual-resolve meta.
 * Reuses the fetch-mock pattern from packages/adapters/test/paypal.test.ts (no network).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PaymentIntent } from '../src/index.ts';
import { createPayPalAdapter } from '../src/paypal.ts';
import { receiptMeta } from '../src/adapter-types.ts';

const TEST_CLIENT = 'test-client-id';
const TEST_SECRET = 'test-client-secret';
const BASE = 'https://api-m.sandbox.paypal.com';

type RouteSpec = {
  method: string;
  path: string | RegExp;
  handler: () => Response | Promise<Response>;
};

function createFetchMock(routes: RouteSpec[]) {
  const fetchMock: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const route of routes) {
      const pathOk =
        typeof route.path === 'string' ? url.includes(route.path) : route.path.test(url);
      if (method === route.method && pathOk) {
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

function tokenRoute() {
  return {
    method: 'POST',
    path: '/v1/oauth2/token',
    handler: () => jsonResponse({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
  } satisfies RouteSpec;
}

function baseIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'intent-h4-json',
    agentId: 'agent-1',
    payee: 'payee@example.com',
    amount: 3,
    currency: 'USD',
    purpose: 'hardening json',
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

describe('H4 — malformed PayPal JSON on pay()', () => {
  it('POST 201 with non-JSON body -> pending, unknownOutcome, needsManualResolve, onError', async () => {
    const errors: unknown[] = [];
    const { fetchMock } = createFetchMock([
      tokenRoute(),
      {
        method: 'POST',
        path: '/v1/payments/payouts',
        handler: () =>
          new Response('<html>not json</html>', {
            status: 201,
            headers: { 'content-type': 'text/html' },
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

  it('duplicate batch GET 200 with non-JSON body -> pending, no throw, manual-resolve meta', async () => {
    const errors: unknown[] = [];
    const batchId = 'BATCH-NONJSON-GET';
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
              links: [{ href: `${BASE}/v1/payments/payouts/${batchId}`, rel: 'self' }],
            },
            400,
          ),
      },
      {
        method: 'GET',
        path: `/v1/payments/payouts/${batchId}`,
        handler: () =>
          new Response('<html>gateway page</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
    ]);
    const adapter = createPayPalAdapter(adapterConfig(fetchMock, (e) => errors.push(e)));
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, batchId);
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(receiptMeta(receipt)?.needsManualResolve, 'true');
    assert.ok(errors.length > 0);
  });
});
