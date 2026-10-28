import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger,
  LedgerError,
  evaluate,
  utcDay,
  type PaymentIntent,
  type Policy,
  type Receipt,
} from '../src/index.ts';

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const fixedClock = (iso: string) => () => new Date(iso);

const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: 'pi-1',
  agentId: 'agent-1',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  createdAt: '2026-10-28T10:00:00.000Z',
  ...over,
});

const receipt = (intentId: string, over: Partial<Receipt> = {}): Receipt => ({
  intentId,
  rail: 'mock',
  externalId: `mock-${intentId}`,
  status: 'succeeded',
  at: '2026-10-28T10:00:01.000Z',
  ...over,
});

async function recordPaid(ledger: Ledger, i: PaymentIntent): Promise<void> {
  await ledger.recordIntent(i);
  await ledger.recordDecision(i.id, { status: 'approved', reason: 'within_policy: test' });
  await ledger.recordPayment(i.id, 'paid');
  await ledger.recordReceipt(i.id, receipt(i.id));
}

test('utcDay buckets by UTC date', () => {
  assert.equal(utcDay('2026-10-28T23:59:59.999Z'), '2026-10-28');
  assert.equal(utcDay('2026-10-29T08:30:00+09:00'), '2026-10-28'); // KST morning is previous UTC day
  assert.equal(utcDay(new Date('2026-10-29T00:00:00Z')), '2026-10-29');
  assert.throws(() => utcDay('not-a-date'), LedgerError);
});

test('missing file (and missing parent dirs) is created on load', async (t) => {
  const dir = await tempDir(t);
  const filePath = join(dir, 'nested', 'deeper', 'ledger.json');
  const ledger = new Ledger({ filePath });
  const file = await ledger.load();
  assert.deepEqual(file, { version: 1, entries: [] });
  assert.ok((await stat(filePath)).isFile());
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { version: 1, entries: [] });
  assert.equal(await ledger.dailyTotal('agent-1'), 0);
});

test('round-trip intent -> decision -> payment -> receipt survives a new instance', async (t) => {
  const dir = await tempDir(t);
  const filePath = join(dir, 'ledger.json');
  const now = fixedClock('2026-10-28T10:00:00.500Z');
  const a = new Ledger({ filePath, now });
  const i = intent();
  const r = receipt(i.id, { rail: 'paypal', externalId: 'ORDER-123' });
  await a.recordIntent(i);
  await a.recordDecision(i.id, { status: 'approved', reason: 'within_policy: ok' });
  await a.recordPayment(i.id, 'paid');
  const last = await a.recordReceipt(i.id, r);

  const b = new Ledger({ filePath, now });
  const entry = await b.get(i.id);
  assert.deepEqual(entry, last);
  assert.deepEqual(entry, {
    intent: i,
    decision: { status: 'approved', reason: 'within_policy: ok' },
    decisions: [{ status: 'approved', reason: 'within_policy: ok', at: '2026-10-28T10:00:00.500Z' }],
    paymentStatus: 'paid',
    receipt: r,
    recordedAt: '2026-10-28T10:00:00.500Z',
    updatedAt: '2026-10-28T10:00:00.500Z',
  });
  assert.equal((await b.list()).length, 1);
  assert.equal(await b.get('nope'), undefined);
});

test('enforces lifecycle order', async (t) => {
  const dir = await tempDir(t);
  const ledger = new Ledger({ filePath: join(dir, 'ledger.json') });
  await assert.rejects(ledger.recordDecision('x', { status: 'approved', reason: 'r' }), /not found/);

  await ledger.recordIntent(intent());
  await assert.rejects(ledger.recordIntent(intent()), /already recorded/);
  await assert.rejects(ledger.recordPayment('pi-1', 'paid'), /decision is missing/);
  await assert.rejects(ledger.recordReceipt('pi-1', receipt('pi-1')), /no payment/);

  await ledger.recordDecision('pi-1', { status: 'needs_approval', reason: 'approval_required: r' });
  await assert.rejects(ledger.recordPayment('pi-1', 'paid'), /decision is needs_approval/);
  // human approves -> decision can be replaced before payment
  await ledger.recordDecision('pi-1', { status: 'approved', reason: 'within_policy: human' });
  await ledger.recordPayment('pi-1', 'paid');
  await assert.rejects(ledger.recordPayment('pi-1', 'paid'), /already has payment/);
  await assert.rejects(ledger.recordDecision('pi-1', { status: 'rejected', reason: 'r' }), /decision is final/);
  await assert.rejects(ledger.recordReceipt('pi-1', receipt('other')), /does not match/);
  await ledger.recordReceipt('pi-1', receipt('pi-1'));

  await ledger.recordIntent(intent({ id: 'pi-2' }));
  await ledger.recordDecision('pi-2', { status: 'rejected', reason: 'payee_not_allowed: x' });
  await assert.rejects(ledger.recordPayment('pi-2', 'paid'), LedgerError);
});

test('daily totals split at the UTC day boundary; default day uses injected clock', async (t) => {
  const dir = await tempDir(t);
  const filePath = join(dir, 'ledger.json');
  let nowIso = '2026-10-28T23:59:59.000Z';
  const ledger = new Ledger({ filePath, now: () => new Date(nowIso) });

  await recordPaid(ledger, intent({ id: 'late', amount: 30, createdAt: '2026-10-28T23:59:59.000Z' }));
  await recordPaid(ledger, intent({ id: 'early', amount: 7, createdAt: '2026-10-29T00:00:01.000Z' }));
  await recordPaid(ledger, intent({ id: 'other-agent', agentId: 'agent-2', amount: 99, createdAt: '2026-10-28T12:00:00.000Z' }));

  assert.equal(await ledger.dailyTotal('agent-1'), 30); // clock = Oct 28 UTC
  nowIso = '2026-10-29T00:00:00.000Z';
  assert.equal(await ledger.dailyTotal('agent-1'), 7); // clock moved past midnight UTC
  assert.equal(await ledger.dailyTotal('agent-1', '2026-10-28'), 30);
  assert.equal(await ledger.dailyTotal('agent-1', new Date('2026-10-29T15:00:00Z')), 7);
  assert.equal(await ledger.dailyTotal('agent-2', '2026-10-28'), 99);
  assert.equal(await ledger.dailyTotal('agent-1', '2026-10-30'), 0);
});

test('only approved, non-failed entries count toward the daily total', async (t) => {
  const dir = await tempDir(t);
  const ledger = new Ledger({ filePath: join(dir, 'ledger.json'), now: fixedClock('2026-10-28T12:00:00Z') });

  await recordPaid(ledger, intent({ id: 'paid', amount: 10 }));

  await ledger.recordIntent(intent({ id: 'approved-unpaid', amount: 5 }));
  await ledger.recordDecision('approved-unpaid', { status: 'approved', reason: 'within_policy: r' });

  await ledger.recordIntent(intent({ id: 'rejected', amount: 1000 }));
  await ledger.recordDecision('rejected', { status: 'rejected', reason: 'per_tx_limit_exceeded: r' });

  await ledger.recordIntent(intent({ id: 'pending-approval', amount: 60 }));
  await ledger.recordDecision('pending-approval', { status: 'needs_approval', reason: 'approval_required: r' });

  await ledger.recordIntent(intent({ id: 'no-decision', amount: 3 }));

  await ledger.recordIntent(intent({ id: 'pay-failed', amount: 20 }));
  await ledger.recordDecision('pay-failed', { status: 'approved', reason: 'within_policy: r' });
  await ledger.recordPayment('pay-failed', 'failed');

  await ledger.recordIntent(intent({ id: 'receipt-failed', amount: 40 }));
  await ledger.recordDecision('receipt-failed', { status: 'approved', reason: 'within_policy: r' });
  await ledger.recordPayment('receipt-failed', 'paid');
  await ledger.recordReceipt('receipt-failed', receipt('receipt-failed', { status: 'failed' }));

  assert.equal(await ledger.dailyTotal('agent-1'), 15); // paid 10 + approved-unpaid 5

  // needs_approval -> approved later starts counting
  await ledger.recordDecision('pending-approval', { status: 'approved', reason: 'within_policy: human' });
  assert.equal(await ledger.dailyTotal('agent-1'), 75);
});

test('atomic writes leave no temp files behind', async (t) => {
  const dir = await tempDir(t);
  const ledger = new Ledger({ filePath: join(dir, 'ledger.json') });
  await Promise.all(
    Array.from({ length: 10 }, (_, n) => ledger.recordIntent(intent({ id: `pi-${n}` }))),
  );
  assert.deepEqual(await readdir(dir), ['ledger.json']);
  assert.equal((await ledger.list()).length, 10); // serialized writes: none lost
});

test('rejects a corrupt / unknown-format file instead of overwriting it', async (t) => {
  const dir = await tempDir(t);
  const filePath = join(dir, 'ledger.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(filePath, JSON.stringify({ version: 99, entries: [] }));
  await assert.rejects(new Ledger({ filePath }).load(), /unsupported ledger file format/);
});

test('integration: evaluate + ledgerStateFor stops spending at the daily limit', async (t) => {
  const dir = await tempDir(t);
  const ledger = new Ledger({ filePath: join(dir, 'ledger.json'), now: fixedClock('2026-10-28T12:00:00Z') });
  const policy: Policy = {
    agentId: 'agent-1',
    perTxMax: 40,
    dailyMax: 100,
    allowedPayees: ['openai-api'],
    requireApprovalAbove: 40,
  };
  const statuses: string[] = [];
  for (let n = 0; n < 4; n++) {
    const i = intent({ id: `pi-${n}`, amount: 30 });
    await ledger.recordIntent(i);
    const decision = evaluate(policy, i, await ledger.ledgerStateFor(i));
    await ledger.recordDecision(i.id, decision);
    statuses.push(decision.status);
    if (decision.status === 'approved') {
      await ledger.recordPayment(i.id, 'paid');
      await ledger.recordReceipt(i.id, receipt(i.id));
    }
  }
  assert.deepEqual(statuses, ['approved', 'approved', 'approved', 'rejected']);
  assert.match((await ledger.get('pi-3'))!.decision!.reason, /^daily_limit_exceeded: /);
  assert.equal(await ledger.dailyTotal('agent-1'), 90);
  // a 10 still fits exactly
  const last = intent({ id: 'pi-last', amount: 10 });
  assert.equal(evaluate(policy, last, await ledger.ledgerStateFor(last)).status, 'approved');
});
