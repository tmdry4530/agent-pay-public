import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AdapterConfigError } from '../src/adapters.ts';
import { formatStartupError, missingEnvNames, redactEnvValues } from '../src/startup-error.ts';

const execFileAsync = promisify(execFile);
const MAIN = join(import.meta.dirname, '../src/main.ts');

// Obviously fake values: they must never show up in what main prints.
const FAKE = {
  id: 'fake-client-id-DO-NOT-PRINT-1111',
  secret: 'fake-client-secret-DO-NOT-PRINT-2222',
  near: 'ed25519:fake-near-key-DO-NOT-PRINT-3333',
  token: 'fake-token-DO-NOT-PRINT-4444',
};

/** Runs main.ts with only the given rail-related env (inherited PAYPAL_* / NEAR_* stripped); expects exit 1. */
async function startExpectingFailure(t: { after: (fn: () => Promise<void>) => void }, env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PAYPAL|NEAR)_/.test(k)));
  try {
    await execFileAsync(process.execPath, [MAIN], {
      env: { ...base, PORT: '0', HOST: '127.0.0.1', LEDGER_PATH: join(dir, 'ledger.json'), ...env },
      timeout: 10_000,
      encoding: 'utf8',
    });
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    assert.equal(e.code, 1);
    assert.deepEqual(await readdir(dir), [], 'no ledger is written when startup fails');
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', all: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
  return assert.fail('expected main to exit 1');
}

function assertNoSecretsOrStack(output: string) {
  for (const value of Object.values(FAKE)) assert.ok(!output.includes(value), `output leaked a fake secret value`);
  assert.doesNotMatch(output, /^\s+at /m, 'no stack trace');
}

test('main RAIL=paypal with no credentials lists both missing names, no values, no stack', async (t) => {
  const { stderr, all } = await startExpectingFailure(t, {
    RAIL: 'paypal',
    PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com',
    NEAR_PRIVATE_KEY: FAKE.near,
    SOME_API_TOKEN: FAKE.token,
  });
  assert.match(stderr, /^agent-pay api failed to start: adapter_config: PAYPAL_CLIENT_ID environment variable is required \(RAIL=paypal\)$/m);
  assert.match(stderr, /^missing required env vars for RAIL=paypal: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET$/m);
  assert.match(stderr, /\.env\.example/);
  assertNoSecretsOrStack(all);
});

test('main RAIL=paypal with only the client id set lists PAYPAL_CLIENT_SECRET and never prints the id', async (t) => {
  const { stderr, all } = await startExpectingFailure(t, { RAIL: 'paypal', PAYPAL_CLIENT_ID: FAKE.id, PAYPAL_CLIENT_SECRET: '   ' });
  assert.match(stderr, /^missing required env vars for RAIL=paypal: PAYPAL_CLIENT_SECRET$/m);
  assertNoSecretsOrStack(all);
});

test('main RAIL=near with no NEAR credentials lists both missing names from AdapterConfigError, no values', async (t) => {
  const { stderr, all } = await startExpectingFailure(t, {
    RAIL: 'near',
    NEAR_NETWORK: 'testnet',
    PAYPAL_CLIENT_ID: FAKE.id,
    PAYPAL_CLIENT_SECRET: FAKE.secret,
    SOME_API_TOKEN: FAKE.token,
  });
  assert.match(stderr, /^agent-pay api failed to start: adapter_config: NEAR_ACCOUNT_ID environment variable is required \(RAIL=near\)$/m);
  assert.match(stderr, /^missing required env vars for RAIL=near: NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY$/m);
  assert.match(stderr, /\.env\.example/);
  assert.doesNotMatch(stderr, /adapter_not_wired|not available in this build/);
  assertNoSecretsOrStack(all);
});

test('main RAIL=near with only the private key set lists NEAR_ACCOUNT_ID and never prints the key', async (t) => {
  const { stderr, all } = await startExpectingFailure(t, { RAIL: 'near', NEAR_PRIVATE_KEY: FAKE.near, PAYPAL_CLIENT_SECRET: FAKE.secret });
  assert.match(stderr, /^missing required env vars for RAIL=near: NEAR_ACCOUNT_ID$/m);
  assertNoSecretsOrStack(all);
});

test('main RAIL=paypal-orders is not a server rail (Orders v2 is adapter-side only): unknown_rail, no env needed', async (t) => {
  const { stderr, all } = await startExpectingFailure(t, { RAIL: 'paypal-orders', PAYPAL_CLIENT_ID: FAKE.id, PAYPAL_CLIENT_SECRET: FAKE.secret });
  assert.match(stderr, /^agent-pay api failed to start: unknown_rail: RAIL must be one of mock\|paypal\|near, got "paypal-orders"$/m);
  assert.doesNotMatch(stderr, /missing required env vars/);
  assertNoSecretsOrStack(all);
});

test('nearFactory / paypalFactory: AdapterConfigError.missing carries names only', async () => {
  const { nearFactory, paypalFactory } = await import('../src/adapters.ts');
  const now = () => new Date();
  assert.throws(
    () => nearFactory({ env: { NEAR_PRIVATE_KEY: FAKE.near }, now }),
    (err: unknown) => err instanceof AdapterConfigError && JSON.stringify(err.missing) === '["NEAR_ACCOUNT_ID"]' && !err.message.includes(FAKE.near),
  );
  assert.throws(
    () => paypalFactory({ env: {}, now }),
    (err: unknown) => err instanceof AdapterConfigError && JSON.stringify(err.missing) === '["PAYPAL_CLIENT_ID","PAYPAL_CLIENT_SECRET"]',
  );
  // Invalid (not missing) config: no names listed.
  assert.throws(
    () => nearFactory({ env: { NEAR_ACCOUNT_ID: 'alice.testnet', NEAR_PRIVATE_KEY: FAKE.near, NEAR_NETWORK: 'devnet' }, now }),
    (err: unknown) => err instanceof AdapterConfigError && err.missing === undefined && /NEAR_NETWORK must be testnet or mainnet/.test(err.message),
  );
});

test('main with a bad PORT fails cleanly', async (t) => {
  const { stderr, all } = await startExpectingFailure(t, { PORT: 'abc' });
  assert.match(stderr, /^agent-pay api failed to start: invalid_port: /m);
  assertNoSecretsOrStack(all);
});

test('missingEnvNames: AdapterConfigError.missing wins', () => {
  const err = new AdapterConfigError('adapter_config: near credentials missing (RAIL=near)', {
    missing: ['NEAR_ACCOUNT_ID', 'NEAR_PRIVATE_KEY', 'not an env name'],
  });
  assert.deepEqual(missingEnvNames(err, {}, 'near'), ['NEAR_ACCOUNT_ID', 'NEAR_PRIVATE_KEY']);
  const wrapped = new AdapterConfigError('adapter_config: failed', { cause: { names: ['PAYPAL_CLIENT_ID'] } });
  assert.deepEqual(missingEnvNames(wrapped, {}, 'paypal-orders'), ['PAYPAL_CLIENT_ID']);
  assert.deepEqual(formatStartupError(err, {}, 'near').slice(0, 2), [
    'agent-pay api failed to start: adapter_config: near credentials missing (RAIL=near)',
    'missing required env vars for RAIL=near: NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY',
  ]);
});

test('missingEnvNames: falls back to blank env names mentioned in a "required" message', () => {
  const err = new AdapterConfigError('adapter_config: NEAR_ACCOUNT_ID environment variable is required (RAIL=near)');
  // Without a `missing` list: the rail's REQUIRED_ENV that are blank, else env names quoted in the message.
  assert.deepEqual(missingEnvNames(err, {}, 'near'), ['NEAR_ACCOUNT_ID', 'NEAR_PRIVATE_KEY']);
  assert.deepEqual(missingEnvNames(err, { NEAR_ACCOUNT_ID: 'alice.testnet' }, 'near'), ['NEAR_PRIVATE_KEY']);
  assert.deepEqual(missingEnvNames(err, {}), ['NEAR_ACCOUNT_ID']);
  assert.deepEqual(missingEnvNames(err, { NEAR_ACCOUNT_ID: 'alice.testnet' }), []);
  // Invalid (not missing) value with the required names set: nothing to list.
  const nearSet = { NEAR_ACCOUNT_ID: 'alice.testnet', NEAR_PRIVATE_KEY: FAKE.near };
  assert.deepEqual(missingEnvNames(new Error('NEAR_NETWORK must be testnet or mainnet'), nearSet, 'near'), []);
  assert.deepEqual(missingEnvNames(new Error('NEAR_NETWORK must be testnet or mainnet'), {}), []);
});

test('redactEnvValues scrubs credential-like env values from messages', () => {
  const env = { PAYPAL_CLIENT_SECRET: FAKE.secret, NEAR_PRIVATE_KEY: FAKE.near, RAIL: 'paypal' };
  const out = redactEnvValues(`bad secret ${FAKE.secret} and key ${FAKE.near} on paypal`, env);
  assert.equal(out, 'bad secret [redacted] and key [redacted] on paypal');
  const lines = formatStartupError(new Error(`token ${FAKE.secret} rejected`), env, 'paypal').join('\n');
  assert.ok(!lines.includes(FAKE.secret));
});
