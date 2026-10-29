import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
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
 * JSON-file ledger. Lifecycle per intent: recordIntent -> recordDecision ->
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
 * Daily totals bucket by the UTC date of `intent.createdAt`.
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
