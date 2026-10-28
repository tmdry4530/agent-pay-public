import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIOS } from '../../types';
import { createInMemoryClient } from '../inMemoryClient';
import type { Rail } from '../../types';

describe('AgentPay flow', () => {
  const rails: Rail[] = ['mock', 'paypal', 'near'];

  it('runs approved scenario end-to-end and updates spend', async () => {
    const client = createInMemoryClient({
      idGen: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
      clock: () => '2026-01-01T12:00:00.000Z',
    });
    const task = DEMO_SCENARIOS[0].task;
    const intent = client.createIntent(task);
    const decision = client.evaluate(intent.id);
    expect(decision.status).toBe('approved');
    const receipt = await client.pay(intent.id, 'mock');
    expect(receipt.status).toBe('settled');
    expect(receipt.externalId).toMatch(/^MOCK-TX-/);
    expect(client.getSpend().spentToday).toBe(12);
  });

  it('rejects GPU scenario and blocks payment', async () => {
    const client = createInMemoryClient();
    const task = DEMO_SCENARIOS[1].task;
    const intent = client.createIntent(task);
    const decision = client.evaluate(intent.id);
    expect(decision.status).toBe('rejected');
    await expect(client.pay(intent.id, 'mock')).rejects.toThrow(/rejected by policy/i);
  });

  it('needs approval path: approve then pay', async () => {
    const client = createInMemoryClient();
    const task = DEMO_SCENARIOS[2].task;
    const intent = client.createIntent(task);
    expect(client.evaluate(intent.id).status).toBe('needs_approval');
    await expect(client.pay(intent.id, 'paypal')).rejects.toThrow(/approval required/i);
    client.approve(intent.id);
    const receipt = await client.pay(intent.id, 'paypal');
    expect(receipt.externalId).toMatch(/^MOCK-PAYPAL-ORDER-/);
    expect(client.getSpend().spentToday).toBe(75);
  });

  it('needs approval path: deny is terminal', async () => {
    const client = createInMemoryClient();
    const task = DEMO_SCENARIOS[2].task;
    const intent = client.createIntent(task);
    client.evaluate(intent.id);
    client.deny(intent.id);
    await expect(client.pay(intent.id, 'near')).rejects.toThrow(/denied by human/i);
  });

  it('each rail produces labelled mock externalId', async () => {
    for (const rail of rails) {
      const client = createInMemoryClient();
      const intent = client.createIntent(DEMO_SCENARIOS[0].task);
      client.evaluate(intent.id);
      const receipt = await client.pay(intent.id, rail);
      if (rail === 'mock') {
        expect(receipt.externalId).toMatch(/^MOCK-TX-/);
      } else if (rail === 'paypal') {
        expect(receipt.externalId).toMatch(/^MOCK-PAYPAL-ORDER-/);
      } else {
        expect(receipt.externalId).toMatch(/^mock-near-tx-/);
      }
    }
  });

  it('reset clears ledger and spend', async () => {
    const client = createInMemoryClient();
    const intent = client.createIntent(DEMO_SCENARIOS[0].task);
    client.evaluate(intent.id);
    await client.pay(intent.id, 'mock');
    expect(client.getLedger().length).toBeGreaterThan(0);
    expect(client.getSpend().spentToday).toBe(12);
    client.reset();
    expect(client.getLedger()).toHaveLength(0);
    expect(client.getSpend().spentToday).toBe(0);
  });
});
