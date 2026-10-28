import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { DEFAULT_POLICY, createMockAdapter, createServer, railSeed, parseDemoPayees } from '../src/index.ts';
import { AdapterConfigError } from '../src/adapters.ts';

async function startServer(
  t: { after: (fn: () => Promise<void>) => void },
  rail: 'mock' | 'paypal' | 'near',
  env: Record<string, string | undefined> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-seed-'));
  const seed = railSeed(rail, env);
  const adapter =
    rail === 'mock'
      ? createMockAdapter()
      : rail === 'paypal'
        ? { rail: 'paypal' as const, pay: async () => ({ intentId: 'x', rail: 'paypal' as const, externalId: '', status: 'failed' as const, at: '' }) }
        : { rail: 'near' as const, pay: async () => ({ intentId: 'x', rail: 'near' as const, externalId: '', status: 'failed' as const, at: '' }) };
  const server: Server = createServer({
    ledger: join(dir, 'ledger.json'),
    adapter,
    policy: seed.policy,
    demo: { currency: seed.currency, amountScale: seed.amountScale, payees: seed.payees },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return { base, seed };
}

test('mock seed matches DEFAULT_POLICY and identity payees', () => {
  const seed = railSeed('mock');
  assert.equal(seed.rail, 'mock');
  assert.equal(seed.currency, 'USD');
  assert.equal(seed.amountScale, 1);
  assert.deepEqual(seed.policy, DEFAULT_POLICY);
  assert.equal(seed.payees['openai-api'], 'openai-api');
});

test('paypal seed defaults', () => {
  const seed = railSeed('paypal');
  assert.equal(seed.currency, 'USD');
  assert.equal(seed.amountScale, 1);
  assert.equal(seed.policy.perTxMax, 100);
  assert.equal(seed.policy.currency, 'USD');
  assert.ok(seed.policy.allowedPayees.every((p) => p.includes('@')));
  assert.equal(seed.payees['openai-api'], 'merchant@example.com');
});

test('near seed defaults on testnet', () => {
  const seed = railSeed('near');
  assert.equal(seed.currency, 'NEAR');
  assert.equal(seed.amountScale, 0.01);
  assert.equal(seed.policy.perTxMax, 1);
  assert.equal(seed.policy.requireApprovalAbove, 0.5);
  assert.equal(seed.payees.vercel, 'demo-merchant.testnet');
  assert.deepEqual(seed.policy.allowedPayees, ['demo-merchant.testnet']);
});

test('near mainnet with default .testnet payee throws', () => {
  assert.throws(
    () => railSeed('near', { NEAR_NETWORK: 'mainnet' }),
    (err: unknown) => err instanceof AdapterConfigError && /demo_payees:.*\(RAIL=near\)/.test(err.message),
  );
});

test('DEMO_PAYEES override for paypal', () => {
  const seed = railSeed('paypal', { DEMO_PAYEES: 'openai-api=me@example.com,vercel=ops@example.com' });
  assert.equal(seed.payees['openai-api'], 'me@example.com');
  assert.equal(seed.payees.vercel, 'ops@example.com');
  assert.deepEqual(seed.policy.allowedPayees, ['me@example.com', 'ops@example.com']);
});

test('DEMO_PAYEES accepts 64-hex implicit NEAR account', () => {
  const implicit = 'b'.repeat(64);
  const seed = railSeed('near', { DEMO_PAYEES: `openai-api=${implicit}` });
  assert.equal(seed.payees['openai-api'], implicit);
  assert.deepEqual(seed.policy.allowedPayees, [implicit]);
});

test('DEMO_PAYEES parse errors', () => {
  assert.throws(
    () => railSeed('paypal', { DEMO_PAYEES: 'noequals' }),
    /demo_payees:.*\(RAIL=paypal\)/,
  );
  assert.throws(
    () => railSeed('paypal', { DEMO_PAYEES: '=bad@example.com' }),
    /demo_payees:.*\(RAIL=paypal\)/,
  );
  assert.throws(
    () => railSeed('paypal', { DEMO_PAYEES: 'openai-api=not-an-email' }),
    /demo_payees:.*\(RAIL=paypal\)/,
  );
  assert.throws(
    () => railSeed('paypal', { DEMO_PAYEES: 'openai-api=a@b.com,openai-api=b@c.com' }),
    /duplicate logical payee/,
  );
});

test('parseDemoPayees trims whitespace', () => {
  assert.deepEqual(parseDemoPayees(' openai-api = me@example.com '), { 'openai-api': 'me@example.com' });
});

test('GET /rail and GET /policy reflect seed', async (t) => {
  const { base, seed } = await startServer(t, 'paypal');
  const railRes = await fetch(`${base}/rail`);
  assert.equal(railRes.status, 200);
  const railBody = (await railRes.json()) as { currency: string; amountScale: number; payees: Record<string, string> };
  assert.equal(railBody.currency, seed.currency);
  assert.equal(railBody.amountScale, seed.amountScale);
  assert.deepEqual(railBody.payees, seed.payees);

  const policyRes = await fetch(`${base}/policy`);
  assert.equal(policyRes.status, 200);
  assert.deepEqual(await policyRes.json(), seed.policy);
});
