import type { Ledger, PaymentAdapter, Receipt } from '@agent-pay/core';
import type { PaymentIntent, Policy, Rail } from '@agent-pay/core';
import { approve, reject, runPayment } from '@agent-pay/core/orchestrator.ts';
import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import type { AgentPayClient, IntentDraft, LedgerSnapshot } from './agentPayClient';
import { ApiError } from './apiError';
import { countsTowardDailyTotal, MemoryLedger, MemoryLedgerError, utcDay } from './memoryLedger';
import { refreshIntent } from './refreshIntent';
import { createMockAdapters, type PendingSettlementConfig } from './rails/mockAdapters';

/** Demo policy aligned with the reference API DEFAULT_POLICY. */
export const DEMO_POLICY: Policy = {
  agentId: 'demo-agent',
  perTxMax: 100,
  dailyMax: 200,
  allowedPayees: ['openai-api', 'anthropic-api', 'vercel', 'near-compute'],
  requireApprovalAbove: 50,
  currency: 'USD',
};

export type PayOutcome = 'normal' | 'throw' | 'timeout';

export type InMemoryClientOptions = {
  policy?: Policy;
  now?: () => Date;
  newId?: () => string;
  pendingSettlement?: PendingSettlementConfig;
  /** Delay before adapter pay completes (exercises submitting in ledger). */
  payDelayMs?: number;
  /** Simulated pay() outcome for manual-resolve demos. */
  payOutcome?: PayOutcome;
  /** Short-circuit submit with invalid_policy rejection (no pay). */
  invalidPolicy?: boolean;
};

const DEFAULT_APPROVER = 'demo-operator';

type ReceiptWithMeta = Receipt & { meta?: Record<string, string> };

function mapApproveRejectError(err: unknown, intentId: string): never {
  if (err instanceof PaymentError) {
    if (err.code === 'not_pending' || err.code === 'already_paid') {
      throw new ApiError(409, `${err.code}: intent ${intentId} was already processed`);
    }
    throw err;
  }
  if (err instanceof MemoryLedgerError && /expected needs_approval/.test(err.message)) {
    throw new ApiError(409, `not_pending: intent ${intentId} was already processed`);
  }
  throw err;
}

function wrapAdapter(
  rail: Rail,
  inner: PaymentAdapter,
  ledger: MemoryLedger,
  opts: { payDelayMs: number; payOutcome: PayOutcome; now: () => Date },
): PaymentAdapter {
  const { payDelayMs, payOutcome, now } = opts;

  const pay = async (intent: PaymentIntent): Promise<Receipt> => {
    await ledger.markSubmitting(intent.id);
    if (payDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, payDelayMs);
      });
    }

    if (payOutcome === 'throw') {
      const receipt: ReceiptWithMeta = {
        intentId: intent.id,
        rail,
        externalId: '',
        status: 'pending',
        at: now().toISOString(),
        meta: {
          needsManualResolve: 'true',
          unknownOutcome: 'true',
          error: 'pay threw: simulated adapter error',
        },
      };
      return receipt;
    }

    if (payOutcome === 'timeout') {
      const receipt: ReceiptWithMeta = {
        intentId: intent.id,
        rail,
        externalId: '',
        status: 'pending',
        at: now().toISOString(),
        meta: {
          needsManualResolve: 'true',
          unknownOutcome: 'true',
          error: `pay timed out after ${payDelayMs}ms`,
        },
      };
      return receipt;
    }

    return inner.pay(intent);
  };

  return {
    rail: inner.rail,
    pay,
    status: inner.status,
  };
}

export function createInMemoryClient(options: InMemoryClientOptions = {}): AgentPayClient {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const policy = options.policy ?? DEMO_POLICY;
  const payDelayMs = options.payDelayMs ?? 0;
  const payOutcome = options.payOutcome ?? 'normal';
  const invalidPolicy = options.invalidPolicy ?? false;
  const ledger = new MemoryLedger({ now });
  const baseAdapters = createMockAdapters({
    now,
    newId,
    pendingSettlement: options.pendingSettlement,
  });
  const adapters: Record<Rail, PaymentAdapter> = {
    mock: wrapAdapter('mock', baseAdapters.mock, ledger, { payDelayMs, payOutcome, now }),
    paypal: wrapAdapter('paypal', baseAdapters.paypal, ledger, { payDelayMs, payOutcome, now }),
    near: wrapAdapter('near', baseAdapters.near, ledger, { payDelayMs, payOutcome, now }),
  };
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
    const totals: Record<string, Record<string, number>> = {};
    for (const e of entries) {
      if (utcDay(e.intent.createdAt) === day && countsTowardDailyTotal(e)) {
        const agent = e.intent.agentId;
        const cur = String(e.intent.currency).toUpperCase();
        if (!totals[agent]) totals[agent] = {};
        totals[agent][cur] = (totals[agent][cur] ?? 0) + e.intent.amount;
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

      if (invalidPolicy) {
        const reason = 'invalid_policy: policy.perTxMax is not a finite number';
        await ledger.recordIntent(intent);
        const decision = { status: 'rejected' as const, reason };
        await ledger.recordDecision(intent.id, decision, { actor: 'policy' });
        return { intentId: intent.id, status: 'rejected', decision, intent };
      }

      const result = await runPayment(intent, policy, asCoreLedger, adapters[rail]);
      return { ...result, intent };
    },

    async approve(intentId: string, approver = DEFAULT_APPROVER) {
      const rail = railsByIntent.get(intentId) ?? 'mock';
      try {
        return await approve(intentId, {
          policy,
          ledger: asCoreLedger,
          adapter: adapters[rail],
          approver,
        });
      } catch (err) {
        mapApproveRejectError(err, intentId);
      }
    },

    async reject(intentId: string, opts = {}) {
      try {
        return await reject(intentId, {
          ledger: asCoreLedger,
          approver: opts.approver ?? DEFAULT_APPROVER,
          note: opts.note,
        });
      } catch (err) {
        mapApproveRejectError(err, intentId);
      }
    },

    async refresh(intentId: string) {
      const rail = railsByIntent.get(intentId) ?? 'mock';
      return refreshIntent(intentId, ledger, adapters[rail]);
    },

    async getLedger() {
      return ledgerSnapshot();
    },

    async getHealth() {
      return { ok: true, rail: 'mock' };
    },

    async reset() {
      ledger.clear();
      railsByIntent.clear();
    },
  };
}
