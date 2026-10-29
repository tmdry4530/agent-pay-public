import type { Ledger, PaymentAdapter, Receipt } from '@agent-pay/core';
import type { PaymentIntent, Policy, Rail } from '@agent-pay/core';
import { approve, reject, runPayment } from '@agent-pay/core/orchestrator.ts';
import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import { LedgerError } from '@agent-pay/core/errors.ts';
import type { AgentPayClient, IntentDraft, LedgerSnapshot } from './agentPayClient';
import { ApiError } from './apiError';
import { MemoryLedger, utcDay } from './memoryLedger';
import { resolveIntentMemory } from './memoryResolve';
import type { ResolveRequest } from './compat';
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

export type PayOutcome = 'normal' | 'throw' | 'timeout' | 'mismatch' | 'hang';

export type InMemoryClientOptions = {
  policy?: Policy;
  now?: () => Date;
  newId?: () => string;
  pendingSettlement?: PendingSettlementConfig;
  /** Delay before adapter pay completes (entry stays submitting meanwhile). */
  payDelayMs?: number;
  /** Simulated pay() outcome for manual-resolve demos. */
  payOutcome?: PayOutcome;
  /** Short-circuit with invalid_policy via core evaluate (perTxMax NaN). */
  invalidPolicy?: boolean;
  /** Timeout for adapter.pay when using runPayment/approve (default 1500ms when payOutcome is timeout). */
  payTimeoutMs?: number;
};

const DEFAULT_APPROVER = 'demo-operator';
const DEFAULT_SIM_TIMEOUT_MS = 1500;

function mapApproveRejectError(err: unknown, intentId: string): never {
  if (err instanceof PaymentError) {
    if (err.code === 'not_pending' || err.code === 'already_paid') {
      throw new ApiError(409, `${err.code}: intent ${intentId} was already processed`);
    }
    throw err;
  }
  if (err instanceof LedgerError && err.code === 'precondition_failed' && /expected needs_approval/.test(err.message)) {
    throw new ApiError(409, `not_pending: intent ${intentId} was already processed`);
  }
  throw err;
}

function wrapAdapterPay(
  inner: PaymentAdapter,
  opts: { payDelayMs: number; payOutcome: PayOutcome },
): PaymentAdapter {
  const { payDelayMs, payOutcome } = opts;

  const pay = async (intent: PaymentIntent): Promise<Receipt> => {
    if (payDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, payDelayMs);
      });
    }

    if (payOutcome === 'throw') {
      throw new Error('mock rail unreachable');
    }

    if (payOutcome === 'timeout' || payOutcome === 'hang') {
      return new Promise<Receipt>(() => {
        /* never resolves — orchestrator payTimeoutMs fires (unless disabled for hang) */
      });
    }

    if (payOutcome === 'mismatch') {
      const receipt = await inner.pay(intent);
      return { ...receipt, intentId: `${intent.id}-wrong` };
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
  const basePolicy = options.policy ?? DEMO_POLICY;
  const invalidPolicy = options.invalidPolicy ?? false;
  const policy: Policy = invalidPolicy ? { ...basePolicy, perTxMax: Number.NaN } : basePolicy;
  const payDelayMs = options.payDelayMs ?? 0;
  const payOutcome = options.payOutcome ?? 'normal';
  const payTimeoutMs =
    options.payTimeoutMs ??
    (payOutcome === 'timeout'
      ? DEFAULT_SIM_TIMEOUT_MS
      : payOutcome === 'hang'
        ? Number.POSITIVE_INFINITY
        : undefined);
  const paymentOptions = payTimeoutMs !== undefined ? { payTimeoutMs } : {};

  const ledger = new MemoryLedger({ now });
  const baseAdapters = createMockAdapters({
    now,
    newId,
    pendingSettlement: options.pendingSettlement,
  });
  const wrapOpts = { payDelayMs, payOutcome };
  const adapters: Record<Rail, PaymentAdapter> = {
    mock: wrapAdapterPay(baseAdapters.mock, wrapOpts),
    paypal: wrapAdapterPay(baseAdapters.paypal, wrapOpts),
    near: wrapAdapterPay(baseAdapters.near, wrapOpts),
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
    const agentIds = [...new Set(entries.map((e) => e.intent.agentId))];
    const totals: Record<string, Record<string, number>> = {};
    for (const agentId of agentIds) {
      totals[agentId] = await ledger.dailyTotals(agentId, day);
    }
    return { entries, today: { day, totals } };
  }

  return {
    kind: 'mock',

    async getPolicy() {
      return structuredClone(basePolicy);
    },

    async submitIntent(draft: IntentDraft, rail: Rail) {
      const intent = buildIntent(draft);
      railsByIntent.set(intent.id, rail);
      const result = await runPayment(intent, policy, asCoreLedger, adapters[rail], paymentOptions);
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
          ...paymentOptions,
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

    async resolve(intentId: string, req: ResolveRequest) {
      return resolveIntentMemory(
        intentId,
        asCoreLedger,
        {
          status: req.status,
          note: req.note,
          resolvedBy: req.resolvedBy,
          ...(req.externalId !== undefined ? { externalId: req.externalId } : {}),
        },
        now,
      );
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
