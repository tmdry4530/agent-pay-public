import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalAdapter } from '../src/paypal.ts';
import { paypalErrorMeta, redactSecrets } from '../src/paypal-error-meta.ts';
import { PayPalApiError, parsePayPalError } from '../src/paypal-client.ts';
import { receiptMeta } from '../src/adapter-types.ts';
import type { PaymentIntent } from '../src/index.ts';

const CLIENT_ID = 'AbCdClientId-test-0001';
const CLIENT_SECRET = 'EfGhClientSecret-test-0002';
const ACCESS_TOKEN = 'A21AAtesttokenvalue1234567890abcdefXYZ';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function adapterWith(handler: (url: string, method: string) => Response | Promise<Response>) {
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, (init?.method ?? 'GET').toUpperCase());
  };
  return createPayPalAdapter({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fetchMock, now: () => 1_700_000_000_000 });
}

const tokenOk = () => jsonResponse({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 });

const intent: PaymentIntent = {
  id: 'intent-err',
  agentId: 'agent-1',
  payee: 'payee@example.com',
  amount: 10,
  currency: 'USD',
  purpose: 'error detail',
  createdAt: '2026-11-01T00:00:00.000Z',
};

/** No secret material anywhere in what would be written to the ledger. */
function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const needle of [ACCESS_TOKEN, CLIENT_SECRET, CLIENT_ID, 'Bearer A21', Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')]) {
    assert.ok(!text.includes(needle), `ledger receipt leaks ${needle}`);
  }
  assert.ok(!/authorization/i.test(Object.keys(receiptMetaOf(value)).join(',')), 'no header fields in meta');
}
const receiptMetaOf = (v: unknown) => ((v as { meta?: Record<string, string> }).meta ?? {});

describe('PayPal failed payout: error detail in receipt meta', () => {
  it('422 INSUFFICIENT_FUNDS: status, name, message, debug_id and details are recorded', async () => {
    const adapter = adapterWith((url) => {
      if (url.endsWith('/v1/oauth2/token')) return tokenOk();
      return jsonResponse(
        {
          name: 'INSUFFICIENT_FUNDS',
          message: 'Sender does not have sufficient funds. Please add funds and retry.',
          debug_id: 'f0e1d2c3b4a59',
          information_link: 'https://developer.paypal.com/docs/api/payments.payouts-batch/#errors',
          details: [{ field: 'items[0].amount', location: 'body', issue: 'INSUFFICIENT_FUNDS', description: 'Not enough balance', value: 'payee@example.com' }],
        },
        422,
      );
    });
    const receipt = await adapter.pay(intent);
    assert.equal(receipt.status, 'failed');
    const meta = receiptMeta(receipt)!;
    assert.equal(meta.errorOp, 'payout');
    assert.equal(meta.errorStatus, '422');
    assert.equal(meta.errorName, 'INSUFFICIENT_FUNDS');
    assert.equal(meta.errorMessage, 'Sender does not have sufficient funds. Please add funds and retry.');
    assert.equal(meta.errorDebugId, 'f0e1d2c3b4a59');
    assert.deepEqual(JSON.parse(meta.errorDetails!), [
      { field: 'items[0].amount', location: 'body', issue: 'INSUFFICIENT_FUNDS', description: 'Not enough balance' },
    ]);
    assert.ok(!meta.errorDetails!.includes('payee@example.com'), 'detail `value` is not kept');
    assert.match(meta.error!, /^paypal payout failed: HTTP 422: INSUFFICIENT_FUNDS: Sender does not have/);
    assert.match(meta.error!, /debug_id f0e1d2c3b4a59/);
    for (const v of Object.values(meta)) assert.equal(typeof v, 'string');
    assertNoSecrets(receipt);
  });

  it('a token echoed in the PayPal message is redacted; headers are never recorded', async () => {
    const adapter = adapterWith((url) => {
      if (url.endsWith('/v1/oauth2/token')) return tokenOk();
      return jsonResponse(
        {
          name: 'VALIDATION_ERROR',
          message: `Invalid request: Authorization: Bearer ${ACCESS_TOKEN} access_token=${ACCESS_TOKEN} client_secret=${CLIENT_SECRET}`,
          debug_id: 'abc123def',
          details: [{ issue: 'BAD', description: `token ${ACCESS_TOKEN}` }],
        },
        400,
        { 'paypal-debug-id': 'hdr-debug-1', authorization: `Bearer ${ACCESS_TOKEN}` },
      );
    });
    const receipt = await adapter.pay(intent);
    assert.equal(receipt.status, 'failed');
    const meta = receiptMeta(receipt)!;
    assert.equal(meta.errorStatus, '400');
    assert.equal(meta.errorName, 'VALIDATION_ERROR');
    assert.match(meta.errorMessage!, /\[redacted\]/);
    assert.equal(meta.errorDebugId, 'abc123def', 'body debug_id wins over the header');
    assertNoSecrets(receipt);
  });

  it('token call 401 invalid_client: recorded with op token, OAuth error name and header debug id', async () => {
    const adapter = adapterWith(() =>
      jsonResponse({ error: 'invalid_client', error_description: 'Client Authentication failed' }, 401, { 'paypal-debug-id': 'oauthdbg42' }),
    );
    const receipt = await adapter.pay(intent);
    assert.equal(receipt.status, 'failed');
    const meta = receiptMeta(receipt)!;
    assert.equal(meta.errorOp, 'token');
    assert.equal(meta.errorStatus, '401');
    assert.equal(meta.errorName, 'invalid_client');
    assert.equal(meta.errorMessage, 'Client Authentication failed');
    assert.equal(meta.errorDebugId, 'oauthdbg42');
    assertNoSecrets(receipt);
  });

  it('token call network error: errorType/message, no HTTP status', async () => {
    const adapter = adapterWith(() => {
      throw new TypeError('fetch failed');
    });
    const receipt = await adapter.pay(intent);
    assert.equal(receipt.status, 'failed');
    const meta = receiptMeta(receipt)!;
    assert.equal(meta.errorOp, 'token');
    assert.equal(meta.errorStatus, undefined);
    assert.equal(meta.errorType, 'TypeError');
    assert.equal(meta.error, 'paypal token failed: TypeError: fetch failed');
  });

  it('5xx (unknown outcome) keeps pending + needsManualResolve and adds the error detail', async () => {
    const adapter = adapterWith((url) => {
      if (url.endsWith('/v1/oauth2/token')) return tokenOk();
      return jsonResponse({ name: 'INTERNAL_SERVER_ERROR', message: 'An internal server error occurred.', debug_id: '5xxdebug' }, 500);
    });
    const receipt = await adapter.pay(intent);
    assert.equal(receipt.status, 'pending');
    const meta = receiptMeta(receipt)!;
    assert.equal(meta.needsManualResolve, 'true');
    assert.equal(meta.errorStatus, '500');
    assert.equal(meta.errorName, 'INTERNAL_SERVER_ERROR');
    assert.equal(meta.errorDebugId, '5xxdebug');
    assertNoSecrets(receipt);
  });
});

describe('redactSecrets / paypalErrorMeta', () => {
  it('redacts Bearer/Basic credentials, secret-named pairs, PayPal tokens, JWTs, NEAR keys and long blobs', () => {
    const out = redactSecrets(
      [
        'Bearer abc.def-123',
        'Basic dXNlcjpwYXNz',
        '"access_token":"xyz987"',
        'client_secret=s3cr3t',
        'A21AAabcdefghijk',
        'eyJhbGciOi.eyJzdWIiOiIx.sig',
        'ed25519:3J5x7mQx8Yh2kP1ZoFvW9n',
        'Q'.repeat(40),
      ].join(' | '),
    );
    for (const leaked of ['abc.def-123', 'dXNlcjpwYXNz', 'xyz987', 's3cr3t', 'A21AAabcdefghijk', 'eyJhbGciOi', 'ed25519:3J5', 'Q'.repeat(40)]) {
      assert.ok(!out.includes(leaked), `left ${leaked} in ${out}`);
    }
    assert.equal(redactSecrets('Receiver is unregistered'), 'Receiver is unregistered');
  });

  it('removes configured secrets verbatim', () => {
    assert.equal(redactSecrets('bad id myClientId1', ['myClientId1']), 'bad id [redacted]');
  });

  it('builds meta from a parsed PayPalApiError without a name', async () => {
    const err = await parsePayPalError(new Response('<html>oops</html>', { status: 502, headers: { 'paypal-debug-id': 'h1' } }));
    assert.ok(err instanceof PayPalApiError);
    const meta = paypalErrorMeta(err, 'status');
    assert.equal(meta.errorStatus, '502');
    assert.equal(meta.errorName, undefined);
    assert.equal(meta.errorDebugId, 'h1');
    assert.equal(meta.error, 'paypal status failed: HTTP 502: PayPal API error (502): debug_id h1');
  });
});
