import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { LedgerError } from './errors.ts';
import { ceilMinorUnits, currencyDecimals } from './money.ts';
import type { Decision, DecisionRecord, DecisionStatus, LedgerState, PaymentIntent, Rail, Receipt, ReceiptStatus } from './types.ts';

/**
 * 'submitting': recorded just before adapter.pay is called (F4); the outcome is not known
 * yet. It holds the daily limit, replays as in_progress, is never re-sent automatically,
 * and an entry stuck in it (crash during pay) is settled by an operator via resolveIntent.
 */
export type PaymentStatus = 'paid' | 'failed' | 'submitting';

/** Set by markSubmitting: which rail the payment was handed to, and when. */
export interface PaymentSubmission {
  rail: Rail;
  at: string;
}

/** Outcome written by recordPaymentResult. */
export interface PaymentOutcome {
  status: 'paid' | 'failed';
  receipt?: Receipt;
  /** The rail outcome is unknown (pay threw / timed out / invalid receipt); see LedgerEntry.needsManualResolve. */
  needsManualResolve?: true;
}

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
  /** Set when the payment was handed to a rail (markSubmitting). Kept after it settles. */
  submission?: PaymentSubmission;
  receipt?: Receipt;
  /**
   * True while the rail outcome is unknown (adapter.pay threw, timed out or returned an
   * invalid receipt). The entry is paid with a placeholder 'pending' receipt (externalId
   * ''), keeps holding the limit, is skipped by reconcile/refresh and is never re-sent;
   * an operator settles it with resolveIntent, which clears the flag.
   */
  needsManualResolve?: true;
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
  /**
   * How long a write waits for the cross-process lock file (`<filePath>.lock`) held by
   * another live process before failing with LedgerError 'lock_timeout'.
   * Default DEFAULT_LOCK_TIMEOUT_MS (5000).
   */
  lockTimeoutMs?: number;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** A lock file older than this is treated as abandoned even if its pid is alive (pid reuse). */
export const LOCK_STALE_MS = 60_000;

/** One promise chain per resolved file path, shared by every Ledger instance in this process. */
const pathQueues = new Map<string, Promise<unknown>>();

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
 * JSON-file ledger. Lifecycle per intent: recordIntent(AndDecide) -> recordDecision/decide
 * -> markSubmitting -> recordPaymentResult (payment + receipt), or the older
 * recordPayment -> recordReceipt.
 *
 * Every operation re-reads the file, so several Ledger instances on the same
 * path see each other's writes. Writes are atomic (temp file in the same dir +
 * rename). Every read-modify-write is serialized per resolved file path within
 * the process (all instances share one queue) and across processes by an
 * exclusive lock file `<filePath>.lock` (O_EXCL create; contains the holder's
 * pid). A lock whose pid is dead, or that is older than LOCK_STALE_MS, is taken
 * over; waiting longer than lockTimeoutMs throws LedgerError 'lock_timeout'.
 * Taking over a stale lock is best-effort (two processes stealing the same stale
 * lock at the same instant can both proceed); it only matters after a crash.
 *
 * Daily totals bucket by the server-clock day the amount was approved (accountingDay).
 */
export class Ledger {
  readonly filePath: string;
  readonly #now: () => Date;
  readonly #key: string;
  readonly #lockTimeoutMs: number;
  /** Set once stale `<file>.*.tmp` files have been swept under the lock (F13). */
  #swept = false;

  constructor(options: LedgerOptions) {
    this.filePath = options.filePath;
    this.#now = options.now ?? (() => new Date());
    this.#key = resolve(options.filePath);
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** Reads the ledger, creating an empty file when it does not exist. */
  load(): Promise<LedgerFile> {
    if (!this.#swept) return this.#serialize(() => this.#withFileLock(() => this.#read(true)));
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
      const { decision, actor } = decide(stateFor(file, entry.intent, this.#now()));
      this.#applyDecision(entry, decision, actor);
      file.entries.push(entry);
      return { entry, created: true };
    });
  }

  /**
   * Records a decision: sets `decision` to it and appends it to `decisions` with
   * `at` (injected clock) and `options.actor` when given. Allowed transitions: none →
   * any, needs_approval → approved/rejected (approved/rejected are final), and only
   * before a payment is recorded. Others throw LedgerError precondition_failed.
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
      const { decision, actor } = decide(stateFor(file, entry.intent, this.#now()), structuredClone(entry));
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

  /**
   * Records the payment outcome. Requires an 'approved' decision and either no payment
   * yet or 'submitting' (then only 'paid'/'failed'). Prefer recordPaymentResult, which
   * also stores the receipt in the same write.
   */
  recordPayment(intentId: string, status: PaymentStatus): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      const entry = find(file, intentId);
      assertPayable(entry, status);
      entry.paymentStatus = status;
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  /**
   * Marks an approved, unpaid intent as handed to `rail` (paymentStatus 'submitting',
   * `submission` = { rail, at }). Called just before adapter.pay. Compare-and-set: throws
   * LedgerError precondition_failed unless the decision is 'approved' and no payment is
   * recorded, so a payment can be submitted at most once.
   */
  markSubmitting(intentId: string, rail: Rail): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      const entry = find(file, intentId);
      assertPayable(entry, 'submitting');
      const at = this.#now().toISOString();
      entry.paymentStatus = 'submitting';
      entry.submission = { rail, at };
      entry.updatedAt = at;
      return entry;
    });
  }

  /**
   * Writes the payment outcome and its receipt (when given) in ONE write. Requires
   * paymentStatus 'submitting' (or an approved entry with no payment yet). The receipt
   * follows the recordReceipt first-receipt rules; a 'failed' receipt makes the payment
   * 'failed'. Throws LedgerError precondition_failed / invalid_input; a throw writes nothing.
   */
  recordPaymentResult(intentId: string, outcome: PaymentOutcome): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      const entry = find(file, intentId);
      if (entry.paymentStatus !== 'submitting') assertPayable(entry, outcome.status);
      if (outcome.status !== 'paid' && outcome.status !== 'failed') {
        throw new LedgerError('invalid_input', `payment outcome must be paid or failed, got ${String(outcome.status)}`);
      }
      entry.paymentStatus = outcome.status;
      if (outcome.receipt !== undefined) {
        if (outcome.receipt.intentId !== intentId) {
          throw new LedgerError('invalid_input', `receipt intentId ${outcome.receipt.intentId} does not match ${intentId}`);
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

  /**
   * Settles a pending receipt (compare-and-set). Requires `paymentStatus === 'paid'`
   * and the current receipt status `pending`, or `paymentStatus === 'submitting'` with
   * no receipt (an interrupted submission settled by resolveIntent). Replaces the
   * receipt and sets `paymentStatus` to `failed` when the new status is `failed`, else
   * `paid`. Throws LedgerError on mismatch or if the receipt is not pending.
   */
  settleReceipt(intentId: string, receipt: Receipt, resolution?: ReceiptResolution): Promise<LedgerEntry> {
    return this.#mutate((file) => {
      const entry = find(file, intentId);
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
        throw new LedgerError('invalid_input', `intent ${intentId}: a submitting payment must settle to a final status`);
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

  /**
   * Attaches a receipt. Requires a recorded payment. The first receipt must agree with
   * the payment (any but 'refunded' when paid, a 'failed' receipt marking the payment
   * failed; only 'failed' when failed); afterwards the
   * only replacement allowed is a refund of a succeeded receipt. Pending receipts are
   * settled via `settleReceipt`. Anything else throws LedgerError precondition_failed.
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
      if (entry.paymentStatus === 'submitting') {
        throw new LedgerError('precondition_failed', `intent ${intentId} is submitting; use recordPaymentResult or settleReceipt`);
      }
      assertReceiptTransition(entry, receipt.status);
      entry.receipt = { ...receipt };
      if (receipt.status === 'failed') entry.paymentStatus = 'failed'; // keep payment and receipt consistent
      entry.updatedAt = this.#now().toISOString();
      return entry;
    });
  }

  /**
   * Sum of counted amounts (see countsTowardDailyTotal) for `agentId` on a UTC
   * day, bucketed by server time (see accountingDay), not intent.createdAt. `day` is a Date, an ISO timestamp, or "YYYY-MM-DD"; default is today
   * (UTC) per the injected clock. Pass `currency` (case-insensitive) to sum only
   * that currency, which is what policy limits use; without it every currency is
   * added together (legacy behavior, only meaningful for single-currency ledgers).
   */
  async dailyTotal(agentId: string, day?: Date | string, currency?: string): Promise<number> {
    const totals = await this.dailyTotals(agentId, day);
    if (currency !== undefined) return totals[normalizeCurrency(currency)] ?? 0;
    return Object.values(totals).reduce((a, b) => a + b, 0);
  }

  /** Per-currency daily totals (currency codes upper-cased), same rules as dailyTotal. */
  async dailyTotals(agentId: string, day?: Date | string): Promise<Record<string, number>> {
    const target =
      day === undefined ? utcDay(this.#now()) : typeof day === 'string' && DAY_RE.test(day) ? day : utcDay(day);
    const file = await this.load();
    const totals: Record<string, number> = {};
    for (const e of file.entries) {
      if (e.intent.agentId === agentId && countsTowardDailyTotal(e) && accountingDay(e) === target) {
        const c = normalizeCurrency(e.intent.currency);
        totals[c] = (totals[c] ?? 0) + e.intent.amount;
      }
    }
    return totals;
  }

  /**
   * LedgerState for evaluating `intent` now: the total for its agent, in its currency,
   * on today's UTC day per the injected server clock (see accountingDay), excluding
   * the intent itself if already recorded. intent.createdAt is NOT used (client-supplied).
   */
  async ledgerStateFor(intent: PaymentIntent): Promise<LedgerState> {
    return stateFor(await this.load(), intent, this.#now());
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.#key;
    const run = (pathQueues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    pathQueues.set(key, tail);
    void tail.then(() => {
      if (pathQueues.get(key) === tail) pathQueues.delete(key);
    });
    return run;
  }

  #mutate<T>(fn: (file: LedgerFile) => T): Promise<T> {
    return this.#serialize(() =>
      this.#withFileLock(async () => {
        const file = await this.#read(true);
        const result = fn(file);
        await this.#write(file);
        return structuredClone(result);
      }),
    );
  }

  /** Runs `fn` while holding the cross-process lock file `<filePath>.lock`. */
  async #withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await mkdir(dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + this.#lockTimeoutMs;
    let delay = 2;
    for (;;) {
      try {
        const fh = await open(lockPath, 'wx');
        try {
          await fh.writeFile(`${process.pid}\n`, 'utf8');
        } finally {
          await fh.close();
        }
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (await lockIsStale(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LedgerError('lock_timeout', `ledger ${this.filePath} is locked by another process (${lockPath})`);
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 50);
      }
    }
    try {
      if (!this.#swept) {
        await this.#sweepStaleTmpFiles();
        this.#swept = true;
      }
      return await fn();
    } finally {
      await rm(lockPath, { force: true });
    }
  }

  /**
   * Removes `<file>.<pid>.<ts>.<rand>.tmp` files left by writers that died between
   * writing and renaming. Called with the lock held; a tmp file is removed when its
   * pid is dead or it is older than LOCK_STALE_MS. Best-effort: errors are ignored.
   */
  async #sweepStaleTmpFiles(): Promise<void> {
    const dir = dirname(this.filePath);
    const prefix = `${basename(this.filePath)}.`;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const pid = Number(name.slice(prefix.length).split('.')[0]);
      const path = join(dir, name);
      try {
        const old = Date.now() - (await stat(path)).mtimeMs > LOCK_STALE_MS;
        if (old || (Number.isInteger(pid) && pid > 0 && !pidAlive(pid))) await rm(path, { force: true });
      } catch {
        // vanished or unreadable: leave it
      }
    }
  }

  /** `locked`: the caller holds the file lock, so a missing file may be created here. */
  async #read(locked = false): Promise<LedgerFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!locked) return this.#withFileLock(() => this.#read(true));
      const file = emptyFile();
      await this.#write(file);
      return file;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw corrupt(this.filePath, `not valid JSON (${(err as Error).message})`);
    }
    const problem = ledgerFileProblem(json);
    if (problem) throw corrupt(this.filePath, problem);
    const parsed = json as LedgerFile;
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
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify(file, null, 2) + '\n', 'utf8');
        await fh.sync(); // data on disk before the rename makes it visible
      } finally {
        await fh.close();
      }
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await syncDir(dirname(this.filePath));
  }
}

function corrupt(filePath: string, problem: string): LedgerError {
  return new LedgerError(
    'ledger_corrupt',
    `ledger file ${filePath} is corrupt: ${problem}. The file was not modified; restore it from a backup or repair it by hand.`,
  );
}

const PAYMENT_STATUSES: readonly string[] = ['paid', 'failed', 'submitting'] satisfies PaymentStatus[];
const DECISION_STATUSES: readonly string[] = ['approved', 'rejected', 'needs_approval'];
const RECEIPT_STATUSES: readonly string[] = ['succeeded', 'pending', 'failed', 'refunded'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDate = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Structural check of a parsed ledger file (F10). Returns a description of the
 * first problem found, or undefined when the file is usable. Only fields the
 * ledger and policy arithmetic rely on are checked; unknown extra fields are kept.
 */
function ledgerFileProblem(json: unknown): string | undefined {
  if (!isObject(json)) return 'top level is not an object';
  if (json.version !== 1) return `unsupported ledger file format (version ${JSON.stringify(json.version)})`;
  if (!Array.isArray(json.entries)) return 'entries is not an array';
  const ids = new Set<string>();
  for (const [i, e] of json.entries.entries()) {
    const at = `entries[${i}]`;
    if (!isObject(e)) return `${at} is not an object`;
    const intent = e.intent;
    if (!isObject(intent)) return `${at}.intent is not an object`;
    for (const key of ['id', 'agentId', 'payee', 'currency'] as const) {
      if (typeof intent[key] !== 'string' || intent[key] === '') return `${at}.intent.${key} is not a non-empty string`;
    }
    if (typeof intent.amount !== 'number' || !Number.isFinite(intent.amount)) return `${at}.intent.amount is not a finite number`;
    if (!isDate(intent.createdAt)) return `${at}.intent.createdAt is not a valid date`;
    const id = intent.id as string;
    if (ids.has(id)) return `${at}.intent.id ${JSON.stringify(id)} is duplicated`;
    ids.add(id);
    if (e.decision !== undefined && (!isObject(e.decision) || !DECISION_STATUSES.includes(e.decision.status as string))) {
      return `${at}.decision has an unknown status`;
    }
    if (e.decisions !== undefined) {
      if (!Array.isArray(e.decisions)) return `${at}.decisions is not an array`;
      for (const [j, d] of e.decisions.entries()) {
        if (!isObject(d) || !DECISION_STATUSES.includes(d.status as string)) return `${at}.decisions[${j}] has an unknown status`;
        if (d.at !== undefined && !isDate(d.at)) return `${at}.decisions[${j}].at is not a valid date`;
      }
    }
    if (e.paymentStatus !== undefined && !PAYMENT_STATUSES.includes(e.paymentStatus as string)) {
      return `${at}.paymentStatus ${JSON.stringify(e.paymentStatus)} is unknown`;
    }
    if (e.needsManualResolve !== undefined && e.needsManualResolve !== true) return `${at}.needsManualResolve must be true when present`;
    if (e.submission !== undefined) {
      const sub = e.submission;
      if (!isObject(sub) || typeof sub.rail !== 'string' || !isDate(sub.at)) return `${at}.submission must have a rail and a valid at`;
    }
    if (e.receipt !== undefined) {
      const r = e.receipt;
      if (!isObject(r)) return `${at}.receipt is not an object`;
      if (r.intentId !== id) return `${at}.receipt.intentId does not match the intent`;
      if (!RECEIPT_STATUSES.includes(r.status as string)) return `${at}.receipt.status ${JSON.stringify(r.status)} is unknown`;
    }
    if (e.recordedAt !== undefined && !isDate(e.recordedAt)) return `${at}.recordedAt is not a valid date`;
  }
  return undefined;
}

/** True when the lock's holder pid is dead, or the lock is older than LOCK_STALE_MS. */
async function lockIsStale(lockPath: string): Promise<boolean> {
  let content: string;
  let mtimeMs: number;
  try {
    [content, mtimeMs] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath).then((s) => s.mtimeMs)]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; // released meanwhile: just retry
    throw err;
  }
  if (Date.now() - mtimeMs > LOCK_STALE_MS) return true;
  const pid = Number.parseInt(content, 10);
  if (!Number.isInteger(pid) || pid <= 0) return false; // being written right now
  if (pid === process.pid) return false;
  return !pidAlive(pid);
}

/** False only when the pid certainly does not exist (EPERM means alive, other user). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** fsync a directory so a completed rename survives power loss. Best-effort (unsupported on some platforms). */
async function syncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch {
    // e.g. EISDIR/EPERM on Windows: nothing more we can do
  } finally {
    await fh?.close().catch(() => undefined);
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

/** Payment preconditions: an approved decision and no payment yet ('submitting' may become paid/failed). */
function assertPayable(entry: LedgerEntry, next: PaymentStatus): void {
  const intentId = entry.intent.id;
  if (entry.decision?.status !== 'approved') {
    throw new LedgerError('precondition_failed', `intent ${intentId} cannot be paid: decision is ${entry.decision?.status ?? 'missing'}`);
  }
  if (entry.paymentStatus === undefined) return;
  if (entry.paymentStatus === 'submitting' && next !== 'submitting') return;
  throw new LedgerError('precondition_failed', `intent ${intentId} already has payment status ${entry.paymentStatus}`);
}

/**
 * Decision transition table (F15): undecided → any status; needs_approval → approved or
 * rejected; approved and rejected are final.
 */
function assertDecisionTransition(entry: LedgerEntry, next: DecisionStatus): void {
  const current = entry.decision?.status;
  if (current === undefined) return;
  if (current === 'needs_approval' && (next === 'approved' || next === 'rejected')) return;
  throw new LedgerError('precondition_failed', `intent ${entry.intent.id} cannot change decision ${current} → ${next}`);
}

/**
 * Receipt rules for recordReceipt (F15). First receipt: 'succeeded', 'pending' or
 * 'failed' on a 'paid' payment (failed also flips paymentStatus to 'failed'), only
 * 'failed' on a 'failed' payment. Afterwards only a refund of a
 * succeeded receipt ('succeeded' → 'refunded'); pending receipts go through settleReceipt.
 */
function assertReceiptTransition(entry: LedgerEntry, next: ReceiptStatus): void {
  const id = entry.intent.id;
  const current = entry.receipt?.status;
  if (current === undefined) {
    const ok = entry.paymentStatus === 'failed' ? next === 'failed' : next !== 'refunded';
    if (!ok) throw new LedgerError('precondition_failed', `intent ${id} payment is ${entry.paymentStatus}; first receipt cannot be ${next}`);
    return;
  }
  if (current === 'succeeded' && next === 'refunded') return;
  const hint = current === 'pending' ? ' (use settleReceipt for pending receipts)' : '';
  throw new LedgerError('precondition_failed', `intent ${id} receipt cannot change ${current} → ${next}${hint}`);
}

/** Currency key used for per-currency totals: upper-cased (same comparison evaluate uses). */
export function normalizeCurrency(currency: string): string {
  return String(currency).toUpperCase();
}

/**
 * UTC day an entry's spend is accounted to, from server-side times only: the time of
 * its latest 'approved' decision record, else recordedAt, else (files from before
 * server timestamps existed) intent.createdAt.
 */
export function accountingDay(entry: LedgerEntry): string {
  let approvedAt: string | undefined;
  for (const d of entry.decisions ?? []) if (d.status === 'approved' && d.at !== undefined) approvedAt = d.at;
  return utcDay(approvedAt ?? entry.recordedAt ?? entry.intent.createdAt);
}

function stateFor(file: LedgerFile, intent: PaymentIntent, now: Date): LedgerState {
  const day = utcDay(now);
  const currency = normalizeCurrency(intent.currency);
  const decimals = currencyDecimals(currency);
  let total = 0;
  let totalMinor = 0n;
  for (const e of file.entries) {
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

function find(file: LedgerFile, intentId: string): LedgerEntry {
  const entry = file.entries.find((e) => e.intent.id === intentId);
  if (!entry) throw new LedgerError('not_found', `intent ${intentId} not found`);
  return entry;
}
