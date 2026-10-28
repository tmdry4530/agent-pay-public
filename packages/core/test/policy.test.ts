import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, reasonCode, type PaymentIntent, type Policy } from '../src/index.ts';

const policy: Policy = {
  agentId: 'agent-1',
  perTxMax: 100,
  dailyMax: 250,
  allowedPayees: ['openai-api', 'gpu-cloud'],
  requireApprovalAbove: 50,
  currency: 'USD',
};

const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: 'pi-1',
  agentId: 'agent-1',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  createdAt: '2026-10-28T10:00:00.000Z',
  ...over,
});

const code = (p: Policy, i: PaymentIntent, dailyTotal = 0) => {
  const d = evaluate(p, i, { dailyTotal });
  return [d.status, reasonCode(d)] as const;
};

test('approved within policy', () => {
  const d = evaluate(policy, intent(), { dailyTotal: 0 });
  assert.equal(d.status, 'approved');
  assert.match(d.reason, /^within_policy: /);
});

test('rejects agentId mismatch', () => {
  assert.deepEqual(code(policy, intent({ agentId: 'agent-2' })), ['rejected', 'agent_mismatch']);
});

test('rejects currency mismatch; matches case-insensitively; defaults to USD', () => {
  assert.deepEqual(code(policy, intent({ currency: 'EUR' })), ['rejected', 'currency_mismatch']);
  assert.deepEqual(code(policy, intent({ currency: 'usd' })), ['approved', 'within_policy']);
  const { currency: _omit, ...noCurrency } = policy;
  assert.deepEqual(code(noCurrency, intent()), ['approved', 'within_policy']);
  assert.deepEqual(code(noCurrency, intent({ currency: 'NEAR' })), ['rejected', 'currency_mismatch']);
  assert.deepEqual(code({ ...policy, currency: 'NEAR' }, intent({ currency: 'NEAR' })), ['approved', 'within_policy']);
});

test('rejects non-positive or non-finite amounts', () => {
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(code(policy, intent({ amount })), ['rejected', 'invalid_amount'], `amount ${amount}`);
  }
});

test('rejects payee not in allowed list (exact match)', () => {
  assert.deepEqual(code(policy, intent({ payee: 'evil-corp' })), ['rejected', 'payee_not_allowed']);
  assert.deepEqual(code(policy, intent({ payee: 'OPENAI-API' })), ['rejected', 'payee_not_allowed']);
  assert.deepEqual(code({ ...policy, allowedPayees: [] }, intent()), ['rejected', 'payee_not_allowed']);
});

test('per-tx max: above rejects, equal passes the per-tx check', () => {
  assert.deepEqual(code(policy, intent({ amount: 100.01 })), ['rejected', 'per_tx_limit_exceeded']);
  assert.deepEqual(code(policy, intent({ amount: 100 })), ['needs_approval', 'approval_required']);
});

test('daily max: total + amount above rejects, exactly equal is allowed', () => {
  assert.deepEqual(code(policy, intent({ amount: 10 }), 241), ['rejected', 'daily_limit_exceeded']);
  assert.deepEqual(code(policy, intent({ amount: 10 }), 240), ['approved', 'within_policy']);
  const d = evaluate(policy, intent({ amount: 10 }), { dailyTotal: 241 });
  assert.match(d.reason, /241 \+ 10 = 251 exceeds daily max 250/);
});

test('needs_approval above threshold; equal to threshold is approved', () => {
  assert.deepEqual(code(policy, intent({ amount: 50.5 })), ['needs_approval', 'approval_required']);
  assert.deepEqual(code(policy, intent({ amount: 50 })), ['approved', 'within_policy']);
});

test('check order: first failing rule wins', () => {
  // agent mismatch beats everything else
  assert.equal(code(policy, intent({ agentId: 'x', currency: 'EUR', amount: -1, payee: 'nope' }))[1], 'agent_mismatch');
  // invalid amount beats payee check
  assert.equal(code(policy, intent({ amount: 0, payee: 'nope' }))[1], 'invalid_amount');
  // per-tx beats daily
  assert.equal(code(policy, intent({ amount: 200 }), 249)[1], 'per_tx_limit_exceeded');
  // daily beats needs_approval
  assert.equal(code(policy, intent({ amount: 60 }), 200)[1], 'daily_limit_exceeded');
});

test('evaluate is pure: inputs not mutated, same output for same input', () => {
  const p = structuredClone(policy);
  const i = intent();
  const s = { dailyTotal: 5 };
  const snap = structuredClone({ p, i, s });
  const a = evaluate(p, i, s);
  const b = evaluate(p, i, s);
  assert.deepEqual(a, b);
  assert.deepEqual({ p, i, s }, snap);
});
