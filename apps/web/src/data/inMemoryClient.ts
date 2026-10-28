import type {
  Decision,
  LedgerEvent,
  PaymentIntent,
  Policy,
  Rail,
  Receipt,
  AgentTask,
} from '../types';
import { createPolicyEngine } from './policyEngine';
import { createMockRails } from './rails/mockRail';
import type { PaymentRail } from './rails/types';

export interface SpendSnapshot {
  spentToday: number;
  dailyLimit: number;
  perTxCap: number;
  currency: string;
}

export interface AgentPayClient {
  createIntent(task: AgentTask): PaymentIntent;
  evaluate(intentId: string): Decision;
  approve(intentId: string): void;
  deny(intentId: string): void;
  pay(intentId: string, rail: Rail): Promise<Receipt>;
  getLedger(): LedgerEvent[];
  getSpend(): SpendSnapshot;
  reset(): void;
  getIntent(intentId: string): PaymentIntent | undefined;
  getDecision(intentId: string): Decision | undefined;
  getHumanOutcome(intentId: string): 'approved' | 'denied' | undefined;
  getPolicy(): Policy;
}

export type InMemoryClientOptions = {
  policy?: Partial<Policy>;
  idGen?: () => string;
  clock?: () => string;
  rails?: PaymentRail[];
};

const DEFAULT_POLICY: Policy = {
  agentId: 'agent-demo-001',
  dailyLimit: 500,
  perTxCap: 200,
  autoApproveBelow: 50,
  allowedPayees: [
    'openai.example',
    'gpu-cloud.example',
    'data-market.example',
  ],
  currency: 'USD',
};

export function createInMemoryClient(
  opts: InMemoryClientOptions = {},
): AgentPayClient {
  const idGen = opts.idGen ?? (() => crypto.randomUUID());
  const clock = opts.clock ?? (() => new Date().toISOString());
  const policy: Policy = { ...DEFAULT_POLICY, ...opts.policy };
  const policyEngine = createPolicyEngine(policy);
  const rails = opts.rails ?? createMockRails({ clock, idGen });
  const railMap = new Map(rails.map((r) => [r.id, r]));

  const intents = new Map<string, PaymentIntent>();
  const decisions = new Map<string, Decision>();
  const humanOutcomes = new Map<string, 'approved' | 'denied'>();
  let ledger: LedgerEvent[] = [];
  let spentToday = 0;

  function pushEvent(
    partial: Omit<LedgerEvent, 'id' | 'at'> & { at?: string },
  ): LedgerEvent {
    const event: LedgerEvent = {
      id: idGen(),
      at: partial.at ?? clock(),
      type: partial.type,
      intentId: partial.intentId,
      amount: partial.amount,
      currency: partial.currency,
      rail: partial.rail,
      externalId: partial.externalId,
      decision: partial.decision,
      purpose: partial.purpose,
      payee: partial.payee,
    };
    ledger = [...ledger, event];
    return event;
  }

  function canPay(
    intentId: string,
  ): { ok: true } | { ok: false; reason: string } {
    const decision = decisions.get(intentId);
    if (!decision) {
      return { ok: false, reason: 'Policy check has not been run.' };
    }
    if (decision.status === 'rejected') {
      return { ok: false, reason: 'Payment rejected by policy.' };
    }
    if (decision.status === 'needs_approval') {
      const outcome = humanOutcomes.get(intentId);
      if (outcome === 'denied') {
        return { ok: false, reason: 'Payment denied by human reviewer.' };
      }
      if (outcome !== 'approved') {
        return { ok: false, reason: 'Human approval required before payment.' };
      }
    }
    return { ok: true };
  }

  return {
    createIntent(task: AgentTask): PaymentIntent {
      const intent: PaymentIntent = {
        id: idGen(),
        agentId: policy.agentId,
        payee: task.payee,
        amount: task.amount,
        currency: policy.currency,
        purpose: task.purpose,
        createdAt: clock(),
      };
      intents.set(intent.id, intent);
      pushEvent({
        type: 'intent_created',
        intentId: intent.id,
        amount: intent.amount,
        currency: intent.currency,
        purpose: intent.purpose,
        payee: intent.payee,
      });
      return intent;
    },

    evaluate(intentId: string): Decision {
      const intent = intents.get(intentId);
      if (!intent) {
        throw new Error(`Unknown intent: ${intentId}`);
      }
      const decision = policyEngine.evaluate(intent, spentToday);
      decisions.set(intentId, decision);
      pushEvent({
        type: 'policy_decision',
        intentId,
        amount: intent.amount,
        currency: intent.currency,
        decision,
      });
      return decision;
    },

    approve(intentId: string): void {
      const decision = decisions.get(intentId);
      if (!decision || decision.status !== 'needs_approval') {
        throw new Error('Intent is not awaiting approval.');
      }
      if (humanOutcomes.get(intentId) === 'denied') {
        throw new Error('Cannot approve: payment was denied by human.');
      }
      humanOutcomes.set(intentId, 'approved');
      const intent = intents.get(intentId);
      pushEvent({
        type: 'human_approved',
        intentId,
        amount: intent?.amount,
        currency: intent?.currency,
      });
    },

    deny(intentId: string): void {
      const decision = decisions.get(intentId);
      if (!decision || decision.status !== 'needs_approval') {
        throw new Error('Intent is not awaiting approval.');
      }
      humanOutcomes.set(intentId, 'denied');
      const intent = intents.get(intentId);
      pushEvent({
        type: 'human_denied',
        intentId,
        amount: intent?.amount,
        currency: intent?.currency,
      });
    },

    async pay(intentId: string, rail: Rail): Promise<Receipt> {
      const intent = intents.get(intentId);
      if (!intent) {
        throw new Error(`Unknown intent: ${intentId}`);
      }
      const gate = canPay(intentId);
      if (!gate.ok) {
        throw new Error(gate.reason);
      }
      const paymentRail = railMap.get(rail);
      if (!paymentRail) {
        throw new Error(`Unknown rail: ${rail}`);
      }
      const receipt = await paymentRail.pay(intent);
      pushEvent({
        type: 'payment_settled',
        intentId,
        amount: intent.amount,
        currency: intent.currency,
        rail: receipt.rail,
        externalId: receipt.externalId,
      });
      pushEvent({
        type: 'receipt',
        intentId,
        amount: intent.amount,
        currency: intent.currency,
        rail: receipt.rail,
        externalId: receipt.externalId,
      });
      if (receipt.status === 'settled') {
        spentToday += intent.amount;
      }
      return receipt;
    },

    getLedger(): LedgerEvent[] {
      return [...ledger];
    },

    getSpend(): SpendSnapshot {
      return {
        spentToday,
        dailyLimit: policy.dailyLimit,
        perTxCap: policy.perTxCap,
        currency: policy.currency,
      };
    },

    reset(): void {
      intents.clear();
      decisions.clear();
      humanOutcomes.clear();
      ledger = [];
      spentToday = 0;
    },

    getIntent(intentId: string): PaymentIntent | undefined {
      return intents.get(intentId);
    },

    getDecision(intentId: string): Decision | undefined {
      return decisions.get(intentId);
    },

    getHumanOutcome(intentId: string): 'approved' | 'denied' | undefined {
      return humanOutcomes.get(intentId);
    },

    getPolicy(): Policy {
      return { ...policy };
    },
  };
}
