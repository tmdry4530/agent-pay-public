import { randomUUID } from 'node:crypto';
import type { LedgerEntry, PaymentResult, Receipt } from '@agent-pay/core';
import { ApiClientError, getHealth, getLedger, getRail, postApprove, postIntent, postRefresh, type RailInfo } from './client.ts';
import { createPlanner, type Planner, type Quote } from './planner.ts';
import { SCENARIOS, isScenarioName, type ScenarioName } from './scenarios.ts';

/** Final outcome. `error` = the agent could not finish (bad input, planner error, API unreachable/HTTP error). */
export type AgentFinalStatus = 'paid' | 'rejected' | 'approval_timeout' | 'failed' | 'error' | 'receipt_pending';

/** Step names, in the order they can appear. */
export type AgentStep =
  | 'health'
  | 'task'
  | 'quote'
  | 'rail'
  | 'submit_intent'
  | 'submit_retry'
  | 'intent_result'
  | 'await_approval'
  | 'auto_approve'
  | 'approve_result'
  | 'poll'
  | 'await_receipt'
  | 'refresh'
  | 'error';

export interface AgentStepEvent {
  type: 'step';
  step: AgentStep;
  ts: string;
  message: string;
  intentId?: string;
  [key: string]: unknown;
}

export interface AgentSummaryEvent {
  type: 'summary';
  ts: string;
  status: AgentFinalStatus;
  exitCode: number;
  task?: string;
  scenario?: ScenarioName;
  intentId?: string;
  quote?: Quote;
  receipt?: Receipt;
  reason?: string;
  error?: string;
}

export type AgentEvent = AgentStepEvent | AgentSummaryEvent;

export interface AgentIO {
  /** Output sink for formatted lines (human text or NDJSON). Defaults to console.log. */
  writeLine(line: string): void;
  /** Called with every structured event, in either mode (for tests or embedding). */
  emit(event: AgentEvent): void;
}

export interface RunAgentOptions {
  apiUrl: string;
  agentId: string;
  task?: string;
  scenario?: ScenarioName;
  /** NDJSON output instead of human-readable lines. */
  json?: boolean;
  /** How long to wait for a human decision on needs_approval. Default 120000. */
  timeoutMs?: number;
  /** GET /ledger poll interval while waiting. Default 1000. */
  pollMs?: number;
  /** Demo only: simulate the human by calling POST /intents/:id/approve as this approver. */
  autoApproveAs?: string;
  /** Pause before the simulated approval so the wait step is visible. Default 0. */
  approveDelayMs?: number;
  /** Defaults to RuleBasedPlanner. Plug an LLM planner in here. */
  planner?: Planner;
  /** Call GET /health before anything else and fail fast (exit 1) if the API is down. Default true. */
  healthCheck?: boolean;
  /** Expected server rail (CLI --rail). If GET /health reports a different rail, finish 'error' (exit 1). */
  expectedRail?: string;
  /**
   * Intent id for this run. Default: generated once per run (`pi_<uuid>`). The same id and
   * createdAt are resent on every POST /intents retry, so a retry after a lost response or
   * timeout replays the stored outcome instead of paying twice (F14).
   */
  intentId?: string;
  /** Total POST /intents attempts on retryable errors (timeout, dropped connection, 5xx). Default 3. */
  submitAttempts?: number;
  /** Pause between POST /intents attempts. Default 500. */
  submitRetryDelayMs?: number;
  /** Per-attempt POST /intents timeout. Default SUBMIT_TIMEOUT_MS (70000). */
  submitTimeoutMs?: number;
}

export interface RunAgentResult {
  status: AgentFinalStatus;
  exitCode: number;
  task?: string;
  scenario?: ScenarioName;
  intentId?: string;
  quote?: Quote;
  receipt?: Receipt;
  reason?: string;
  error?: string;
}

export const EXIT_CODES: Record<AgentFinalStatus, number> = {
  paid: 0,
  rejected: 2,
  approval_timeout: 3,
  receipt_pending: 3,
  failed: 1,
  error: 1,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Maps a ledger entry to a final status, or 'pending' while undecided or mid-payment. */
export function entryOutcome(entry: LedgerEntry): Exclude<AgentFinalStatus, 'approval_timeout' | 'error' | 'receipt_pending'> | 'pending' {
  if (entry.paymentStatus === 'paid') return 'paid';
  if (entry.paymentStatus === 'failed') return 'failed';
  if (entry.decision?.status === 'rejected') return 'rejected';
  return 'pending';
}

function needsReceiptWait(receipt: Receipt | undefined): receipt is Receipt {
  return receipt?.status === 'pending';
}

/** Runs one task end to end. Never throws; failures come back as status 'error' (exit 1). */
export async function runAgent(options: RunAgentOptions, ioOverrides: Partial<AgentIO> = {}): Promise<RunAgentResult> {
  const json = options.json === true;
  const writeLine = ioOverrides.writeLine ?? ((line: string) => console.log(line));
  const emitHook = ioOverrides.emit ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 1000;
  const planner = options.planner ?? createPlanner('rule');

  const ctx: Pick<RunAgentResult, 'task' | 'scenario' | 'intentId' | 'quote'> = { scenario: options.scenario };

  const step = (name: AgentStep, message: string, extra: Record<string, unknown> = {}): void => {
    const event: AgentStepEvent = { type: 'step', step: name, ts: new Date().toISOString(), message, ...extra };
    if (ctx.intentId && event.intentId === undefined) event.intentId = ctx.intentId;
    emitHook(event);
    // The health line is printed bare in human mode: `server: <url> rail=<rail>`.
    writeLine(json ? JSON.stringify(event) : name === 'health' ? message : `[${name}] ${message}`);
  };

  const finish = (status: AgentFinalStatus, extra: Partial<RunAgentResult> = {}): RunAgentResult => {
    const result: RunAgentResult = { status, exitCode: EXIT_CODES[status], ...ctx, ...extra };
    const summary: AgentSummaryEvent = { type: 'summary', ts: new Date().toISOString(), ...result };
    emitHook(summary);
    if (json) {
      writeLine(JSON.stringify(summary));
    } else {
      writeLine(`Done: ${status} (exit ${result.exitCode})`);
      if (result.reason) writeLine(`Reason: ${result.reason}`);
      if (result.receipt) writeLine(`Receipt: ${result.receipt.rail} ${result.receipt.externalId} (${result.receipt.status})`);
      if (result.error) writeLine(`Error: ${result.error}`);
    }
    return result;
  };

  const fail = (err: unknown): RunAgentResult => {
    const message = errorMessage(err);
    step('error', message, err instanceof ApiClientError && err.status ? { httpStatus: err.status } : {});
    return finish('error', { error: message });
  };

  const fromPayment = (r: PaymentResult): RunAgentResult | undefined | 'await_receipt' => {
    if (r.status === 'paid' && needsReceiptWait(r.receipt)) return 'await_receipt';
    if (r.status === 'paid') return finish('paid', { receipt: r.receipt, reason: r.decision.reason });
    if (r.status === 'rejected') return finish('rejected', { reason: r.decision.reason });
    if (r.status === 'failed') return finish('failed', { receipt: r.receipt, reason: r.error ?? r.decision.reason });
    return undefined; // needs_approval
  };

  /**
   * The payment is `paid` but its receipt is `pending`: poll POST /intents/:id/refresh every pollMs until the
   * rail settles it (succeeded → paid, failed → failed) or timeoutMs (from the start of this wait) elapses
   * (→ receipt_pending, exit 3). A `refresh` step is emitted only when the receipt status changes, plus once
   * per distinct transient error (5xx such as 502 status_check_failed, or a network error), which is retried.
   */
  const awaitReceiptSettlement = async (intentId: string): Promise<RunAgentResult> => {
    step('await_receipt', `receipt is pending; polling POST /intents/${intentId}/refresh (timeout ${timeoutMs}ms, poll ${pollMs}ms)`, {
      timeoutMs,
      pollMs,
    });
    const deadline = Date.now() + timeoutMs;
    let current: Receipt['status'] = 'pending';
    let lastErrorNote: string | undefined;

    const settled = (receipt: Receipt | undefined, failed: boolean, reason: string | undefined): RunAgentResult | undefined => {
      const to = receipt?.status;
      if (to !== undefined && to !== current) {
        step('refresh', `receipt ${current} -> ${to}`, { from: current, to, receiptStatus: to });
        current = to;
      }
      if (failed || to === 'failed') return finish('failed', { receipt, reason });
      if (to !== undefined && to !== 'pending') return finish('paid', { receipt, reason });
      return undefined;
    };

    for (;;) {
      try {
        const refreshed = await postRefresh(options.apiUrl, intentId);
        lastErrorNote = undefined;
        const done = settled(refreshed.receipt, refreshed.status === 'failed', refreshed.error ?? refreshed.decision.reason);
        if (done) return done;
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 409) {
          if (err.message.startsWith('receipt_not_pending:')) {
            // Settled by someone else (e.g. a reconcile run): read the final state from the ledger.
            let entry: LedgerEntry | undefined;
            try {
              entry = (await getLedger(options.apiUrl)).entries.find((e) => e.intent.id === intentId);
            } catch (ledgerErr) {
              return fail(ledgerErr);
            }
            const done = entry && settled(entry.receipt, entry.paymentStatus === 'failed', entry.decision?.reason);
            if (done) return done;
          }
          // no_receipt / status_unsupported (rail cannot report status): give up waiting, still pending.
          return finish('receipt_pending', { reason: err.message });
        }
        if (err instanceof ApiClientError && err.status !== undefined && err.status < 500) return fail(err);
        const note = errorMessage(err);
        if (note !== lastErrorNote) {
          step('refresh', `refresh error (${note}); retrying until timeout`, {
            error: note,
            ...(err instanceof ApiClientError && err.status ? { httpStatus: err.status } : {}),
          });
          lastErrorNote = note;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return finish('receipt_pending', { reason: `receipt still pending after ${timeoutMs}ms` });
      }
      await sleep(Math.min(pollMs, remaining));
    }
  };

  // 0. Health: fail fast if the API is down, and show (or check) the server's rail.
  //    GET /rail is fetched once here and reused for the payee/amount mapping below, so the displayed rail,
  //    the --rail check and the mapping all come from the same server answer (one source of truth).
  let railInfo: RailInfo | undefined;
  let railInfoFetched = false;
  if (options.healthCheck !== false) {
    const apiUrl = options.apiUrl.replace(/\/+$/, '');
    let healthRail: string | undefined;
    try {
      const health = await getHealth(apiUrl);
      healthRail = typeof health.rail === 'string' && health.rail !== '' ? health.rail : undefined;
    } catch (err) {
      return fail(err);
    }
    railInfo = await getRail(apiUrl); // best-effort: undefined on servers without /rail
    railInfoFetched = true;
    if (railInfo && healthRail !== undefined && railInfo.rail !== healthRail) {
      return fail(new Error(`rail_inconsistent: GET /health reports rail=${healthRail} but GET /rail reports rail=${railInfo.rail}`));
    }
    const rail = railInfo?.rail ?? healthRail ?? 'unknown';
    const expectedRail = options.expectedRail;
    step('health', `server: ${apiUrl} rail=${rail}`, {
      apiUrl,
      rail,
      ...(expectedRail !== undefined ? { expectedRail } : {}),
    });
    if (expectedRail !== undefined && rail !== expectedRail) {
      return fail(
        new Error(`rail_mismatch: server ${apiUrl} runs rail=${rail} but --rail ${expectedRail} was expected; restart the API with RAIL=${expectedRail} or drop --rail`),
      );
    }
  }

  // 1. Task → quote.
  if (options.scenario !== undefined && !isScenarioName(options.scenario)) {
    return fail(new Error(`unknown_scenario: ${String(options.scenario)}`));
  }
  const task = options.scenario ? SCENARIOS[options.scenario].task : options.task?.trim();
  if (!task) return fail(new Error('missing_task: pass a task, --task, or --scenario'));
  ctx.task = task;
  step('task', options.scenario ? `scenario "${options.scenario}": ${task}` : task, { task, scenario: options.scenario });

  let quote: Quote;
  try {
    quote = await planner.plan(task, { agentId: options.agentId, currency: 'USD' });
  } catch (err) {
    return fail(err);
  }
  ctx.quote = quote;
  step('quote', `${planner.name} quoted ${quote.amount} ${quote.currency} to ${quote.payee} (${quote.purpose})`, {
    planner: planner.name,
    quote,
  });

  let payee = quote.payee;
  let currency = quote.currency;
  let amount = quote.amount;
  try {
    if (!railInfoFetched) railInfo = await getRail(options.apiUrl); // health check skipped: fetch once now
    if (railInfo) {
      const mappedPayee = railInfo.payees[quote.payee] ?? quote.payee;
      payee = mappedPayee;
      currency = railInfo.currency;
      if (railInfo.amountScale !== 1) {
        amount = Math.round(quote.amount * railInfo.amountScale * 1e6) / 1e6;
      }
      const mappingChanged =
        mappedPayee !== quote.payee ||
        currency.toUpperCase() !== quote.currency.toUpperCase() ||
        amount !== quote.amount;
      if (mappingChanged) {
        step(
          'rail',
          `mapped payee ${quote.payee} → ${payee}, ${quote.amount} ${quote.currency} → ${amount} ${currency}`,
          {
            logicalPayee: quote.payee,
            payee,
            quoteAmount: quote.amount,
            quoteCurrency: quote.currency,
            amount,
            currency,
            amountScale: railInfo.amountScale,
          },
        );
      }
    }
  } catch (err) {
    return fail(err);
  }

  // 2. Submit the intent. The id is fixed once per run and every retry resends the identical
  //    body, so the server replays the stored outcome instead of paying twice (F14). createdAt
  //    is left to the server clock (it is for the record only); if an earlier attempt was
  //    recorded with another server timestamp the retry gets 409 intent_conflict, which (like
  //    in_progress) means "already submitted": the outcome is read from the ledger.
  const body = {
    agentId: options.agentId,
    payee,
    amount,
    currency,
    purpose: quote.purpose,
    id: options.intentId ?? `pi_${randomUUID()}`,
  };
  const intentId = body.id;
  ctx.intentId = intentId;
  const attempts = Math.max(1, Math.floor(options.submitAttempts ?? 3));
  let created: Awaited<ReturnType<typeof postIntent>> | undefined;
  let mayHaveReached = false;
  step('submit_intent', `POST ${options.apiUrl.replace(/\/+$/, '')}/intents as ${options.agentId}`, {
    agentId: options.agentId,
  });
  for (let attempt = 1; created === undefined; attempt++) {
    try {
      created = await postIntent(options.apiUrl, body, options.submitTimeoutMs);
    } catch (err) {
      // An earlier attempt may still be running on the server: read the outcome from the ledger.
      if (
        mayHaveReached &&
        err instanceof ApiClientError &&
        err.status === 409 &&
        (err.message.startsWith('in_progress') || err.message.startsWith('intent_conflict'))
      ) {
        step('intent_result', `${err.message}; reading the outcome from the ledger`, { httpStatus: 409 });
        break;
      }
      if (!(err instanceof ApiClientError && err.retryable) || attempt >= attempts) return fail(err);
      mayHaveReached = true;
      step('submit_retry', `attempt ${attempt}/${attempts} failed (${err.message}); resending intent ${intentId}`, {
        attempt,
        attempts,
        error: err.message,
      });
      await sleep(options.submitRetryDelayMs ?? 500);
    }
  }
  if (created) {
    step('intent_result', `${created.status}: ${created.error ?? created.decision.reason}`, {
      apiStatus: created.status,
      reason: created.decision.reason,
    });
    const immediate = fromPayment(created);
    if (immediate === 'await_receipt') return awaitReceiptSettlement(intentId);
    if (immediate) return immediate;
  }

  // 3. needs_approval: wait for a human (or simulate one).
  step(
    'await_approval',
    !created
      ? `waiting for the outcome of intent ${intentId} (submitted by an earlier attempt; timeout ${timeoutMs}ms, poll ${pollMs}ms)`
      : options.autoApproveAs
      ? `waiting for human approval (simulated by --auto-approve-as "${options.autoApproveAs}")`
      : `waiting for human approval: POST /intents/${intentId}/approve (timeout ${timeoutMs}ms, poll ${pollMs}ms)`,
    { timeoutMs, pollMs, autoApproveAs: options.autoApproveAs },
  );

  const deadline = Date.now() + timeoutMs;

  if (options.autoApproveAs && created) {
    if (options.approveDelayMs) await sleep(options.approveDelayMs);
    step('auto_approve', `simulated human "${options.autoApproveAs}" calls POST /intents/${intentId}/approve`, {
      approver: options.autoApproveAs,
    });
    try {
      const approved = await postApprove(options.apiUrl, intentId, options.autoApproveAs);
      step('approve_result', `${approved.status}: ${approved.error ?? approved.decision.reason}`, {
        apiStatus: approved.status,
      });
      const done = fromPayment(approved);
      if (done === 'await_receipt') return awaitReceiptSettlement(intentId);
      if (done) return done;
    } catch (err) {
      // 409 = someone else decided first; fall through and read the outcome from the ledger.
      if (!(err instanceof ApiClientError && err.status === 409)) return fail(err);
      step('approve_result', `approve refused (${err.message}); reading outcome from the ledger`, { httpStatus: 409 });
    }
  }

  let last: string | undefined;
  for (;;) {
    let entry: LedgerEntry | undefined;
    try {
      entry = (await getLedger(options.apiUrl)).entries.find((e) => e.intent.id === intentId);
    } catch (err) {
      return fail(err);
    }
    const outcome = entry ? entryOutcome(entry) : 'pending';
    if (outcome !== last) {
      step('poll', `ledger status: ${outcome}`, { ledgerStatus: outcome });
      last = outcome;
    }
    if (entry && outcome !== 'pending') {
      if (outcome === 'paid' && needsReceiptWait(entry.receipt)) {
        return awaitReceiptSettlement(intentId);
      }
      return finish(outcome, { receipt: entry.receipt, reason: entry.decision?.reason });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return finish('approval_timeout', { reason: `no human decision within ${timeoutMs}ms; intent is still needs_approval` });
    }
    await sleep(Math.min(pollMs, remaining));
  }
}
