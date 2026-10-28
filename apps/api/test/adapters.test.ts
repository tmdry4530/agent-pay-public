import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterValidationError } from '@agent-pay/adapters';
import { base58Encode } from '@agent-pay/adapters';
import type { StatusCapableAdapter } from '@agent-pay/adapters';
import type { PaymentIntent, Rail } from '@agent-pay/core';
import {
  AdapterConfigError,
  DEFAULT_LEDGER_PATH,
  DEFAULT_PORT,
  adapterRegistry,
  createAdapter,
  createMockAdapter,
  loadConfig,
  parseRail,
} from '../src/index.ts';
import type { AdapterFactory } from '../src/index.ts';

const execFileAsync = promisify(execFile);
const NOW = () => new Date('2026-10-28T12:00:00.000Z');

const intent = (): PaymentIntent => ({
  id: 'pi_test',
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'test',
  createdAt: '2026-10-28T12:00:00.000Z',
});

test('parseRail(undefined) and parseRail("") default to mock', () => {
  assert.equal(parseRail(undefined), 'mock');
  assert.equal(parseRail(''), 'mock');
});

test('parseRail("bogus") throws AdapterConfigError', () => {
  assert.throws(() => parseRail('bogus'), AdapterConfigError);
});

test('near is wired to packages/adapters and needs credentials from env', async () => {
  await assert.rejects(createAdapter('near', { env: {}, now: NOW }), (err: unknown) => {
    assert.ok(err instanceof AdapterConfigError);
    assert.match(err.message, /^adapter_config: NEAR_ACCOUNT_ID environment variable is required/);
    return true;
  });

  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
    throw new Error('expected ed25519 jwk material');
  }
  const seed = new Uint8Array(Buffer.from(jwk.d, 'base64url'));
  const rawPub = new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  const material = new Uint8Array(seed.length + rawPub.length);
  material.set(seed, 0);
  material.set(rawPub, seed.length);
  const nearPrivateKey = `ed25519:${base58Encode(material)}`;

  const adapter = await createAdapter('near', {
    env: {
      NEAR_ACCOUNT_ID: 'agent.testnet',
      NEAR_PRIVATE_KEY: nearPrivateKey,
      NEAR_RPC_URL: 'http://127.0.0.1:9',
    },
    now: NOW,
  });
  assert.equal(adapter.rail, 'near');
  assert.equal(typeof (adapter as StatusCapableAdapter).status, 'function');
  assert.equal(adapter.refund, undefined);

  const malformedKey = 'ed25519:!!!not-a-valid-near-private-key!!!';
  await assert.rejects(
    createAdapter('near', {
      env: {
        NEAR_ACCOUNT_ID: 'agent.testnet',
        NEAR_PRIVATE_KEY: malformedKey,
        NEAR_RPC_URL: 'http://127.0.0.1:9',
      },
      now: NOW,
    }),
    (err: unknown) => {
      assert.ok(err instanceof AdapterConfigError);
      assert.ok(!err.message.includes(malformedKey));
      return true;
    },
  );
});

test('paypal is wired to packages/adapters and needs credentials from env', async () => {
  await assert.rejects(createAdapter('paypal', { env: {}, now: NOW }), (err: unknown) => {
    assert.ok(err instanceof AdapterConfigError);
    assert.match(err.message, /^adapter_config: PAYPAL_CLIENT_ID environment variable is required/);
    return true;
  });
  // Placeholder values: building the adapter makes no network call.
  const adapter = await createAdapter('paypal', {
    env: { PAYPAL_CLIENT_ID: 'test-id', PAYPAL_CLIENT_SECRET: 'test-secret', PAYPAL_BASE_URL: 'http://127.0.0.1:9' },
    now: NOW,
  });
  assert.equal(adapter.rail, 'paypal');
});

test('paypal adapter is Payouts: status, no refund, email payee required', async () => {
  const adapter = await createAdapter('paypal', {
    env: {
      PAYPAL_CLIENT_ID: 'test-id',
      PAYPAL_CLIENT_SECRET: 'test-secret',
      PAYPAL_BASE_URL: 'http://127.0.0.1:9',
    },
    now: NOW,
  });
  assert.equal(typeof (adapter as { status?: unknown }).status, 'function');
  assert.equal(adapter.refund, undefined);
  await assert.rejects(() => adapter.pay(intent()), (err: unknown) => err instanceof AdapterValidationError);
});

test('createAdapter("mock") pays with a succeeded receipt matching the intent', async () => {
  const adapter = await createAdapter('mock', { env: {}, now: NOW });
  const i = intent();
  const receipt = await adapter.pay(i);
  assert.equal(receipt.intentId, i.id);
  assert.equal(receipt.rail, 'mock');
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.at, NOW().toISOString());
  assert.match(receipt.externalId, /^mock_/);
});

test('createAdapter rejects factory that returns wrong rail', async () => {
  const badRegistry: Record<Rail, AdapterFactory | undefined> = {
    ...adapterRegistry,
    paypal: () => ({
      rail: 'mock',
      pay: async () => ({
        intentId: 'x',
        rail: 'mock',
        externalId: 'y',
        status: 'succeeded',
        at: NOW().toISOString(),
      }),
    }),
  };
  await assert.rejects(createAdapter('paypal', { env: {}, now: NOW }, badRegistry), /adapter_mismatch/);
});

test('createAdapter uses a custom registry plug-in for paypal', async () => {
  let plugInCalled = false;
  const registry: Record<Rail, AdapterFactory | undefined> = {
    ...adapterRegistry,
    paypal: (ctx) => {
      plugInCalled = true;
      return { ...createMockAdapter(ctx), rail: 'paypal' as const };
    },
  };
  const adapter = await createAdapter('paypal', { env: {}, now: NOW }, registry);
  assert.equal(plugInCalled, true);
  assert.equal(adapter.rail, 'paypal');
});

async function runMainExpectingFailure(env: Record<string, string>): Promise<string> {
  const mainPath = join(import.meta.dirname, '../src/main.ts');
  const {
    PAYPAL_CLIENT_ID: _id,
    PAYPAL_CLIENT_SECRET: _secret,
    NEAR_ACCOUNT_ID: _nearAccount,
    NEAR_PRIVATE_KEY: _nearKey,
    NEAR_RPC_URL: _nearRpc,
    NEAR_NETWORK: _nearNetwork,
    NEAR_RECEIVER_ID: _nearReceiver,
    ...baseEnv
  } = process.env;
  try {
    await execFileAsync(process.execPath, [mainPath], {
      env: {
        ...baseEnv,
        PORT: '0',
        LEDGER_PATH: join(tmpdir(), 'agent-pay-unused', 'ledger.json'),
        ...env,
      },
      timeout: 10_000,
      encoding: 'utf8',
    });
  } catch (err: unknown) {
    const e = err as { code?: number; stderr?: string };
    assert.equal(e.code, 1);
    return e.stderr ?? '';
  }
  return assert.fail('expected main to exit with code 1');
}

test('main entrypoint exits 1 for RAIL=paypal without credentials', async () => {
  assert.match(await runMainExpectingFailure({ RAIL: 'paypal' }), /PAYPAL_CLIENT_ID environment variable is required/);
});

test('main entrypoint exits 1 for RAIL=near without NEAR env', async () => {
  assert.match(await runMainExpectingFailure({ RAIL: 'near' }), /NEAR_ACCOUNT_ID environment variable is required/);
});

test('loadConfig defaults: port 8787, rail mock, ledger under apps/api/.data', () => {
  const config = loadConfig({});
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.port, 8787);
  assert.equal(config.rail, 'mock');
  assert.ok(config.ledgerPath.endsWith('apps/api/.data/ledger.json'));
  assert.equal(config.ledgerPath, DEFAULT_LEDGER_PATH);
});

test('loadConfig throws on invalid PORT', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), AdapterConfigError);
});
