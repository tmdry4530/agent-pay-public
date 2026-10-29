import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { PaymentAdapter, PaymentIntent, Receipt } from '@agent-pay/core';
import { createServer, loadConfig } from '@agent-pay/api';
import { runAgent, type AgentEvent } from '../src/index.ts';

const FIXED = new Date('2026-10-28T12:00:00.000Z');
const CLI_PATH = join(import.meta.dirname, '..', 'src', 'cli.ts');

/** Async spawn only: spawnSync would block this process's in-process API server and deadlock. */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

function createPendingAdapter(opts: {
  succeedAfter?: number;
  failAfter?: number;
}): PaymentAdapter {
  let calls = 0;
  return {
    rail: 'mock',
    async pay(intent: PaymentIntent): Promise<Receipt> {
      return {
        intentId: intent.id,
        rail: 'mock',
        externalId: `mock_${intent.id}`,
        status: 'pending',
        at: FIXED.toISOString(),
      };
    },
    async status(receipt: Receipt): Promise<Receipt> {
      calls += 1;
      if (opts.failAfter !== undefined && calls >= opts.failAfter) {
        return { ...receipt, status: 'failed' };
      }
      if (opts.succeedAfter !== undefined && calls >= opts.succeedAfter) {
        return { ...receipt, status: 'succeeded' };
      }
      return { ...receipt, status: 'pending' };
    },
  };
}

async function startPendingApi(
  t: { after: (fn: () => Promise<void>) => void },
  adapter: PaymentAdapter,
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-agent-reconcile-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  const server: Server = createServer({
    ledger: config.ledgerPath,
    adapter,
    now: () => FIXED,
  });
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

test('pending receipt settles to paid with await_receipt and refresh steps', async (t) => {
  const base = await startPendingApi(t, createPendingAdapter({ succeedAfter: 2 }));
  const events: AgentEvent[] = [];
  const result = await runAgent(
    { apiUrl: base, agentId: 'demo-agent', scenario: 'small', pollMs: 20 },
    { emit: (e) => events.push(e), writeLine: () => {} },
  );
  assert.equal(result.status, 'paid');
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt?.status, 'succeeded');
  const steps = events.flatMap((e) => (e.type === 'step' ? [e.step] : []));
  assert.deepEqual(steps, ['health', 'task', 'quote', 'submit_intent', 'intent_result', 'await_receipt', 'refresh']);
  // First refresh is still pending (no event); only the change emits `refresh`.
  const refresh = events.find((e) => e.type === 'step' && e.step === 'refresh');
  assert.equal(refresh?.type === 'step' && refresh.from, 'pending');
  assert.equal(refresh?.type === 'step' && refresh.to, 'succeeded');
  const ledger = (await (await fetch(`${base}/ledger`)).json()) as {
    entries: { receipt?: { status: string }; paymentStatus?: string }[];
    today: { totals: Record<string, Record<string, number>> };
  };
  assert.equal(ledger.entries[0]?.receipt?.status, 'succeeded');
  assert.deepEqual(ledger.today.totals['demo-agent'], { USD: 10 });
});

test('needs-approval + auto-approve with a pending receipt: refresh after approve, paid exit 0', async (t) => {
  const base = await startPendingApi(t, createPendingAdapter({ succeedAfter: 1 }));
  const events: AgentEvent[] = [];
  const result = await runAgent(
    { apiUrl: base, agentId: 'demo-agent', scenario: 'needs-approval', pollMs: 20, autoApproveAs: 'alice' },
    { emit: (e) => events.push(e), writeLine: () => {} },
  );
  assert.equal(result.status, 'paid');
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt?.status, 'succeeded');
  const steps = events.flatMap((e) => (e.type === 'step' ? [e.step] : []));
  assert.deepEqual(steps.slice(-4), ['auto_approve', 'approve_result', 'await_receipt', 'refresh']);
});

test('rail without status(): refresh answers 409 status_unsupported, agent ends receipt_pending exit 3', async (t) => {
  const { status: _omit, ...noStatus } = createPendingAdapter({});
  const base = await startPendingApi(t, noStatus);
  const result = await runAgent(
    { apiUrl: base, agentId: 'demo-agent', scenario: 'small', pollMs: 20 },
    { writeLine: () => {} },
  );
  assert.equal(result.status, 'receipt_pending');
  assert.equal(result.exitCode, 3);
  assert.match(result.reason ?? '', /^status_unsupported:/);
});

test('CLI: pending -> failed exits 1 with a failed NDJSON summary', async (t) => {
  const base = await startPendingApi(t, createPendingAdapter({ failAfter: 2 }));
  const { code, stdout } = await runCli(['--api', base, '--scenario', 'small', '--json', '--poll-ms', '20']);
  assert.equal(code, 1);
  const events = stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(
    events.filter((e) => e.type === 'step' && e.step === 'refresh').map((e) => [e.from, e.to]),
    [['pending', 'failed']],
  );
  const summary = events.at(-1)!;
  assert.equal(summary.type, 'summary');
  assert.equal(summary.status, 'failed');
  assert.equal(summary.exitCode, 1);
  assert.equal((summary.receipt as { status: string }).status, 'failed');
});

test('pending receipt fails on rail: exit 1 and daily total excludes amount', async (t) => {
  const base = await startPendingApi(t, createPendingAdapter({ failAfter: 1 }));
  const result = await runAgent(
    { apiUrl: base, agentId: 'demo-agent', scenario: 'small', pollMs: 20 },
    { writeLine: () => {} },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  const ledger = (await (await fetch(`${base}/ledger`)).json()) as {
    today: { totals: Record<string, Record<string, number>> };
  };
  assert.deepEqual(ledger.today.totals['demo-agent'], {});
});

test('receipt still pending at timeout: receipt_pending exit 3', async (t) => {
  const base = await startPendingApi(t, createPendingAdapter({ succeedAfter: 99 }));
  const result = await runAgent(
    { apiUrl: base, agentId: 'demo-agent', scenario: 'small', pollMs: 20, timeoutMs: 80 },
    { writeLine: () => {} },
  );
  assert.equal(result.status, 'receipt_pending');
  assert.equal(result.exitCode, 3);
  assert.match(result.reason ?? '', /receipt still pending after 80ms/);
});

test('--json NDJSON lines parse and last is summary', async (t) => {
  const base = await startPendingApi(t, createPendingAdapter({ succeedAfter: 1 }));
  const lines: string[] = [];
  await runAgent(
    { apiUrl: base, agentId: 'demo-agent', scenario: 'small', pollMs: 20, json: true },
    { writeLine: (l) => lines.push(l) },
  );
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
  const last = JSON.parse(lines.at(-1)!) as { type: string; status: string; exitCode: number };
  assert.equal(last.type, 'summary');
  assert.equal(last.status, 'paid');
  assert.equal(last.exitCode, 0);
  assert.ok(lines.some((l) => (JSON.parse(l) as { step?: string }).step === 'refresh'));
});
