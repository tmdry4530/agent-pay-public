import type { Decision, DecisionStatus, LedgerState, PaymentIntent, Receipt } from '@agent-pay/core';
import type { LedgerEntry, PaymentStatus } from '@agent-pay/core';

/** UTC calendar day "YYYY-MM-DD" of a Date or ISO string. */
export function utcDay(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${String(date)}`);
  return d.toISOString().slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when the entry counts toward the daily total (mirrors packages/core/src/ledger.ts).
 */
export function countsTowardDailyTotal(entry: LedgerEntry): boolean {
  if (entry.decision?.status !== 'approved') return false;
  if (entry.paymentStatus === 'failed') return false;
  if (entry.receipt?.status === 'failed') return false;
  return true;
}

export class MemoryLedgerError extends Error {
  override name = 'MemoryLedgerError';
}

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
        throw new MemoryLedgerError(`intent ${intent.id} already recorded`);
      }
      utcDay(intent.createdAt);
      const at = this.#now().toISOString();
      const entry: LedgerEntry = { intent: structuredClone(intent), recordedAt: at, updatedAt: at };
      entries.push(entry);
      return entry;
    });
  }

  recordDecision(
    intentId: string,
    decision: Decision,
    options: { ifStatus?: DecisionStatus } = {},
  ): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      if (entry.paymentStatus !== undefined) {
        throw new MemoryLedgerError(`intent ${intentId} already has a payment; decision is final`);
      }
      if (options.ifStatus !== undefined && entry.decision?.status !== options.ifStatus) {
        throw new MemoryLedgerError(
          `intent ${intentId} decision is ${entry.decision?.status ?? 'missing'}, expected ${options.ifStatus}`,
        );
      }
      entry.decision = { ...decision };
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  recordPayment(intentId: string, status: PaymentStatus): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      if (entry.decision?.status !== 'approved') {
        throw new MemoryLedgerError(
          `intent ${intentId} cannot be paid: decision is ${entry.decision?.status ?? 'missing'}`,
        );
      }
      if (entry.paymentStatus !== undefined) {
        throw new MemoryLedgerError(`intent ${intentId} already has payment status ${entry.paymentStatus}`);
      }
      entry.paymentStatus = status;
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  recordReceipt(intentId: string, receipt: Receipt): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      if (receipt.intentId !== intentId) {
        throw new MemoryLedgerError(`receipt intentId ${receipt.intentId} does not match ${intentId}`);
      }
      if (entry.paymentStatus === undefined) {
        throw new MemoryLedgerError(`intent ${intentId} has no payment recorded`);
      }
      entry.receipt = { ...receipt };
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  async dailyTotal(agentId: string, day?: Date | string): Promise<number> {
    const target =
      day === undefined ? utcDay(this.#now()) : typeof day === 'string' && DAY_RE.test(day) ? day : utcDay(day);
    return this.#serialize(async () => {
      let total = 0;
      for (const e of this.#entries) {
        if (e.intent.agentId === agentId && utcDay(e.intent.createdAt) === target && countsTowardDailyTotal(e)) {
          total += e.intent.amount;
        }
      }
      return total;
    });
  }

  async ledgerStateFor(intent: PaymentIntent): Promise<LedgerState> {
    const day = utcDay(intent.createdAt);
    return this.#serialize(async () => {
      let total = 0;
      for (const e of this.#entries) {
        if (
          e.intent.id !== intent.id &&
          e.intent.agentId === intent.agentId &&
          utcDay(e.intent.createdAt) === day &&
          countsTowardDailyTotal(e)
        ) {
          total += e.intent.amount;
        }
      }
      return { dailyTotal: total };
    });
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

function find(entries: LedgerEntry[], intentId: string): LedgerEntry {
  const entry = entries.find((e) => e.intent.id === intentId);
  if (!entry) throw new MemoryLedgerError(`intent ${intentId} not found`);
  return entry;
}
