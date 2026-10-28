import type { LedgerEntry, PaymentResult, Receipt } from '@agent-pay/core';
import { ApiClientError, getLedger, postApprove, postIntent } from './client.ts';
import { createPlanner, type Planner, type Quote } from './planner.ts';
import { SCENARIOS, isScenarioName, type ScenarioName } from './scenarios.ts';

/** Final outcome. `error` = the agent could not finish (bad input, planner error, API unreachable/HTTP error). */
export type AgentFinalStatus = 'paid' | 'rejected' | 'approval_timeout' | 'failed' | 'error';

/** Step names, in the order they can appear. */
export type AgentStep =
  | 'task'
  | 'quote'
  | 'submit_intent'
  | 'intent_result'
  | 'await_approval'
  | 'auto_approve'
  | 'approve_result'
  | 'poll'
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
  failed: 1,
  error: 1,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Maps a ledger entry to a final status, or 'pending' while undecided or mid-payment. */
export function entryOutcome(entry: LedgerEntry): Exclude<AgentFinalStatus, 'approval_timeout' | 'error'> | 'pending' {
  if (entry.paymentStatus === 'paid') return 'paid';
  if (entry.paymentStatus === 'failed') return 'failed';
  if (entry.decision?.status === 'rejected') return 'rejected';
  return 'pending';
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
    writeLine(json ? JSON.stringify(event) : `[${name}] ${message}`);
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

  const fromPayment = (r: PaymentResult): RunAgentResult | undefined => {
    if (r.status === 'paid') return finish('paid', { receipt: r.receipt, reason: r.decision.reason });
    if (r.status === 'rejected') return finish('rejected', { reason: r.decision.reason });
    if (r.status === 'failed') return finish('failed', { receipt: r.receipt, reason: r.error ?? r.decision.reason });
    return undefined; // needs_approval
  };

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

  // 2. Submit the intent.
  let created: Awaited<ReturnType<typeof postIntent>>;
  try {
    step('submit_intent', `POST ${options.apiUrl.replace(/\/+$/, '')}/intents as ${options.agentId}`, {
      agentId: options.agentId,
    });
    created = await postIntent(options.apiUrl, { agentId: options.agentId, ...quote });
  } catch (err) {
    return fail(err);
  }
  ctx.intentId = created.intent.id;
  step('intent_result', `${created.status}: ${created.error ?? created.decision.reason}`, {
    apiStatus: created.status,
    reason: created.decision.reason,
  });
  const immediate = fromPayment(created);
  if (immediate) return immediate;

  // 3. needs_approval: wait for a human (or simulate one).
  const intentId = created.intent.id;
  step(
    'await_approval',
    options.autoApproveAs
      ? `waiting for human approval (simulated by --auto-approve-as "${options.autoApproveAs}")`
      : `waiting for human approval: POST /intents/${intentId}/approve (timeout ${timeoutMs}ms, poll ${pollMs}ms)`,
    { timeoutMs, pollMs, autoApproveAs: options.autoApproveAs },
  );

  const deadline = Date.now() + timeoutMs;

  if (options.autoApproveAs) {
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
      return finish(outcome, { receipt: entry.receipt, reason: entry.decision?.reason });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return finish('approval_timeout', { reason: `no human decision within ${timeoutMs}ms; intent is still needs_approval` });
    }
    await sleep(Math.min(pollMs, remaining));
  }
}
