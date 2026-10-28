import { describe, expect, it } from 'vitest';
import { createPolicyEngine } from '../policyEngine';
import type { PaymentIntent, Policy } from '../../types';

const basePolicy: Policy = {
  agentId: 'agent-test',
  dailyLimit: 500,
  perTxCap: 200,
  autoApproveBelow: 50,
  allowedPayees: ['openai.example', 'data-market.example'],
  currency: 'USD',
};

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'intent-1',
    agentId: 'agent-test',
    payee: 'openai.example',
    amount: 12,
    currency: 'USD',
    purpose: 'Test',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  it('approves small allowed transactions', () => {
    const engine = createPolicyEngine(basePolicy);
    const decision = engine.evaluate(intent({ amount: 12 }), 0);
    expect(decision.status).toBe('approved');
  });

  it('rejects over per-tx cap', () => {
    const engine = createPolicyEngine(basePolicy);
    const decision = engine.evaluate(
      intent({ payee: 'openai.example', amount: 480 }),
      0,
    );
    expect(decision.status).toBe('rejected');
    expect(decision.reason).toMatch(/per-transaction cap/i);
  });

  it('rejects when daily limit would be exceeded', () => {
    const engine = createPolicyEngine(basePolicy);
    const decision = engine.evaluate(intent({ amount: 100 }), 450);
    expect(decision.status).toBe('rejected');
    expect(decision.reason).toMatch(/daily limit/i);
  });

  it('rejects disallowed payee', () => {
    const engine = createPolicyEngine(basePolicy);
    const decision = engine.evaluate(
      intent({ payee: 'unknown.vendor', amount: 10 }),
      0,
    );
    expect(decision.status).toBe('rejected');
    expect(decision.reason).toMatch(/allowed list/i);
  });

  it('needs human approval above auto-approve threshold', () => {
    const engine = createPolicyEngine(basePolicy);
    const decision = engine.evaluate(
      intent({ payee: 'data-market.example', amount: 75 }),
      0,
    );
    expect(decision.status).toBe('needs_approval');
  });
});
