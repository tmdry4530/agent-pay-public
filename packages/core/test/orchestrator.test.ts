import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger,
  PaymentError,
  approve,
  reject,
  runPayment,
  type PaymentAdapter,
  type PaymentIntent,
  type Policy,
  type Rail,
  type Receipt,
} from '../src/index.ts';

const NOW = '2026-10-28T12:00:00.000Z';

const policy: Policy = {
  agentId: 'agent-1',
  perTxMax: 100,
  dailyMax: 150,
  allowedPayees: ['openai-api'],
  requireApprovalAbove: 50,
};

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

/** Inline mock adapter: records calls; `respond` decides each pay() outcome. */
class MockAdapter implements PaymentAdapter {
  readonly rail: Rail = 'mock';
  calls: PaymentIntent[] = [];
  respond: (intent: PaymentIntent) => Receipt | Promise<Receipt>;
  constructor(respond?: (intent: PaymentIntent) => Receipt | Promise<Receipt>) {
    this.respond =
      respond ??
      ((i) => ({ intentId: i.id, rail: 'mock', externalId: `mock-${i.id}`, status: 'succeeded', at: NOW }));
  }
  async pay(i: PaymentIntent): Promise<Receipt> {
    this.calls.push(i);
    return this.respond(i);
  }
}

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-orch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'ledger.json');
  return { filePath, ledger: new Ledger({ filePath, now: () => new Date(NOW) }), adapter: new MockAdapter() };
}

test('happy path: paid, receipt recorded, daily total updated', async (t) => {
  const { ledger, adapter } = await setup(t);
  const result = await runPayment(intent({ amount: 20 }), policy, ledger, adapter);
  assert.equal(result.status, 'paid');
  assert.equal(result.decision.status, 'approved');
  assert.match(result.decision.reason, /^within_policy: /);
  assert.equal(result.receipt?.externalId, 'mock-pi-1');
  assert.equal(result.error, undefined);
  assert.equal(adapter.calls.length, 1);
  const entry = await ledger.get('pi-1');
  assert.equal(entry?.paymentStatus, 'paid');
  assert.deepEqual(entry?.receipt, result.receipt);
  assert.equal(await ledger.dailyTotal('agent-1'), 20);
});

test('rejected: adapter is never called and nothing counts', async (t) => {
  const { ledger, adapter } = await setup(t);
  const result = await runPayment(intent({ payee: 'evil-corp' }), policy, ledger, adapter);
  assert.equal(result.status, 'rejected');
  assert.match(result.decision.reason, /^payee_not_allowed: /);
  assert.equal(result.receipt, undefined);
  assert.equal(adapter.calls.length, 0);
  assert.equal((await ledger.get('pi-1'))?.paymentStatus, undefined);
  assert.equal(await ledger.dailyTotal('agent-1'), 0);
});

test('needs_approval -> approve -> paid', async (t) => {
  const { ledger, adapter } = await setup(t);
  const pending = await runPayment(intent({ amount: 80 }), policy, ledger, adapter);
  assert.equal(pending.status, 'needs_approval');
  assert.match(pending.decision.reason, /^approval_required: /);
  assert.equal(adapter.calls.length, 0);
  assert.equal(await ledger.dailyTotal('agent-1'), 0);

  const result = await approve('pi-1', { policy, ledger, adapter, approver: 'alice' });
  assert.equal(result.status, 'paid');
  assert.equal(result.decision.status, 'approved');
  assert.match(result.decision.reason, /^approved_by_human: approved by "alice"/);
  assert.equal(adapter.calls.length, 1);
  const entry = await ledger.get('pi-1');
  assert.deepEqual(entry?.decision, result.decision);
  assert.equal(entry?.paymentStatus, 'paid');
  assert.equal(await ledger.dailyTotal('agent-1'), 80);
});

test('approve rejects unknown, non-pending and already-paid intents', async (t) => {
  const { ledger, adapter } = await setup(t);
  const opts = { policy, ledger, adapter };
  const code = (c: string) => (err: unknown) => err instanceof PaymentError && err.code === c;

  await assert.rejects(approve('nope', opts), code('intent_not_found'));

  await runPayment(intent({ id: 'rej', payee: 'evil-corp' }), policy, ledger, adapter);
  await assert.rejects(approve('rej', opts), code('not_pending'));

  await runPayment(intent({ id: 'paid', amount: 5 }), policy, ledger, adapter);
  await assert.rejects(approve('paid', opts), code('already_paid'));

  await runPayment(intent({ id: 'big', amount: 60 }), policy, ledger, adapter);
  await approve('big', opts);
  await assert.rejects(approve('big', opts), code('already_paid'));

  assert.equal(adapter.calls.length, 2); // 'paid' and 'big' once each

  // two concurrent approvals of the same intent: exactly one pays
  await runPayment(intent({ id: 'race', amount: 60 }), policy, ledger, adapter);
  const settled = await Promise.allSettled([approve('race', opts), approve('race', opts)]);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(adapter.calls.length, 3);
});

test('approve re-checks the daily limit and rejects when it was used up meanwhile', async (t) => {
  const { ledger, adapter } = await setup(t);
  const pending = await runPayment(intent({ id: 'big', amount: 90 }), policy, ledger, adapter);
  assert.equal(pending.status, 'needs_approval');
  // meanwhile, 50 + 50 of auto-approved spend: 100 of 150 used, 90 no longer fits
  await runPayment(intent({ id: 'a', amount: 50 }), policy, ledger, adapter);
  await runPayment(intent({ id: 'b', amount: 50 }), policy, ledger, adapter);
  adapter.calls = [];

  const result = await approve('big', { policy, ledger, adapter, approver: 'alice' });
  assert.equal(result.status, 'rejected');
  assert.match(result.decision.reason, /^daily_limit_exceeded: .*re-checked on approval by "alice"/);
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual((await ledger.get('big'))?.decision, result.decision);
  assert.equal(await ledger.dailyTotal('agent-1'), 100);
  // no longer pending
  await assert.rejects(approve('big', { policy, ledger, adapter }), /not_pending/);
});

test('reject helper finalizes a pending intent without paying', async (t) => {
  const { ledger, adapter } = await setup(t);
  await runPayment(intent({ amount: 80 }), policy, ledger, adapter);
  const result = await reject('pi-1', { ledger, approver: 'bob', note: 'too pricey' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.decision.reason, 'rejected_by_human: rejected by "bob"; too pricey');
  assert.equal(adapter.calls.length, 0);
  await assert.rejects(approve('pi-1', { policy, ledger, adapter }), /not_pending/);
});

test('adapter throwing -> pending + needsManualResolve (F3), amount stays counted', async (t) => {
  const { ledger } = await setup(t);
  const adapter = new MockAdapter(() => {
    throw new Error('rail timeout');
  });
  const result = await runPayment(intent({ amount: 30 }), policy, ledger, adapter);
  assert.equal(result.status, 'paid');
  assert.equal(result.needsManualResolve, true);
  assert.equal(result.decision.status, 'approved');
  assert.equal(result.error, 'adapter_error: rail timeout');
  assert.equal(result.receipt?.status, 'pending');
  assert.equal((await ledger.get('pi-1'))?.paymentStatus, 'paid');
  assert.equal(await ledger.dailyTotal('agent-1'), 30);
});

test('declined receipt -> failed, receipt kept, not counted', async (t) => {
  const { ledger } = await setup(t);
  const adapter = new MockAdapter((i) => ({ intentId: i.id, rail: 'mock', externalId: 'd-1', status: 'failed', at: NOW }));
  const result = await runPayment(intent({ amount: 30 }), policy, ledger, adapter);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /^payment_declined: /);
  assert.equal(result.receipt?.status, 'failed');
  assert.equal((await ledger.get('pi-1'))?.receipt?.externalId, 'd-1');
  assert.equal(await ledger.dailyTotal('agent-1'), 0);
});

test('receipt intentId or rail mismatch -> pending + needsManualResolve (F3), mismatched receipt not stored', async (t) => {
  const { ledger } = await setup(t);
  const wrongId = new MockAdapter(() => ({ intentId: 'other', rail: 'mock', externalId: 'x', status: 'succeeded', at: NOW }));
  const r1 = await runPayment(intent({ id: 'w1' }), policy, ledger, wrongId);
  assert.equal(r1.needsManualResolve, true);
  assert.match(r1.error ?? '', /^receipt_mismatch: receipt intentId "other"/);

  const wrongRail = new MockAdapter((i) => ({ intentId: i.id, rail: 'near', externalId: 'x', status: 'succeeded', at: NOW }));
  const r2 = await runPayment(intent({ id: 'w2' }), policy, ledger, wrongRail);
  assert.equal(r2.needsManualResolve, true);
  assert.match(r2.error ?? '', /^receipt_mismatch: receipt rail "near"/);

  for (const id of ['w1', 'w2']) {
    const e = await ledger.get(id);
    assert.equal(e?.paymentStatus, 'paid');
    assert.equal(e?.receipt?.externalId, '', 'placeholder pending receipt, not the mismatched one');
    assert.equal(e?.receipt?.status, 'pending');
  }
  assert.equal(await ledger.dailyTotal('agent-1'), 20);
});

test('idempotent replay: same intent returns stored outcome without paying again; conflicts throw', async (t) => {
  const { ledger, adapter } = await setup(t);
  const first = await runPayment(intent(), policy, ledger, adapter);
  const again = await runPayment(intent(), policy, ledger, adapter);
  assert.equal(again.status, 'paid');
  assert.equal(again.replayed, true);
  assert.deepEqual(again.receipt, first.receipt);
  assert.equal(adapter.calls.length, 1);
  await assert.rejects(runPayment(intent({ amount: 11 }), policy, ledger, adapter), /^PaymentError: intent_conflict/);

  // concurrent runs for the same id: exactly one pays
  const [a, b] = await Promise.allSettled([
    runPayment(intent({ id: 'c' }), policy, ledger, adapter),
    runPayment(intent({ id: 'c' }), policy, ledger, adapter),
  ]);
  assert.equal(adapter.calls.length, 2);
  assert.ok([a, b].some((r) => r.status === 'fulfilled' && r.value.status === 'paid' && !r.value.replayed));
});

test('persistence: a new Ledger on the same file sees the final state', async (t) => {
  const { filePath, ledger, adapter } = await setup(t);
  await runPayment(intent({ id: 'p', amount: 20 }), policy, ledger, adapter);
  await runPayment(intent({ id: 'r', payee: 'evil-corp' }), policy, ledger, adapter);
  await runPayment(intent({ id: 'n', amount: 70 }), policy, ledger, adapter);

  const second = new Ledger({ filePath, now: () => new Date(NOW) });
  const approved = await approve('n', { policy, ledger: second, adapter });
  assert.equal(approved.status, 'paid');

  const third = new Ledger({ filePath, now: () => new Date(NOW) });
  assert.equal((await third.get('p'))?.paymentStatus, 'paid');
  assert.equal((await third.get('r'))?.decision?.status, 'rejected');
  const n = await third.get('n');
  assert.match(n?.decision?.reason ?? '', /^approved_by_human: /);
  assert.equal(n?.receipt?.externalId, 'mock-n');
  assert.equal(await third.dailyTotal('agent-1'), 90);
  const replay = await runPayment(intent({ id: 'n', amount: 70 }), policy, third, adapter);
  assert.equal(replay.status, 'paid');
  assert.equal(replay.replayed, true);
});
