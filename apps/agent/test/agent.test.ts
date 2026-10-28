import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type Server } from 'node:http';
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
  assert.deepEqual(steps, ['health', 'task', 'quote', 'submit_intent', 'intent_result']);
  assert.equal(lines[0], `server: ${base} rail=mock`);
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
  assert.deepEqual(steps, ['health', 'task', 'quote', 'submit_intent', 'intent_result', 'await_approval', 'auto_approve', 'approve_result']);
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

test('API down: health check fails fast with api_unreachable (exit 1), never throws', async () => {
  const started = Date.now();
  const { result, steps } = await run({ apiUrl: `http://127.0.0.1:${await closedPort()}`, scenario: 'small', timeoutMs: 60_000 });
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /^api_unreachable: GET http:\/\/127\.0\.0\.1:\d+\/health failed/);
  assert.deepEqual(steps, ['error']);
  assert.ok(Date.now() - started < 5_000, 'must not wait for --timeout-ms');
});

test('API down mid-run (health check skipped): submit fails with fetch_failed (exit 1)', async () => {
  const { result, steps } = await run({ apiUrl: `http://127.0.0.1:${await closedPort()}`, scenario: 'small', healthCheck: false });
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /^fetch_failed/);
  assert.deepEqual(steps, ['task', 'quote', 'submit_intent', 'error']);
});

test('health: step carries the server rail; --rail match proceeds, mismatch exits 1 before any intent', async (t) => {
  const base = await startApi(t);
  const ok = await run({ apiUrl: base, scenario: 'small', expectedRail: 'mock' });
  assert.equal(ok.result.status, 'paid');
  const health = ok.events.find((e) => e.type === 'step' && e.step === 'health');
  assert.equal(health?.type === 'step' && health.rail, 'mock');
  assert.equal(health?.type === 'step' && health.expectedRail, 'mock');

  const mismatch = await run({ apiUrl: base, scenario: 'small', expectedRail: 'paypal' });
  assert.equal(mismatch.result.status, 'error');
  assert.equal(mismatch.result.exitCode, 1);
  assert.match(mismatch.result.error ?? '', /^rail_mismatch: server http:\/\/127\.0\.0\.1:\d+ runs rail=mock but --rail paypal was expected/);
  assert.deepEqual(mismatch.steps, ['health', 'error']);
  const ledger = (await (await fetch(`${base}/ledger`)).json()) as { entries: unknown[] };
  assert.equal(ledger.entries.length, 1, 'only the first (matching) run created an intent');
});

test('health: non-2xx GET /health → health_check_failed (exit 1)', async (t) => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unavailable' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const { result, steps } = await run({ apiUrl: base, scenario: 'small' });
  assert.equal(result.status, 'error');
  assert.equal(result.exitCode, 1);
  assert.match(result.error ?? '', /^health_check_failed: GET .*\/health -> HTTP 503 \(unavailable\)/);
  assert.deepEqual(steps, ['error']);
});

/** Fake API answering GET /health and GET /rail with fixed bodies (null → 404); counts hits per path. */
async function startFakeRailApi(t: { after: (fn: () => Promise<void>) => void }, health: unknown, rail: unknown) {
  const hits: Record<string, number> = {};
  const server = createHttpServer((req, res) => {
    const path = req.url ?? '';
    hits[path] = (hits[path] ?? 0) + 1;
    const body = path === '/health' ? health : path === '/rail' ? rail : null;
    res.writeHead(body === null ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'not_found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, hits };
}

test('health + /rail: displayed rail and --rail check come from one GET /rail, fetched once', async (t) => {
  const railBody = { rail: 'near', currency: 'NEAR', amountScale: 0.01, payees: { 'openai-api': 'demo-merchant.testnet' } };
  const { base, hits } = await startFakeRailApi(t, { ok: true, rail: 'near' }, railBody);
  const mismatch = await run({ apiUrl: base, scenario: 'small', expectedRail: 'paypal' });
  assert.equal(mismatch.result.exitCode, 1);
  assert.equal(mismatch.lines[0], `server: ${base} rail=near`);
  assert.match(mismatch.result.error ?? '', /^rail_mismatch: .* runs rail=near but --rail paypal was expected/);
  assert.deepEqual(mismatch.steps, ['health', 'error']);
  assert.deepEqual(hits, { '/health': 1, '/rail': 1 });

  // /health without a rail (older server) but /rail present: /rail is the source of truth.
  const noHealthRail = await startFakeRailApi(t, { ok: true }, railBody);
  const ok = await run({ apiUrl: noHealthRail.base, task: 'buy 1M tokens from openai-api', expectedRail: 'near' });
  assert.equal(ok.lines[0], `server: ${noHealthRail.base} rail=near`);
  const rail = ok.events.find((e) => e.type === 'step' && e.step === 'rail');
  assert.equal(rail?.type === 'step' && rail.payee, 'demo-merchant.testnet', 'mapping reuses the preflight /rail answer');
  assert.equal(noHealthRail.hits['/rail'], 1, 'GET /rail is not fetched a second time for the mapping');
});

test('health + /rail: server without /rail falls back to /health.rail; disagreement is rail_inconsistent (exit 1)', async (t) => {
  const legacy = await startFakeRailApi(t, { ok: true, rail: 'mock' }, null);
  const r = await run({ apiUrl: legacy.base, scenario: 'small', expectedRail: 'paypal' });
  assert.equal(r.lines[0], `server: ${legacy.base} rail=mock`);
  assert.match(r.result.error ?? '', /^rail_mismatch: .* runs rail=mock but --rail paypal was expected/);

  const split = await startFakeRailApi(t, { ok: true, rail: 'mock' }, { rail: 'near', currency: 'NEAR', amountScale: 0.01, payees: {} });
  const bad = await run({ apiUrl: split.base, scenario: 'small' });
  assert.equal(bad.result.status, 'error');
  assert.equal(bad.result.exitCode, 1);
  assert.match(bad.result.error ?? '', /^rail_inconsistent: GET \/health reports rail=mock but GET \/rail reports rail=near/);
  assert.deepEqual(bad.steps, ['error']);
});

test('planner error: unknown task → error (exit 1) before any API call', async () => {
  const { result, steps } = await run({ apiUrl: 'http://127.0.0.1:1', task: 'send flowers to mom', healthCheck: false });
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
    ['health', 'task', 'quote', 'submit_intent', 'intent_result', 'summary'],
  );
  for (const e of events.slice(0, -1)) {
    assert.equal(e.type, 'step');
    assert.equal(typeof e.ts, 'string');
    assert.equal(typeof e.message, 'string');
  }
  assert.equal(events[0]!.rail, 'mock');
  assert.equal(events[0]!.apiUrl, base);
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
  assert.match(down.stdout, /^\[error\] api_unreachable: GET http:\/\/127\.0\.0\.1:\d+\/health failed/m);
  assert.doesNotMatch(down.stdout, /\[task\]/);
  assert.match(down.stdout, /^Done: error \(exit 1\)$/m);

  const badRail = await runCli(['--rail', ' ', '--scenario', 'small']);
  assert.equal(badRail.code, 1);
  assert.match(badRail.stderr, /invalid --rail/);

  const bad = await runCli(['--scenario', 'huge']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /invalid scenario/);
});

test('CLI: health line, --rail mismatch exit 1, API down --json is valid NDJSON and fast', async (t) => {
  const base = await startApi(t);

  const healthy = await runCli(['--api', base, '--rail', 'mock', '--scenario', 'small']);
  assert.equal(healthy.code, 0, healthy.stderr);
  assert.equal(healthy.stdout.split('\n')[0], `server: ${base} rail=mock`);

  const mismatch = await runCli(['--api', base, '--rail', 'near', '--scenario', 'small']);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stdout, /^server: .* rail=mock$/m);
  assert.match(mismatch.stdout, /^\[error\] rail_mismatch: .*rail=mock but --rail near was expected/m);
  assert.doesNotMatch(mismatch.stdout, /\[submit_intent\]/);

  const mismatchJson = await runCli(['--api', base, '--rail', 'near', '--scenario', 'small', '--json']);
  assert.equal(mismatchJson.code, 1);
  const mj = mismatchJson.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(mj.map((e) => (e.type === 'step' ? e.step : e.type)), ['health', 'error', 'summary']);
  assert.equal(mj[0]!.rail, 'mock');
  assert.equal(mj[0]!.expectedRail, 'near');

  const started = Date.now();
  const down = await runCli(['--api', `http://127.0.0.1:${await closedPort()}`, '--scenario', 'small', '--json']);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(down.code, 1);
  const dj = down.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(dj.map((e) => (e.type === 'step' ? e.step : e.type)), ['error', 'summary']);
  assert.equal(dj[1]!.status, 'error');
  assert.equal(dj[1]!.exitCode, 1);
  assert.match(String(dj[1]!.error), /^api_unreachable/);
});
