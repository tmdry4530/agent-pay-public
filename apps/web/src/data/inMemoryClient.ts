import type { Ledger } from '@agent-pay/core';
import type { PaymentIntent, Policy, Rail } from '@agent-pay/core';
import { approve, reject, runPayment } from '@agent-pay/core/orchestrator.ts';
import type { AgentPayClient, IntentDraft, LedgerSnapshot } from './agentPayClient';
import { countsTowardDailyTotal, MemoryLedger, utcDay } from './memoryLedger';
import { createMockAdapters } from './rails/mockAdapters';

/** Demo policy aligned with the reference API DEFAULT_POLICY. */
export const DEMO_POLICY: Policy = {
  agentId: 'demo-agent',
  perTxMax: 100,
  dailyMax: 200,
  allowedPayees: ['openai-api', 'anthropic-api', 'vercel', 'near-compute'],
  requireApprovalAbove: 50,
  currency: 'USD',
};

export type InMemoryClientOptions = {
  policy?: Policy;
  now?: () => Date;
  newId?: () => string;
};

const DEFAULT_APPROVER = 'demo-operator';

export function createInMemoryClient(options: InMemoryClientOptions = {}): AgentPayClient {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const policy = options.policy ?? DEMO_POLICY;
  const ledger = new MemoryLedger({ now });
  const adapters = createMockAdapters({ now, newId });
  const railsByIntent = new Map<string, Rail>();

  const asCoreLedger = ledger as unknown as Ledger;

  function buildIntent(draft: IntentDraft): PaymentIntent {
    return {
      id: draft.id ?? newId(),
      createdAt: draft.createdAt ?? now().toISOString(),
      agentId: draft.agentId,
      payee: draft.payee,
      amount: draft.amount,
      currency: draft.currency,
      purpose: draft.purpose,
    };
  }

  async function ledgerSnapshot(): Promise<LedgerSnapshot> {
    const entries = await ledger.list();
    const day = utcDay(now());
    const totals: Record<string, number> = {};
    for (const e of entries) {
      if (utcDay(e.intent.createdAt) === day && countsTowardDailyTotal(e)) {
        totals[e.intent.agentId] = (totals[e.intent.agentId] ?? 0) + e.intent.amount;
      }
    }
    return { entries, today: { day, totals } };
  }

  return {
    kind: 'mock',

    async getPolicy() {
      return structuredClone(policy);
    },

    async submitIntent(draft: IntentDraft, rail: Rail) {
      const intent = buildIntent(draft);
      railsByIntent.set(intent.id, rail);
      const result = await runPayment(intent, policy, asCoreLedger, adapters[rail]);
      return { ...result, intent };
    },

    async approve(intentId: string, approver = DEFAULT_APPROVER) {
      const rail = railsByIntent.get(intentId) ?? 'mock';
      return approve(intentId, {
        policy,
        ledger: asCoreLedger,
        adapter: adapters[rail],
        approver,
      });
    },

    async reject(intentId: string, opts = {}) {
      return reject(intentId, {
        ledger: asCoreLedger,
        approver: opts.approver ?? DEFAULT_APPROVER,
        note: opts.note,
      });
    },

    async getLedger() {
      return ledgerSnapshot();
    },

    async reset() {
      ledger.clear();
      railsByIntent.clear();
    },
  };
}
