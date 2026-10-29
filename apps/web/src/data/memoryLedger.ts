import { ceilMinorUnits, currencyDecimals } from '@agent-pay/core/money.ts';
import { LedgerError } from '@agent-pay/core/errors.ts';
import type {
  Decision,
  DecisionRecord,
  DecisionStatus,
  LedgerState,
  PaymentIntent,
  Receipt,
  ReceiptStatus,
} from '@agent-pay/core';
import type {
  LedgerEntry,
  PaymentOutcome,
  PaymentStatus,
  ReceiptResolution,
} from '@agent-pay/core';
import type { Rail } from '@agent-pay/core';

/** UTC calendar day "YYYY-MM-DD" of a Date or ISO string (mirrors packages/core/src/ledger.ts). */
export function utcDay(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) throw new LedgerError('invalid_input', `invalid date: ${String(date)}`);
  return d.toISOString().slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Currency key for per-currency totals (mirrors packages/core/src/ledger.ts). */
export function normalizeCurrency(currency: string): string {
  return String(currency).toUpperCase();
}

/**
 * UTC day an entry's spend is accounted to (mirrors packages/core/src/ledger.ts).
 */
export function accountingDay(entry: LedgerEntry): string {
  let approvedAt: string | undefined;
  for (const d of entry.decisions ?? []) if (d.status === 'approved' && d.at !== undefined) approvedAt = d.at;
  return utcDay(approvedAt ?? entry.recordedAt ?? entry.intent.createdAt);
}

/**
 * True when the entry counts toward the daily total (mirrors packages/core/src/ledger.ts).
 */
export function countsTowardDailyTotal(entry: LedgerEntry): boolean {
  if (entry.decision?.status !== 'approved') return false;
  if (entry.paymentStatus === 'failed') return false;
  if (entry.receipt?.status === 'failed') return false;
  return true;
}

/** @deprecated use LedgerError from @agent-pay/core/errors.ts */
export class MemoryLedgerError extends LedgerError {}

/**
 * Browser-safe in-memory ledger with the same public API semantics as core `Ledger`.
 */
export class MemoryLedger {
  readonly #now: () => Date;
  #entries: LedgerEntry[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async list(): Promise<LedgerEntry[]> {
    return this.#serialize(async () => structuredClone(this.#entries));
  }

  async get(intentId: string): Promise<LedgerEntry | undefined> {
    return this.#serialize(async () => {
      const entry = this.#entries.find((e) => e.intent.id === intentId);
      return entry ? structuredClone(entry) : undefined;
    });
  }

  recordIntent(intent: PaymentIntent): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      if (entries.some((e) => e.intent.id === intent.id)) {
        throw new LedgerError('duplicate_intent', `intent ${intent.id} already recorded`);
      }
      utcDay(intent.createdAt);
      const at = this.#now().toISOString();
      const entry: LedgerEntry = {
        intent: structuredClone(intent),
        decisions: [],
        recordedAt: at,
        updatedAt: at,
      };
      entries.push(entry);
      return entry;
    });
  }

  recordIntentAndDecide(
    intent: PaymentIntent,
    decide: (state: LedgerState) => { decision: Decision; actor?: string },
  ): Promise<{ entry: LedgerEntry; created: boolean }> {
    return this.#mutate((entries) => {
      const existing = entries.find((e) => e.intent.id === intent.id);
      if (existing) return { entry: existing, created: false };
      utcDay(intent.createdAt);
      const at = this.#now().toISOString();
      const entry: LedgerEntry = {
        intent: structuredClone(intent),
        decisions: [],
        recordedAt: at,
        updatedAt: at,
      };
      const { decision, actor } = decide(stateFor(entries, entry.intent, this.#now()));
      this.#applyDecision(entry, decision, actor);
      entries.push(entry);
      return { entry, created: true };
    });
  }

  recordDecision(
    intentId: string,
    decision: Decision,
    options: { ifStatus?: DecisionStatus; actor?: string } = {},
  ): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      assertDecidable(entry, options.ifStatus);
      this.#applyDecision(entry, decision, options.actor);
      return entry;
    });
  }

  decide(
    intentId: string,
    decide: (state: LedgerState, entry: LedgerEntry) => { decision: Decision; actor?: string },
    options: { ifStatus?: DecisionStatus } = {},
  ): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      assertDecidable(entry, options.ifStatus);
      const { decision, actor } = decide(stateFor(entries, entry.intent, this.#now()), structuredClone(entry));
      this.#applyDecision(entry, decision, actor);
      return entry;
    });
  }

  #applyDecision(entry: LedgerEntry, decision: Decision, actor: string | undefined): void {
    assertDecisionTransition(entry, decision.status);
    const at = this.#now().toISOString();
    entry.decision = { status: decision.status, reason: decision.reason };
    const record: DecisionRecord = { ...entry.decision, at };
    if (actor !== undefined) record.actor = actor;
    (entry.decisions ??= []).push(record);
    entry.updatedAt = at;
  }

  markSubmitting(intentId: string, rail: Rail): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      assertPayable(entry, 'submitting');
      const at = this.#now().toISOString();
      entry.paymentStatus = 'submitting';
      entry.submission = { rail, at };
      entry.updatedAt = at;
      return entry;
    });
  }

  recordPayment(intentId: string, status: PaymentStatus): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      assertPayable(entry, status);
      entry.paymentStatus = status;
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  recordPaymentResult(intentId: string, outcome: PaymentOutcome): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      if (entry.paymentStatus !== 'submitting') assertPayable(entry, outcome.status);
      if (outcome.status !== 'paid' && outcome.status !== 'failed') {
        throw new LedgerError(
          'invalid_input',
          `payment outcome must be paid or failed, got ${String(outcome.status)}`,
        );
      }
      entry.paymentStatus = outcome.status;
      if (outcome.receipt !== undefined) {
        if (outcome.receipt.intentId !== intentId) {
          throw new LedgerError(
            'invalid_input',
            `receipt intentId ${outcome.receipt.intentId} does not match ${intentId}`,
          );
        }
        assertReceiptTransition(entry, outcome.receipt.status);
        entry.receipt = { ...outcome.receipt };
        if (outcome.receipt.status === 'failed') entry.paymentStatus = 'failed';
      }
      if (outcome.needsManualResolve === true) entry.needsManualResolve = true;
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  recordReceipt(intentId: string, receipt: Receipt): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      if (receipt.intentId !== intentId) {
        throw new LedgerError('invalid_input', `receipt intentId ${receipt.intentId} does not match ${intentId}`);
      }
      if (entry.paymentStatus === undefined) {
        throw new LedgerError('precondition_failed', `intent ${intentId} has no payment recorded`);
      }
      if (entry.paymentStatus === 'submitting') {
        throw new LedgerError(
          'precondition_failed',
          `intent ${intentId} is submitting; use recordPaymentResult or settleReceipt`,
        );
      }
      assertReceiptTransition(entry, receipt.status);
      entry.receipt = { ...receipt };
      if (receipt.status === 'failed') entry.paymentStatus = 'failed';
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  settleReceipt(
    intentId: string,
    receipt: Receipt,
    resolution?: ReceiptResolution,
  ): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      if (receipt.intentId !== intentId) {
        throw new LedgerError('invalid_input', `receipt intentId ${receipt.intentId} does not match ${intentId}`);
      }
      const interrupted = entry.paymentStatus === 'submitting' && entry.receipt === undefined;
      if (!interrupted && entry.paymentStatus !== 'paid') {
        throw new LedgerError(
          'precondition_failed',
          `intent ${intentId} cannot settle receipt: payment status is ${entry.paymentStatus ?? 'missing'}`,
        );
      }
      if (interrupted && receipt.status === 'pending') {
        throw new LedgerError(
          'invalid_input',
          `intent ${intentId}: a submitting payment must settle to a final status`,
        );
      }
      if (!interrupted && entry.receipt?.status !== 'pending') {
        throw new LedgerError(
          'precondition_failed',
          `intent ${intentId} receipt is not pending (status is ${entry.receipt?.status ?? 'missing'})`,
        );
      }
      entry.receipt = { ...receipt };
      entry.paymentStatus = receipt.status === 'failed' ? 'failed' : 'paid';
      delete entry.needsManualResolve;
      if (resolution !== undefined) entry.resolution = { ...resolution };
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  async dailyTotal(agentId: string, day?: Date | string, currency?: string): Promise<number> {
    const totals = await this.dailyTotals(agentId, day);
    if (currency !== undefined) return totals[normalizeCurrency(currency)] ?? 0;
    return Object.values(totals).reduce((a, b) => a + b, 0);
  }

  async dailyTotals(agentId: string, day?: Date | string): Promise<Record<string, number>> {
    const target =
      day === undefined ? utcDay(this.#now()) : typeof day === 'string' && DAY_RE.test(day) ? day : utcDay(day);
    return this.#serialize(async () => {
      const totals: Record<string, number> = {};
      for (const e of this.#entries) {
        if (e.intent.agentId === agentId && countsTowardDailyTotal(e) && accountingDay(e) === target) {
          const c = normalizeCurrency(e.intent.currency);
          totals[c] = (totals[c] ?? 0) + e.intent.amount;
        }
      }
      return totals;
    });
  }

  async ledgerStateFor(intent: PaymentIntent): Promise<LedgerState> {
    return this.#serialize(async () => stateFor(this.#entries, intent, this.#now()));
  }

  clear(): void {
    this.#entries = [];
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #mutate<T>(fn: (entries: LedgerEntry[]) => T): Promise<T> {
    return this.#serialize(async () => {
      const result = fn(this.#entries);
      return structuredClone(result);
    });
  }
}

function assertDecidable(entry: LedgerEntry, ifStatus: DecisionStatus | undefined): void {
  const intentId = entry.intent.id;
  if (entry.paymentStatus !== undefined) {
    throw new LedgerError('precondition_failed', `intent ${intentId} already has a payment; decision is final`);
  }
  if (ifStatus !== undefined && entry.decision?.status !== ifStatus) {
    throw new LedgerError(
      'precondition_failed',
      `intent ${intentId} decision is ${entry.decision?.status ?? 'missing'}, expected ${ifStatus}`,
    );
  }
}

function assertPayable(entry: LedgerEntry, next: PaymentStatus): void {
  const intentId = entry.intent.id;
  if (entry.decision?.status !== 'approved') {
    throw new LedgerError(
      'precondition_failed',
      `intent ${intentId} cannot be paid: decision is ${entry.decision?.status ?? 'missing'}`,
    );
  }
  if (entry.paymentStatus === undefined) return;
  if (entry.paymentStatus === 'submitting' && next !== 'submitting') return;
  throw new LedgerError('precondition_failed', `intent ${intentId} already has payment status ${entry.paymentStatus}`);
}

function assertDecisionTransition(entry: LedgerEntry, next: DecisionStatus): void {
  const current = entry.decision?.status;
  if (current === undefined) return;
  if (current === 'needs_approval' && (next === 'approved' || next === 'rejected')) return;
  throw new LedgerError(
    'precondition_failed',
    `intent ${entry.intent.id} cannot change decision ${current} → ${next}`,
  );
}

function assertReceiptTransition(entry: LedgerEntry, next: ReceiptStatus): void {
  const id = entry.intent.id;
  const current = entry.receipt?.status;
  if (current === undefined) {
    const ok = entry.paymentStatus === 'failed' ? next === 'failed' : next !== 'refunded';
    if (!ok) {
      throw new LedgerError(
        'precondition_failed',
        `intent ${id} payment is ${entry.paymentStatus}; first receipt cannot be ${next}`,
      );
    }
    return;
  }
  if (current === 'succeeded' && next === 'refunded') return;
  const hint = current === 'pending' ? ' (use settleReceipt for pending receipts)' : '';
  throw new LedgerError('precondition_failed', `intent ${id} receipt cannot change ${current} → ${next}${hint}`);
}

function stateFor(entries: LedgerEntry[], intent: PaymentIntent, now: Date): LedgerState {
  const day = utcDay(now);
  const currency = normalizeCurrency(intent.currency);
  const decimals = currencyDecimals(currency);
  let total = 0;
  let totalMinor = 0n;
  for (const e of entries) {
    if (
      e.intent.id !== intent.id &&
      e.intent.agentId === intent.agentId &&
      normalizeCurrency(e.intent.currency) === currency &&
      countsTowardDailyTotal(e) &&
      accountingDay(e) === day
    ) {
      total += e.intent.amount;
      if (decimals !== undefined) totalMinor += ceilMinorUnits(e.intent.amount, decimals)!;
    }
  }
  return decimals === undefined ? { dailyTotal: total } : { dailyTotal: total, dailyTotalMinor: totalMinor };
}

function find(entries: LedgerEntry[], intentId: string): LedgerEntry {
  const entry = entries.find((e) => e.intent.id === intentId);
  if (!entry) throw new LedgerError('not_found', `intent ${intentId} not found`);
  return entry;
}
