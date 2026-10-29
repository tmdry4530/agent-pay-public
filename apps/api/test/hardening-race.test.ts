import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Ledger, type LedgerEntry, type PaymentAdapter, type PaymentIntent, type Receipt } from '@agent-pay/core';
import { createMockAdapter, createServer, loadConfig } from '../src/index.ts';

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');

const baseIntent = (over: Record<string, unknown> = {}) => ({
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 80,
  currency: 'USD',
  purpose: 'inference credits',
  ...over,
});

type SlowPayControls = {
  adapter: PaymentAdapter;
  payCalls: { n: number };
  waitUntilPayEntered: () => Promise<void>;
  releasePay: () => void;
};

function createSlowPayAdapter(now: () => Date): SlowPayControls {
  const payCalls = { n: 0 };
  const inner = createMockAdapter({ now });
  let enteredResolve!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let releasePay!: () => void;
  const payGate = new Promise<void>((resolve) => {
    releasePay = resolve;
  });

  const adapter: PaymentAdapter = {
    rail: inner.rail,
    async pay(intent: PaymentIntent): Promise<Receipt> {
      payCalls.n += 1;
      enteredResolve();
      await payGate;
      return inner.pay(intent);
    },
    ...(inner.refund ? { refund: inner.refund.bind(inner) } : {}),
    ...(inner.status ? { status: inner.status.bind(inner) } : {}),
  };

  return {
    adapter,
    payCalls,
    waitUntilPayEntered: () => enteredPromise,
    releasePay: () => releasePay(),
  };
}

/**
 * approve()/reject() both start with pendingEntry -> ledger.get(). Hold those
 * reads until `parties` callers have observed the entry, so both decisions see
 * needs_approval before either recordDecision (core review F12).
 */
class BarrierLedger extends Ledger {
  #parties = 0;
  #arrived = 0;
  #waiting: Array<() => void> = [];

  arm(parties = 2): void {
    this.#parties = parties;
    this.#arrived = 0;
    this.#waiting = [];
  }

  override async get(intentId: string): Promise<LedgerEntry | undefined> {
    const entry = await super.get(intentId);
    if (this.#parties === 0) return entry;
    this.#arrived += 1;
    if (this.#arrived < this.#parties) {
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
      });
      return entry;
    }
    this.#parties = 0;
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const release of waiting) release();
    return entry;
  }
}

async function startTestServer(
  t: { after: (fn: () => Promise<void>) => void },
  adapter: PaymentAdapter,
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-race-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  const now = () => new Date(FIXED_NOW);
  const ledger = new BarrierLedger({ filePath: config.ledgerPath, now });
  const server: Server = createServer({ ledger, adapter, now });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return { base, ledger };
}

async function readError(res: Response): Promise<{ error: string; message: string }> {
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  const body: unknown = await res.json();
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body));
  const record = body as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ['error', 'message']);
  assert.equal(typeof record.error, 'string');
  assert.equal(typeof record.message, 'string');
  const error = record.error as string;
  const message = record.message as string;
  assert.ok(error.length > 0 && !error.includes(':'));
  assert.ok(message.length > 0);
  return { error, message };
}

function assertConflictError(err: { error: string; message: string }): void {
  assert.ok(
    err.error === 'not_pending' || err.error === 'already_paid',
    `expected not_pending or already_paid, got ${JSON.stringify(err.error)}`,
  );
  assert.ok(err.message.length > 0);
}

async function seedNeedsApproval(base: string, id: string): Promise<void> {
  const res = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id })),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, 'needs_approval');
}

test('R1a: two concurrent approve — one paid, one 409, pay() once', async (t) => {
  const now = () => new Date(FIXED_NOW);
  const slow = createSlowPayAdapter(now);
  const { base, ledger } = await startTestServer(t, slow.adapter);
  await seedNeedsApproval(base, 'pi_race_approve');
  ledger.arm();
  // pay() stays blocked until the winner has entered it, after both gets.
  void slow.waitUntilPayEntered().then(() => {
    slow.releasePay();
  });

  const [r1, r2] = await Promise.all([
    fetch(`${base}/intents/pi_race_approve/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approver: 'alice' }),
    }),
    fetch(`${base}/intents/pi_race_approve/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approver: 'bob' }),
    }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.notEqual(r1.status, r2.status);

  const ok = r1.status === 200 ? r1 : r2;
  const conflict = r1.status === 409 ? r1 : r2;
  const paid = (await ok.json()) as { status: string };
  assert.equal(paid.status, 'paid');
  assertConflictError(await readError(conflict));
  assert.equal(slow.payCalls.n, 1);
});

test('R1b: concurrent approve + reject — one 200, one 409, ledger matches winner', async (t) => {
  const now = () => new Date(FIXED_NOW);
  const slow = createSlowPayAdapter(now);
  const { base, ledger } = await startTestServer(t, slow.adapter);
  await seedNeedsApproval(base, 'pi_race_mix');
  ledger.arm();
  void slow.waitUntilPayEntered().then(() => {
    slow.releasePay();
  });

  const [approveRes, rejectRes] = await Promise.all([
    fetch(`${base}/intents/pi_race_mix/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approver: 'alice' }),
    }),
    fetch(`${base}/intents/pi_race_mix/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approver: 'bob', note: 'no thanks' }),
    }),
  ]);
  const statuses = [approveRes.status, rejectRes.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  const approveWon = approveRes.status === 200;
  const winner = approveWon ? approveRes : rejectRes;
  const loser = approveWon ? rejectRes : approveRes;
  assertConflictError(await readError(loser));

  const winnerBody = (await winner.json()) as { status: string };
  const ledgerRes = await fetch(`${base}/ledger`);
  assert.equal(ledgerRes.status, 200);
  const ledgerBody = (await ledgerRes.json()) as {
    entries: { intent: { id: string }; decision: { status: string }; paymentStatus?: string }[];
  };
  const entry = ledgerBody.entries.find((e) => e.intent.id === 'pi_race_mix');
  assert.ok(entry);
  if (approveWon) {
    assert.equal(winnerBody.status, 'paid');
    assert.equal(slow.payCalls.n, 1);
    assert.equal(entry.decision.status, 'approved');
    assert.equal(entry.paymentStatus, 'paid');
  } else {
    assert.equal(winnerBody.status, 'rejected');
    assert.equal(slow.payCalls.n, 0);
    assert.equal(entry.decision.status, 'rejected');
    assert.equal(entry.paymentStatus, undefined);
  }
});
