import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createMockAdapter, createServer, loadConfig } from '@agent-pay/api';
import { runAgent, type AgentEvent, type RunAgentOptions } from '../src/index.ts';

const CLI_PATH = join(import.meta.dirname, '..', 'src', 'cli.ts');

/** apps/api on port 0 with a temp LEDGER_PATH and the mock rail (RAIL=mock). */
async function startApi(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-agent-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0', RAIL: 'mock' });
  assert.equal(config.rail, 'mock');
  const server: Server = createServer({ ledger: config.ledgerPath, adapter: createMockAdapter() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return base;
}

/** In-process run with captured events and output lines. */
async function run(opts: Partial<RunAgentOptions> & { apiUrl: string }) {
  const events: AgentEvent[] = [];
  const lines: string[] = [];
  const result = await runAgent(
    { agentId: 'demo-agent', pollMs: 20, ...opts },
    { emit: (e) => events.push(e), writeLine: (l) => lines.push(l) },
  );
  return { result, events, steps: events.flatMap((e) => (e.type === 'step' ? [e.step] : [])), lines };
}

/** Async spawn (spawnSync would block the in-process API server and deadlock). */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function ledgerEntry(base: string, id: string) {
  const body = (await (await fetch(`${base}/ledger`)).json()) as {
    entries: { intent: { id: string; amount: number }; decision?: { status: string; reason: string }; paymentStatus?: string }[];
  };
  return body.entries.find((e) => e.intent.id === id);
}

test('scenario small: planned 10 USD to openai-api, auto-approved and paid (exit 0)', async (t) => {
  const base = await startApi(t);
  const { result, steps, lines } = await run({ apiUrl: base, scenario: 'small' });
  assert.equal(result.status, 'paid');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.quote && { payee: result.quote.payee, amount: result.quote.amount }, { payee: 'openai-api', amount: 10 });
  assert.equal(result.receipt?.status, 'succeeded');
  assert.deepEqual(steps, ['task', 'quote', 'submit_intent', 'intent_result']);
  assert.ok(lines.some((l) => l.startsWith('Done: paid (exit 0)')));
  assert.equal((await ledgerEntry(base, result.intentId!))?.paymentStatus, 'paid');
});

test('scenario over-limit: 150 USD rejected by perTxMax (exit 2)', async (t) => {
  const base = await startApi(t);
  const { result } = await run({ apiUrl: base, scenario: 'over-limit' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.exitCode, 2);
  assert.equal(result.quote?.amount, 150);
  assert.match(result.reason ?? '', /^per_tx_limit_exceeded/);
});

test('over dailyMax: third 75 USD approval-tier intent is rejected by daily_limit_exceeded', async (t) => {
  const base = await startApi(t);
  for (let i = 0; i < 2; i++) {
    const { result } = await run({ apiUrl: base, scenario: 'needs-approval', autoApproveAs: 'ops' });
    assert.equal(result.status, 'paid');
  }
  const { result } = await run({ apiUrl: base, task: 'buy 7.5M tokens of GPT inference', autoApproveAs: 'ops' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.exitCode, 2);
  assert.match(result.reason ?? '', /^daily_limit_exceeded/);
});

test('scenario needs-approval + --auto-approve-as: needs_approval → approved by human → paid (exit 0)', async (t) => {
  const base = await startApi(t);
  const { result, steps, events } = await run({ apiUrl: base, scenario: 'needs-approval', autoApproveAs: 'demo-human' });
  assert.equal(result.status, 'paid');
  assert.equal(result.exitCode, 0);
  assert.equal(result.quote?.amount, 75);
  assert.deepEqual(steps, ['task', 'quote', 'submit_intent', 'intent_result', 'await_approval', 'auto_approve', 'approve_result']);
  const intentResult = events.find((e) => e.type === 'step' && e.step === 'intent_result');
  assert.equal(intentResult?.type === 'step' && intentResult.apiStatus, 'needs_approval');
  assert.match(result.reason ?? '', /approved by "demo-human"/);
  const entry = await ledgerEntry(base, result.intentId!);
  assert.equal(entry?.paymentStatus, 'paid');
  assert.match(entry?.decision?.reason ?? '', /approved by "demo-human"/);
});

test('needs-approval: agent polls the ledger and sees an external human approval', async (t) => {
  const base = await startApi(t);
  let intentId: string | undefined;
  const pending = runAgent(
    { apiUrl: base, agentId: 'demo-agent', scenario: 'needs-approval', timeoutMs: 10_000, pollMs: 20 },
    {
      writeLine: () => {},
      emit: (e) => {
        if (e.type === 'step' && e.step === 'await_approval') intentId = e.intentId;
      },
    },
  );
  while (!intentId) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 60)); // let at least one poll see "pending"
  const res = await fetch(`${base}/intents/${intentId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approver: 'alice' }),
  });
  assert.equal(res.status, 200);
  const result = await pending;
  assert.equal(result.status, 'paid');
  assert.equal(result.exitCode, 0);
  assert.match(result.reason ?? '', /approved by "alice"/);
});

test('needs-approval: external human rejection → rejected (exit 2)', async (t) => {
  const base = await startApi(t);
  let intentId: string | undefined;
  const pending = runAgent(
    { apiUrl: base, agentId: 'demo-agent', scenario: 'needs-approval', timeoutMs: 10_000, pollMs: 20 },
    { writeLine: () => {}, emit: (e) => void (e.type === 'step' && e.step === 'await_approval' && (intentId = e.intentId)) },
  );
  while (!intentId) await new Promise((r) => setTimeout(r, 10));
  await fetch(`${base}/intents/${intentId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approver: 'bob', note: 'not today' }),
  });
  const result = await pending;
  assert.equal(result.status, 'rejected');
  assert.equal(result.exitCode, 2);
  assert.match(result.reason ?? '', /rejected by "bob"/);
});

test('approval timeout: no human decision → approval_timeout (exit 3), intent stays needs_approval', async (t) => {
  const base = await startApi(t);
  const started = Date.now();
  const { result, steps } = await run({ apiUrl: base, scenario: 'needs-approval', timeoutMs: 200, pollMs: 30 });
  assert.equal(result.status, 'approval_timeout');
  assert.equal(result.exitCode, 3);
  assert.ok(Date.now() - started >= 200);
  assert.ok(steps.includes('await_approval') && steps.includes('poll'));
  assert.equal((await ledgerEntry(base, result.intentId!))?.decision?.status, 'needs_approval');
});

test('API down: error (exit 1), never throws', async () => {
  const { result, steps } = await run({ apiUrl: `http://127.0.0.1:${await closedPort()}`, scenario: 'small' });
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /^fetch_failed/);
  assert.deepEqual(steps, ['task', 'quote', 'submit_intent', 'error']);
});

test('planner error: unknown task → error (exit 1) before any API call', async () => {
  const { result, steps } = await run({ apiUrl: 'http://127.0.0.1:1', task: 'send flowers to mom' });
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /^no_match/);
  assert.deepEqual(steps, ['task', 'error']);
});

test('--agent-id without a policy is rejected by the API policy check (exit 2)', async (t) => {
  const base = await startApi(t);
  const { result } = await run({ apiUrl: base, agentId: 'other-agent', scenario: 'small' });
  // The seed policy covers demo-agent only; core rejects other agents rather than erroring.
  assert.equal(result.status, 'rejected');
  assert.equal(result.exitCode, 2);
});

test('CLI --json: NDJSON steps + final summary; exit codes 0 / 2 / 3', async (t) => {
  const base = await startApi(t);

  const small = await runCli(['--api', base, '--scenario', 'small', '--json']);
  assert.equal(small.code, 0, small.stderr);
  const events = small.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(
    events.map((e) => e.type === 'step' ? e.step : e.type),
    ['task', 'quote', 'submit_intent', 'intent_result', 'summary'],
  );
  for (const e of events.slice(0, -1)) {
    assert.equal(e.type, 'step');
    assert.equal(typeof e.ts, 'string');
    assert.equal(typeof e.message, 'string');
  }
  const summary = events.at(-1)!;
  assert.deepEqual(Object.keys(summary).sort(), ['exitCode', 'intentId', 'quote', 'reason', 'receipt', 'scenario', 'status', 'task', 'ts', 'type']);
  assert.equal(summary.status, 'paid');
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(summary.quote, { payee: 'openai-api', amount: 10, currency: 'USD', purpose: (summary.quote as { purpose: string }).purpose });
  assert.equal((summary.receipt as { rail: string }).rail, 'mock');

  const over = await runCli(['--api', base, '--scenario', 'over-limit', '--json']);
  assert.equal(over.code, 2);
  assert.equal(JSON.parse(over.stdout.trim().split('\n').at(-1)!).status, 'rejected');

  const approved = await runCli(['--api', base, '--scenario', 'needs-approval', '--auto-approve-as', 'demo-human', '--approve-delay-ms', '0', '--json']);
  assert.equal(approved.code, 0, approved.stderr);
  assert.ok(approved.stdout.includes('"step":"await_approval"'));

  const timeout = await runCli(['--api', base, '--scenario', 'needs-approval', '--timeout-ms', '100', '--poll-ms', '20', '--json']);
  assert.equal(timeout.code, 3);
  assert.equal(JSON.parse(timeout.stdout.trim().split('\n').at(-1)!).status, 'approval_timeout');
});

test('CLI human output, API down exit 1, bad args exit 1', async () => {
  const down = await runCli(['--api', `http://127.0.0.1:${await closedPort()}`, 'buy', '1M', 'tokens', 'of', 'GPT']);
  assert.equal(down.code, 1);
  assert.match(down.stdout, /^\[task\] buy 1M tokens of GPT$/m);
  assert.match(down.stdout, /^Done: error \(exit 1\)$/m);

  const bad = await runCli(['--scenario', 'huge']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /invalid scenario/);
});
