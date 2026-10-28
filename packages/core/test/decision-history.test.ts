import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger,
  PaymentError,
  approve,
  reconcile,
  reject,
  runPayment,
  type DecisionRecord,
  type PaymentAdapter,
  type PaymentIntent,
  type Policy,
  type Rail,
  type Receipt,
} from '../src/index.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'ledger-v1-no-decisions.json');

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

class MockAdapter implements PaymentAdapter {
  readonly rail: Rail = 'mock';
  calls = 0;
  receiptStatus: Receipt['status'] = 'succeeded';
  settleTo: Receipt['status'] = 'succeeded';
  async pay(i: PaymentIntent): Promise<Receipt> {
    this.calls++;
    return { intentId: i.id, rail: 'mock', externalId: `mock-${i.id}`, status: this.receiptStatus, at: '2026-10-28T10:00:00.000Z' };
  }
  async status(r: Receipt): Promise<Receipt> {
    return { ...r, status: this.settleTo };
  }
}

/** Ledger whose clock advances 1s per call, so record times are strictly increasing. */
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'ledger.json');
  let tick = Date.parse('2026-10-28T12:00:00.000Z');
  const ledger = new Ledger({ filePath, now: () => new Date((tick += 1000)) });
  return { dir, filePath, ledger, adapter: new MockAdapter() };
}

const shape = (ds: DecisionRecord[] | undefined) =>
  (ds ?? []).map(({ status, reason, actor }) => ({ status, code: reason.split(':')[0], actor }));

function assertIncreasingAt(ds: DecisionRecord[] | undefined): void {
  const times = (ds ?? []).map((d) => Date.parse(d.at ?? ''));
  assert.ok(times.every((ms) => Number.isFinite(ms)), 'every record has an ISO at');
  for (let k = 1; k < times.length; k++) assert.ok(times[k]! > times[k - 1]!, 'at is strictly increasing');
}

test('needs_approval -> approved: history keeps both, latest is entry.decision', async (t) => {
  const { ledger, adapter } = await setup(t);
  await runPayment(intent({ id: 'big', amount: 60 }), policy, ledger, adapter);
  const result = await approve('big', { policy, ledger, adapter, approver: 'alice' });
  assert.equal(result.status, 'paid');

  const entry = (await ledger.get('big'))!;
  assert.deepEqual(shape(entry.decisions), [
    { status: 'needs_approval', code: 'approval_required', actor: 'policy' },
    { status: 'approved', code: 'approved_by_human', actor: 'alice' },
  ]);
  assertIncreasingAt(entry.decisions);
  const last = entry.decisions!.at(-1)!;
  assert.deepEqual(entry.decision, { status: last.status, reason: last.reason });
  assert.deepEqual(entry.decision, result.decision);
});

test('needs_approval -> rejected_by_human: history keeps both', async (t) => {
  const { ledger, adapter } = await setup(t);
  await runPayment(intent({ id: 'big', amount: 60 }), policy, ledger, adapter);
  await reject('big', { ledger, approver: 'bob', note: 'too pricey' });

  const entry = (await ledger.get('big'))!;
  assert.deepEqual(shape(entry.decisions), [
    { status: 'needs_approval', code: 'approval_required', actor: 'policy' },
    { status: 'rejected', code: 'rejected_by_human', actor: 'bob' },
  ]);
  assertIncreasingAt(entry.decisions);
  assert.equal(entry.decision?.reason, 'rejected_by_human: rejected by "bob"; too pricey');
});

test('approve/reject without an approver name records no actor; a lost race appends nothing', async (t) => {
  const { ledger, adapter } = await setup(t);
  await runPayment(intent({ id: 'big', amount: 60 }), policy, ledger, adapter);
  await reject('big', { ledger });
  await assert.rejects(approve('big', { policy, ledger, adapter, approver: 'alice' }), PaymentError);
  await assert.rejects(ledger.recordDecision('big', { status: 'approved', reason: 'x: y' }, { ifStatus: 'needs_approval' }));
  const entry = (await ledger.get('big'))!;
  assert.equal(entry.decisions?.length, 2);
  assert.equal('actor' in entry.decisions![1]!, false);
  assert.equal(adapter.calls, 0);
});

test('re-check rejection on approval is recorded as a policy decision', async (t) => {
  const { ledger, adapter } = await setup(t);
  await runPayment(intent({ id: 'small', amount: 100 }), policy, ledger, adapter); // needs approval
  await runPayment(intent({ id: 'other', amount: 50 }), policy, ledger, adapter); // paid, 50 used
  await runPayment(intent({ id: 'big', amount: 60 }), policy, ledger, adapter); // needs approval
  await approve('small', { policy, ledger, adapter, approver: 'alice' }); // 150 used
  const result = await approve('big', { policy, ledger, adapter, approver: 'alice' });
  assert.equal(result.status, 'rejected');
  assert.deepEqual(shape((await ledger.get('big'))!.decisions), [
    { status: 'needs_approval', code: 'approval_required', actor: 'policy' },
    { status: 'rejected', code: 'daily_limit_exceeded', actor: 'policy' },
  ]);
});

test('auto-approved and paid: a single policy decision', async (t) => {
  const { ledger, adapter } = await setup(t);
  const result = await runPayment(intent(), policy, ledger, adapter);
  assert.equal(result.status, 'paid');
  const entry = (await ledger.get('pi-1'))!;
  assert.deepEqual(shape(entry.decisions), [{ status: 'approved', code: 'within_policy', actor: 'policy' }]);
  assertIncreasingAt(entry.decisions);
});

test('policy rejection: a single policy decision', async (t) => {
  const { ledger, adapter } = await setup(t);
  const result = await runPayment(intent({ payee: 'evil' }), policy, ledger, adapter);
  assert.equal(result.status, 'rejected');
  assert.deepEqual(shape((await ledger.get('pi-1'))!.decisions), [
    { status: 'rejected', code: 'payee_not_allowed', actor: 'policy' },
  ]);
});

test('replays and reconcile append no decisions', async (t) => {
  const { ledger, adapter } = await setup(t);
  adapter.receiptStatus = 'pending';
  await runPayment(intent(), policy, ledger, adapter);
  await runPayment(intent({ id: 'big', amount: 60 }), policy, ledger, adapter);
  await approve('big', { policy, ledger, adapter, approver: 'alice' });
  const before = structuredClone(await ledger.list());

  for (const i of [intent(), intent({ id: 'big', amount: 60 })]) {
    const r = await runPayment(i, policy, ledger, adapter);
    assert.equal(r.replayed, true);
  }
  assert.deepEqual(await ledger.list(), before, 'replay writes nothing');

  adapter.settleTo = 'succeeded';
  const summary = await reconcile(ledger, adapter);
  assert.equal(summary.updated.length, 2, 'both pending receipts settled via settleReceipt');
  for (const id of ['pi-1', 'big']) {
    const entry = (await ledger.get(id))!;
    assert.equal(entry.receipt?.status, 'succeeded', `${id} settled`);
    assert.deepEqual(entry.decisions, before.find((e) => e.intent.id === id)!.decisions, `${id} history unchanged`);
  }
  assert.equal(adapter.calls, 2);
});

test('old-format file: decisions back-filled on read as [decision] or [], file not rewritten by reads', async (t) => {
  const { dir } = await setup(t);
  const filePath = join(dir, 'old.json');
  await copyFile(FIXTURE, filePath);
  const original = await readFile(filePath, 'utf8');
  const ledger = new Ledger({ filePath, now: () => new Date('2026-10-28T12:00:00.000Z') });

  const entries = await ledger.list();
  for (const e of entries) {
    assert.deepEqual(e.decisions, e.decision ? [e.decision] : [], e.intent.id);
  }
  assert.equal(entries.find((e) => e.intent.id === 'old-undecided')!.decisions!.length, 0);
  await ledger.get('old-paid');
  await ledger.dailyTotal('agent-1', '2026-10-27');
  assert.equal(await readFile(filePath, 'utf8'), original, 'reads do not rewrite the file');

  // The next write persists the new shape, and history continues from the back-filled record.
  await reject('old-pending', { ledger, approver: 'bob' });
  const saved = JSON.parse(await readFile(filePath, 'utf8')) as { entries: { intent: { id: string }; decisions: DecisionRecord[] }[] };
  const pending = saved.entries.find((e) => e.intent.id === 'old-pending')!;
  assert.deepEqual(shape(pending.decisions), [
    { status: 'needs_approval', code: 'approval_required', actor: undefined },
    { status: 'rejected', code: 'rejected_by_human', actor: 'bob' },
  ]);
  assert.equal(pending.decisions[0]!.at, undefined, 'back-filled record has no invented time');
  assert.equal(pending.decisions[1]!.at, '2026-10-28T12:00:00.000Z');
  assert.ok(saved.entries.every((e) => Array.isArray(e.decisions)));
});
