/**
 * H3 — PayPal HTTP timeout must be wired in apps/api paypalFactory (default 30s, PAYPAL_TIMEOUT_MS).
 *
 * Observable approach: the fix exports `paypalTimeoutMsFromEnv` from adapters.ts and uses it when
 * building PayPalConfig for createPayPalAdapter; invalid PAYPAL_TIMEOUT_MS fails at factory time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { receiptMeta, type Receipt } from '@agent-pay/adapters';
import * as apiAdapters from '../src/adapters.ts';
import { AdapterConfigError, paypalFactory } from '../src/adapters.ts';
import { createServer, railSeed } from '../src/index.ts';

const NOW = () => new Date('2026-10-28T12:00:00.000Z');

type TimeoutFromEnv = (env: Readonly<Record<string, string | undefined>>) => number;

function paypalTimeoutMsFromEnv(): TimeoutFromEnv {
  const fn = (apiAdapters as Record<string, unknown>).paypalTimeoutMsFromEnv;
  assert.equal(typeof fn, 'function', 'export paypalTimeoutMsFromEnv from apps/api/src/adapters.ts');
  return fn as TimeoutFromEnv;
}

const basePayPalEnv = {
  PAYPAL_CLIENT_ID: 'test-client',
  PAYPAL_CLIENT_SECRET: 'test-secret',
};

test('paypalTimeoutMsFromEnv: default 30000 when unset', () => {
  const fromEnv = paypalTimeoutMsFromEnv();
  assert.equal(fromEnv({}), 30_000);
  assert.equal(fromEnv({ PAYPAL_TIMEOUT_MS: '' }), 30_000);
  assert.equal(fromEnv({ PAYPAL_TIMEOUT_MS: '   ' }), 30_000);
});

test('paypalTimeoutMsFromEnv: parses positive integer milliseconds', () => {
  const fromEnv = paypalTimeoutMsFromEnv();
  assert.equal(fromEnv({ PAYPAL_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(fromEnv({ PAYPAL_TIMEOUT_MS: '1' }), 1);
});

test('paypalTimeoutMsFromEnv: rejects non-positive and non-integer values', () => {
  const fromEnv = paypalTimeoutMsFromEnv();
  for (const bad of ['0', '-1', 'abc', '1.5']) {
    assert.throws(
      () => fromEnv({ PAYPAL_TIMEOUT_MS: bad }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^adapter_config:/);
        return true;
      },
      `expected adapter_config error for PAYPAL_TIMEOUT_MS=${JSON.stringify(bad)}`,
    );
  }
});

test('paypalFactory: invalid PAYPAL_TIMEOUT_MS throws AdapterConfigError at factory time', () => {
  assert.throws(
    () =>
      paypalFactory({
        env: { ...basePayPalEnv, PAYPAL_TIMEOUT_MS: 'not-a-number' },
        now: NOW,
      }),
    (err: unknown) => {
      assert.ok(err instanceof AdapterConfigError);
      assert.match(err.message, /^adapter_config:/);
      return true;
    },
  );
});

test('paypalFactory: PAYPAL_TIMEOUT_MS aborts hung PayPal HTTP within configured timeout', async (t) => {
  const originalFetch = globalThis.fetch;
  const stubCalls: { hadSignal: boolean; aborted: boolean }[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.includes('127.0.0.1')) {
      return originalFetch(input, init);
    }
    if (href.includes('/v1/oauth2/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    const signal = init?.signal ?? null;
    const record = { hadSignal: signal != null, aborted: signal?.aborted ?? false };
    stubCalls.push(record);

    return new Promise<Response>((_resolve, reject) => {
      let safety: ReturnType<typeof setTimeout> | undefined;
      const finishAbort = () => {
        record.aborted = true;
        if (safety !== undefined) clearTimeout(safety);
        const reason = signal?.reason;
        if (reason !== undefined) {
          reject(reason);
          return;
        }
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal) {
        if (signal.aborted) {
          finishAbort();
          return;
        }
        signal.addEventListener('abort', finishAbort, { once: true });
      } else {
        safety = setTimeout(() => {
          reject(new DOMException('PayPal fetch stub safety timeout', 'AbortError'));
        }, 2000);
      }
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const seed = railSeed('paypal');
  const adapter = await paypalFactory({
    env: { ...basePayPalEnv, PAYPAL_TIMEOUT_MS: '30' },
    now: NOW,
  });
  assert.equal(adapter.rail, 'paypal');

  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-paypal-timeout-'));
  const server: Server = createServer({
    ledger: join(dir, 'ledger.json'),
    adapter,
    policy: seed.policy,
    demo: { currency: seed.currency, amountScale: seed.amountScale, payees: seed.payees },
    now: NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });

  const intentId = 'pi_paypal_http_timeout';
  const body = {
    id: intentId,
    agentId: 'demo-agent',
    payee: seed.payees['openai-api']!,
    amount: 10,
    currency: 'USD',
    purpose: 'inference credits',
    createdAt: NOW().toISOString(),
  };

  const started = performance.now();
  const res = await originalFetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 1500, `expected POST to settle quickly, took ${elapsed}ms`);
  assert.equal(res.status, 201);

  const paid = (await res.json()) as {
    status: string;
    receipt: Receipt;
    needsManualResolve?: true;
  };
  assert.equal(paid.status, 'paid');
  assert.equal(paid.receipt.status, 'pending');
  assert.equal(paid.receipt.externalId, '');
  assert.equal(paid.needsManualResolve, undefined);
  assert.equal(receiptMeta(paid.receipt)?.unknownOutcome, 'true');
  assert.equal(receiptMeta(paid.receipt)?.needsManualResolve, 'true');

  assert.ok(stubCalls.length >= 1, 'PayPal HTTP stub should run for payout');
  const hung = stubCalls.find((c) => c.hadSignal);
  assert.ok(hung, 'expected at least one stubbed fetch with AbortSignal.timeout');
  assert.equal(hung.aborted, true, 'timeout signal should abort the hung fetch');

  const ledgerRes = await originalFetch(`${base}/ledger`);
  assert.equal(ledgerRes.status, 200);
  const ledger = (await ledgerRes.json()) as {
    entries: {
      intent: { id: string };
      paymentStatus?: string;
      needsManualResolve?: true;
      receipt?: { status: string; meta?: Record<string, string> };
    }[];
  };
  const entry = ledger.entries.find((e) => e.intent.id === intentId);
  assert.ok(entry);
  assert.equal(entry.paymentStatus, 'paid');
  assert.notEqual(entry.paymentStatus, 'failed');
  assert.equal(entry.needsManualResolve, undefined);
  assert.equal(entry.receipt?.status, 'pending');
  assert.equal(entry.receipt?.meta?.needsManualResolve, 'true');
});
