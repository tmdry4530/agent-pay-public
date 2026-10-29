/**
 * H3 — PayPal HTTP timeout must be wired in apps/api paypalFactory (default 30s, PAYPAL_TIMEOUT_MS).
 *
 * Observable approach: the fix exports `paypalTimeoutMsFromEnv` from adapters.ts and uses it when
 * building PayPalConfig for createPayPalAdapter; invalid PAYPAL_TIMEOUT_MS fails at factory time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as apiAdapters from '../src/adapters.ts';
import { AdapterConfigError, paypalFactory } from '../src/adapters.ts';

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

test('paypalFactory wires paypalTimeoutMsFromEnv into createPayPalAdapter config', () => {
  paypalTimeoutMsFromEnv();
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(dir, '../src/adapters.ts'), 'utf8');
  assert.match(
    src,
    /timeoutMs:\s*paypalTimeoutMsFromEnv\s*\(/,
    'paypalFactory must pass timeoutMs from paypalTimeoutMsFromEnv(ctx.env)',
  );
});
