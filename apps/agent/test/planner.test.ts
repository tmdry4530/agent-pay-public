import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlannerError, RuleBasedPlanner, createPlanner, parseQuantity } from '../src/planner.ts';
import { SCENARIOS } from '../src/scenarios.ts';

const planner = new RuleBasedPlanner();
const ctx = { agentId: 'demo-agent' };

test('GPT tokens → openai-api at 10 USD per 1M', async () => {
  const q = await planner.plan('buy 1M tokens of GPT inference', ctx);
  assert.equal(q.payee, 'openai-api');
  assert.equal(q.amount, 10);
  assert.equal(q.currency, 'USD');
  assert.match(q.purpose, /buy 1M tokens of GPT inference/);
});

test('vendor keyword wins over the generic "tokens" rule', async () => {
  const q = await planner.plan('purchase 2.5M Claude tokens', ctx);
  assert.equal(q.payee, 'anthropic-api');
  assert.equal(q.amount, 25);
});

test('generic inference without a vendor defaults to openai-api', async () => {
  const q = await planner.plan('need 500k tokens of inference', ctx);
  assert.equal(q.payee, 'openai-api');
  assert.equal(q.amount, 5);
});

test('vercel deploys and near GPU hours', async () => {
  assert.deepEqual(
    { ...(await planner.plan('pay for 2 deploys on Vercel', ctx)), purpose: '' },
    { payee: 'vercel', amount: 40, currency: 'USD', purpose: '' },
  );
  const gpu = await planner.plan('rent a GPU on NEAR for 3 hours', ctx);
  assert.equal(gpu.payee, 'near-compute');
  assert.equal(gpu.amount, 15);
});

test('keywords match whole words only', async () => {
  await assert.rejects(() => planner.plan('linear algebra homework', ctx), PlannerError);
});

test('parseQuantity', () => {
  assert.equal(parseQuantity('1M tokens', 'token'), 1);
  assert.equal(parseQuantity('2.5M of gpt', 'token'), 2.5);
  assert.equal(parseQuantity('500k tokens', 'token'), 0.5);
  assert.equal(parseQuantity('200000 tokens', 'token'), 0.2);
  assert.equal(parseQuantity('some tokens', 'token'), 1);
  assert.equal(parseQuantity('3 hours', 'hour'), 3);
  assert.equal(parseQuantity('1.5h', 'hour'), 1.5);
  assert.equal(parseQuantity('2 deploys', 'deploy'), 2);
});

test('currency comes from the context', async () => {
  const q = await planner.plan('buy 1M tokens of GPT', { agentId: 'a', currency: 'EUR' });
  assert.equal(q.currency, 'EUR');
});

test('empty and unknown tasks throw PlannerError', async () => {
  await assert.rejects(() => planner.plan('   ', ctx), PlannerError);
  await assert.rejects(() => planner.plan('send flowers to mom', ctx), /no_match/);
});

test('built-in scenarios plan to 10 / 150 / 75 USD to openai-api', async () => {
  const amounts: Record<string, number> = {};
  for (const [name, s] of Object.entries(SCENARIOS)) {
    const q = await planner.plan(s.task, ctx);
    assert.equal(q.payee, 'openai-api');
    amounts[name] = q.amount;
  }
  assert.deepEqual(amounts, { small: 10, 'over-limit': 150, 'needs-approval': 75 });
});

test('createPlanner: rule is RuleBasedPlanner, llm picks a provider by key, anything else throws', () => {
  assert.ok(createPlanner('rule') instanceof RuleBasedPlanner);
  assert.equal(createPlanner('llm', { env: {} }).name, 'llm');
  assert.equal(createPlanner('llm', { env: { OPENROUTER_API_KEY: 'x' } }).name, 'openrouter');
  assert.equal(createPlanner('llm', { env: { OPENAI_API_KEY: 'x', OPENROUTER_API_KEY: 'y' } }).name, 'openai');
  assert.throws(() => createPlanner('other' as 'rule'), /unknown_planner/);
});
