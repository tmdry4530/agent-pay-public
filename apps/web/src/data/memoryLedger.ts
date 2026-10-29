import type {
  Decision,
  DecisionRecord,
  DecisionStatus,
  LedgerState,
  PaymentIntent,
  Receipt,
} from '@agent-pay/core';
import type { LedgerEntry, PaymentStatus, ReceiptResolution } from '@agent-pay/core';

/** Local payment status including in-flight 'submitting' (future core); cast at core Ledger boundary. */
export type WebPaymentStatus = PaymentStatus | 'submitting';

type MutableLedgerEntry = Omit<LedgerEntry, 'paymentStatus'> & { paymentStatus?: WebPaymentStatus };

/** Read paymentStatus including the web-only 'submitting' marker. */
export function webPaymentStatus(entry: LedgerEntry): WebPaymentStatus | undefined {
  return (entry as MutableLedgerEntry).paymentStatus;
}

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
  const ps = entry.paymentStatus as WebPaymentStatus | undefined;
  if (ps === 'failed') return false;
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

  recordDecision(
    intentId: string,
    decision: Decision,
    options: { ifStatus?: DecisionStatus; actor?: string } = {},
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
      const at = this.#now().toISOString();
      entry.decision = { status: decision.status, reason: decision.reason };
      const record: DecisionRecord = { ...entry.decision, at };
      if (options.actor !== undefined) record.actor = options.actor;
      entry.decisions.push(record);
      entry.updatedAt = at;
      return entry;
    });
  }

  markSubmitting(intentId: string): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      if (entry.decision?.status !== 'approved') {
        throw new MemoryLedgerError(
          `intent ${intentId} cannot submit payment: decision is ${entry.decision?.status ?? 'missing'}`,
        );
      }
      const ps = webPaymentStatus(entry);
      if (ps !== undefined && ps !== 'submitting') {
        throw new MemoryLedgerError(`intent ${intentId} already has payment status ${ps}`);
      }
      (entry as MutableLedgerEntry).paymentStatus = 'submitting';
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
      const ps = webPaymentStatus(entry);
      if (ps !== undefined && ps !== 'submitting') {
        throw new MemoryLedgerError(`intent ${intentId} already has payment status ${ps}`);
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

  settleReceipt(
    intentId: string,
    receipt: Receipt,
    resolution?: ReceiptResolution,
  ): Promise<LedgerEntry> {
    return this.#mutate((entries) => {
      const entry = find(entries, intentId);
      if (receipt.intentId !== intentId) {
        throw new MemoryLedgerError(`receipt intentId ${receipt.intentId} does not match ${intentId}`);
      }
      if (entry.paymentStatus !== 'paid') {
        throw new MemoryLedgerError(
          `intent ${intentId} cannot settle receipt: payment status is ${entry.paymentStatus ?? 'missing'}`,
        );
      }
      if (entry.receipt?.status !== 'pending') {
        throw new MemoryLedgerError(
          `intent ${intentId} receipt is not pending (status is ${entry.receipt?.status ?? 'missing'})`,
        );
      }
      entry.receipt = { ...receipt };
      if (receipt.status === 'failed') entry.paymentStatus = 'failed';
      if (resolution !== undefined) entry.resolution = { ...resolution };
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
