import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { DEFAULT_POLICY, createMockAdapter, createServer, railSeed } from '../src/index.ts';
import { AdapterConfigError } from '../src/adapters.ts';

test('DEMO_APPROVAL_ABOVE unset/empty: default thresholds unchanged (50 USD, 0.5 NEAR)', () => {
  assert.equal(DEFAULT_POLICY.requireApprovalAbove, 50);
  for (const env of [{}, { DEMO_APPROVAL_ABOVE: '' }, { DEMO_APPROVAL_ABOVE: '  ' }]) {
    assert.equal(railSeed('mock', env).policy.requireApprovalAbove, 50);
    assert.equal(railSeed('paypal', env).policy.requireApprovalAbove, 50);
    assert.equal(railSeed('near', env).policy.requireApprovalAbove, 0.5);
  }
});

test('DEMO_APPROVAL_ABOVE lowers only requireApprovalAbove, per rail currency', () => {
  const mock = railSeed('mock', { DEMO_APPROVAL_ABOVE: '5' }).policy;
  assert.deepEqual(mock, { ...DEFAULT_POLICY, requireApprovalAbove: 5 });
  assert.equal(railSeed('paypal', { DEMO_APPROVAL_ABOVE: '0' }).policy.requireApprovalAbove, 0);
  const near = railSeed('near', { DEMO_APPROVAL_ABOVE: '0.05' }).policy;
  assert.equal(near.requireApprovalAbove, 0.05);
  assert.equal(near.perTxMax, 1);
  assert.equal(DEFAULT_POLICY.requireApprovalAbove, 50, 'shared default is not mutated');
});

test('DEMO_APPROVAL_ABOVE rejects non-numbers, negatives and values >= perTxMax', () => {
  for (const [rail, raw] of [['mock', 'abc'], ['mock', '-1'], ['mock', '100'], ['paypal', 'Infinity'], ['near', '1']] as const) {
    assert.throws(() => railSeed(rail, { DEMO_APPROVAL_ABOVE: raw }), (err: unknown) => {
      assert.ok(err instanceof AdapterConfigError);
      assert.match(err.message, /^invalid_demo_approval_above: /);
      return true;
    });
  }
});

test('with DEMO_APPROVAL_ABOVE=5 the 10 USD small scenario needs approval; default auto-approves it', async (t) => {
  const run = async (env: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-pay-demo-approval-'));
    const server: Server = createServer({ ledger: join(dir, 'ledger.json'), adapter: createMockAdapter(), policy: railSeed('mock', env).policy });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    });
    const res = await fetch(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'demo-agent', payee: 'openai-api', amount: 10, currency: 'USD', purpose: 'inference credits' }),
    });
    return ((await res.json()) as { status: string }).status;
  };
  assert.equal(await run({}), 'paid');
  assert.equal(await run({ DEMO_APPROVAL_ABOVE: '5' }), 'needs_approval');
});
