import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LedgerError } from './errors.ts';
import type { Decision, DecisionRecord, DecisionStatus, LedgerState, PaymentIntent, Receipt } from './types.ts';

export type PaymentStatus = 'paid' | 'failed';

export interface ReceiptResolution {
  status: 'succeeded' | 'failed' | 'refunded';
  resolvedBy: string;
  note: string;
  at: string;
  previousExternalId: string;
}

export interface LedgerEntry {
  intent: PaymentIntent;
  /** The latest decision (the last element of `decisions`, without `at`/`actor`). */
  decision?: Decision;
  /**
   * Every decision recorded for this intent, oldest first, e.g. needs_approval then the
   * human's approval or rejection. Ledger always sets it (`[]` before the first decision;
   * filled on read for older files).
   */
  decisions: DecisionRecord[];
  paymentStatus?: PaymentStatus;
  receipt?: Receipt;
  /** Set only by a manual operator resolve (POST /intents/:id/resolve). */
  resolution?: ReceiptResolution;
  /** ISO time the intent was recorded (from the injected clock). */
  recordedAt: string;
  /** ISO time of the last change to this entry (from the injected clock). */
  updatedAt: string;
}

export interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

export interface LedgerOptions {
  /** Path of the JSON file. Parent directories and the file are created when missing. */
  filePath: string;
  /** Injectable clock; defaults to () => new Date(). */
  now?: () => Date;
}

export { LedgerError, type LedgerErrorCode } from './errors.ts';

/** UTC calendar day "YYYY-MM-DD" of a Date or ISO string. */
export function utcDay(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) throw new LedgerError('invalid_input', `invalid date: ${String(date)}`);
  return d.toISOString().slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when the entry counts toward the daily total: decision is 'approved' and
 * the payment has not failed (paymentStatus !== 'failed' and receipt.status !== 'failed').
 * Approved-but-not-yet-paid entries DO count (the amount is reserved).
 * Refunded receipts still count (conservative; refunds do not free budget).
 */
export function countsTowardDailyTotal(entry: LedgerEntry): boolean {
  if (entry.decision?.status !== 'approved') return false;
  if (entry.paymentStatus === 'failed') return false;
  if (entry.receipt?.status === 'failed') return false;
  return true;
}

const emptyFile = (): LedgerFile => ({ version: 1, entries: [] });

/**
 * JSON-file ledger. Lifecycle per intent: recordIntent -> recordDecision ->
 * recordPayment -> recordReceipt.
 *
 * Every operation re-reads the file, so several Ledger instances on the same
 * path see each other's writes. Writes are atomic (temp file in the same dir +
 * rename) and serialized within one instance. There is NO cross-process lock:
 * use a single writer process per file.
 *
 * Daily totals bucket by the UTC date of `intent.createdAt`.
 */
export class Ledger {
  readonly filePath: string;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: LedgerOptions) {
    this.filePath = options.filePath;
    this.#now = options.now ?? (() => new Date());
  }

  /** Reads the ledger, creating an empty file when it does not exist. */
  load(): Promise<LedgerFile> {
    return this.#serialize(() => this.#read());
  }

  async list(): Promise<LedgerEntry[]> {
    return (await this.load()).entries;
  }

  async get(intentId: string): Promise<LedgerEntry | undefined> {
    return (await this.load()).entries.find((e) => e.intent.id === intentId);
  }

  recordIntent(intent: PaymentIntent): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      if (file.entries.some((e) => e.intent.id === intent.id)) {
        throw new LedgerError('duplicate_intent', `intent ${intent.id} already recorded`);
      }
      utcDay(intent.createdAt); // validates createdAt
      const at = this.#now().toISOString();
      const entry: LedgerEntry = { intent: structuredClone(intent), decisions: [], recordedAt: at, updatedAt: at };
      file.entries.push(entry);
      return entry;
    });
  }

  /**
   * Records `intent` together with its first decision in ONE serialized write, so a
   * crash or error can never leave an undecided entry behind. `decide` receives the
   * LedgerState for the intent (same rules as ledgerStateFor). If the id is already
   * recorded, nothing is written, `decide` is not called and `{ created: false }` is
   * returned with the stored entry. If `decide` throws, nothing is written.
   */
  recordIntentAndDecide(
    intent: PaymentIntent,
    decide: (state: LedgerState) => { decision: Decision; actor?: string },
  ): Promise<{ entry: LedgerEntry; created: boolean }> {
    return this.#mutate((file) => {
      const existing = file.entries.find((e) => e.intent.id === intent.id);
      if (existing) return { entry: existing, created: false };
      utcDay(intent.createdAt); // validates createdAt
      const at = this.#now().toISOString();
      const entry: LedgerEntry = { intent: structuredClone(intent), decisions: [], recordedAt: at, updatedAt: at };
      const { decision, actor } = decide(stateFor(file, entry.intent));
      this.#applyDecision(entry, decision, actor);
      file.entries.push(entry);
      return { entry, created: true };
    });
  }

  /**
   * Records a decision: sets `decision` to it and appends it to `decisions` with
   * `at` (injected clock) and `options.actor` when given. A new decision is allowed
   * until a payment is recorded, e.g. needs_approval -> approved after a human approves.
   *
   * `options.ifStatus` makes the write conditional: it throws unless the current
   * decision status equals it (compare-and-set within this instance's write queue).
   * A throw writes nothing, so a lost race appends no history.
   */
  recordDecision(
    intentId: string,
    decision: Decision,
    options: { ifStatus?: DecisionStatus; actor?: string } = {},
  ): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      const entry = find(file, intentId);
      assertDecidable(entry, options.ifStatus);
      this.#applyDecision(entry, decision, options.actor);
      return entry;
    });
  }

  /**
   * Atomic evaluate-and-record: inside ONE serialized read-modify-write, computes the
   * LedgerState for the entry's intent (same rules as ledgerStateFor), calls `decide`
   * with it and records the returned decision (same guards as recordDecision, incl.
   * `options.ifStatus`). No other write on this ledger can interleave between reading
   * the daily total and recording the decision, so concurrent intents cannot jointly
   * exceed the daily limit. If `decide` throws, nothing is written.
   */
  decide(
    intentId: string,
    decide: (state: LedgerState, entry: LedgerEntry) => { decision: Decision; actor?: string },
    options: { ifStatus?: DecisionStatus } = {},
  ): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      const entry = find(file, intentId);
      assertDecidable(entry, options.ifStatus);
      const { decision, actor } = decide(stateFor(file, entry.intent), structuredClone(entry));
      this.#applyDecision(entry, decision, actor);
      return entry;
    });
  }

  #applyDecision(entry: LedgerEntry, decision: Decision, actor: string | undefined): void {
    const at = this.#now().toISOString();
    entry.decision = { status: decision.status, reason: decision.reason };
    const record: DecisionRecord = { ...entry.decision, at };
    if (actor !== undefined) record.actor = actor;
    (entry.decisions ??= []).push(record);
    entry.updatedAt = at;
  }

  /** Records the payment outcome. Requires an 'approved' decision and no prior payment. */
  recordPayment(intentId: string, status: PaymentStatus): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      const entry = find(file, intentId);
      if (entry.decision?.status !== 'approved') {
        throw new LedgerError(
          'precondition_failed',
          `intent ${intentId} cannot be paid: decision is ${entry.decision?.status ?? 'missing'}`,
        );
      }
      if (entry.paymentStatus !== undefined) {
        throw new LedgerError('precondition_failed', `intent ${intentId} already has payment status ${entry.paymentStatus}`);
      }
      entry.paymentStatus = status;
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  /**
   * Settles a pending receipt (compare-and-set). Requires `paymentStatus === 'paid'`
   * and the current receipt status `pending`. Replaces the receipt; when the new
   * status is `failed`, also sets `paymentStatus` to `failed` (same as payApproved).
   * Throws LedgerError on mismatch or if the receipt is not pending.
   */
  settleReceipt(intentId: string, receipt: Receipt, resolution?: ReceiptResolution): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      const entry = find(file, intentId);
      if (receipt.intentId !== intentId) {
        throw new LedgerError('invalid_input', `receipt intentId ${receipt.intentId} does not match ${intentId}`);
      }
      if (entry.paymentStatus !== 'paid') {
        throw new LedgerError(
          'precondition_failed',
          `intent ${intentId} cannot settle receipt: payment status is ${entry.paymentStatus ?? 'missing'}`,
        );
      }
      if (entry.receipt?.status !== 'pending') {
        throw new LedgerError(
          'precondition_failed',
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

  /**
   * Attaches a receipt. Requires a recorded payment. May be called again to
   * replace the receipt (e.g. a refund receipt). Pending receipts should be
   * settled via `settleReceipt` so concurrent updates are guarded.
   */
  recordReceipt(intentId: string, receipt: Receipt): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      const entry = find(file, intentId);
      if (receipt.intentId !== intentId) {
        throw new LedgerError('invalid_input', `receipt intentId ${receipt.intentId} does not match ${intentId}`);
      }
      if (entry.paymentStatus === undefined) {
        throw new LedgerError('precondition_failed', `intent ${intentId} has no payment recorded`);
      }
      entry.receipt = { ...receipt };
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  /**
   * Sum of counted amounts (see countsTowardDailyTotal) for `agentId` on a UTC
   * day. `day` is a Date, an ISO timestamp, or "YYYY-MM-DD"; default is today
   * (UTC) per the injected clock.
   */
  async dailyTotal(agentId: string, day?: Date | string): Promise<number> {
    const target =
      day === undefined ? utcDay(this.#now()) : typeof day === 'string' && DAY_RE.test(day) ? day : utcDay(day);
    const file = await this.load();
    let total = 0;
    for (const e of file.entries) {
      if (e.intent.agentId === agentId && utcDay(e.intent.createdAt) === target && countsTowardDailyTotal(e)) {
        total += e.intent.amount;
      }
    }
    return total;
  }

  /**
   * LedgerState for evaluating `intent`: the total for its agent on the UTC day
   * of intent.createdAt, excluding the intent itself if already recorded.
   */
  async ledgerStateFor(intent: PaymentIntent): Promise<LedgerState> {
    return stateFor(await this.load(), intent);
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #mutate<T>(fn: (file: LedgerFile) => T): Promise<T> {
    return this.#serialize(async () => {
      const file = await this.#read();
      const result = fn(file);
      await this.#write(file);
      return structuredClone(result);
    });
  }

  async #read(): Promise<LedgerFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const file = emptyFile();
      await this.#write(file);
      return file;
    }
    const parsed = JSON.parse(raw) as LedgerFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new LedgerError('invalid_input', `unsupported ledger file format at ${this.filePath}`);
    }
    // Files written before decision history: back-fill in memory only. The file is
    // rewritten in the new shape on the next mutation, never by a read.
    for (const entry of parsed.entries) {
      if (!Array.isArray(entry.decisions)) entry.decisions = entry.decision ? [{ ...entry.decision }] : [];
    }
    return parsed;
  }

  async #write(file: LedgerFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

function assertDecidable(entry: LedgerEntry, ifStatus: DecisionStatus | undefined): void {
  const intentId = entry.intent.id;
  if (entry.paymentStatus !== undefined) {
    throw new LedgerError('precondition_failed', `intent ${intentId} already has a payment; decision is final`);
  }
  if (ifStatus !== undefined && entry.decision?.status !== ifStatus) {
    throw new LedgerError('precondition_failed', `intent ${intentId} decision is ${entry.decision?.status ?? 'missing'}, expected ${ifStatus}`);
  }
}

function stateFor(file: LedgerFile, intent: PaymentIntent): LedgerState {
  const day = utcDay(intent.createdAt);
  let total = 0;
  for (const e of file.entries) {
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
}

function find(file: LedgerFile, intentId: string): LedgerEntry {
  const entry = file.entries.find((e) => e.intent.id === intentId);
  if (!entry) throw new LedgerError('not_found', `intent ${intentId} not found`);
  return entry;
}
