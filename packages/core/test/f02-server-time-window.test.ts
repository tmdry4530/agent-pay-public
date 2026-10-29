import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReasonCode, approve, reasonCode, runPayment } from '../src/index.ts';
import { basePolicy, delayedAdapter, makeIntent, newLedger, tempDir } from './helpers.ts';

/** Mutable server clock. */
function clock(iso: string) {
  let now = new Date(iso);
  return { now: () => new Date(now), set: (next: string) => void (now = new Date(next)) };
}

test('F2: a backdated createdAt cannot dodge today\'s total', async (t) => {
  const c = clock('2026-10-28T12:00:00.000Z');
  const ledger = newLedger(await tempDir(t), c.now);
  const policy = basePolicy();
  await runPayment(makeIntent({ id: 'a', amount: 100 }), policy, ledger, delayedAdapter(0));
  await runPayment(makeIntent({ id: 'b', amount: 100 }), policy, ledger, delayedAdapter(0));
  for (const createdAt of ['2026-10-27T23:00:00.000Z', '2026-10-29T01:00:00.000Z', '2001-01-01T00:00:00.000Z']) {
    const r = await runPayment(makeIntent({ id: `x-${createdAt}`, amount: 50, createdAt }), policy, ledger, delayedAdapter(0));
    assert.equal(reasonCode(r.decision), ReasonCode.DailyLimitExceeded, createdAt);
  }
  // createdAt is kept as-is on the record.
  assert.equal((await ledger.get('x-2001-01-01T00:00:00.000Z'))?.intent.createdAt, '2001-01-01T00:00:00.000Z');
});

test('F2: spend approved on an earlier server day does not count today, whatever createdAt says', async (t) => {
  const c = clock('2026-10-28T23:59:00.000Z');
  const ledger = newLedger(await tempDir(t), c.now);
  const policy = basePolicy();
  await runPayment(makeIntent({ id: 'a', amount: 100, createdAt: '2026-10-29T00:30:00.000Z' }), policy, ledger, delayedAdapter(0));
  await runPayment(makeIntent({ id: 'b', amount: 100, createdAt: '2026-10-29T00:30:00.000Z' }), policy, ledger, delayedAdapter(0));
  c.set('2026-10-29T00:01:00.000Z');
  const r = await runPayment(makeIntent({ id: 'c', amount: 100, createdAt: '2026-10-29T00:30:00.000Z' }), policy, ledger, delayedAdapter(0));
  assert.equal(r.decision.status, 'approved', r.decision.reason);
  assert.equal(await ledger.dailyTotal('agent-1'), 100);
  assert.equal(await ledger.dailyTotal('agent-1', '2026-10-28'), 200);
});

test('F2: a held intent approved on a later server day counts on the approval day', async (t) => {
  const c = clock('2026-10-28T12:00:00.000Z');
  const ledger = newLedger(await tempDir(t), c.now);
  const policy = basePolicy({ requireApprovalAbove: 50 });
  const held = await runPayment(makeIntent({ id: 'big', amount: 80 }), policy, ledger, delayedAdapter(0));
  assert.equal(held.decision.status, 'needs_approval');
  c.set('2026-10-29T09:00:00.000Z');
  await approve('big', { approver: 'alice', policy, ledger, adapter: delayedAdapter(0) });
  assert.equal(await ledger.dailyTotal('agent-1', '2026-10-28'), 0);
  assert.equal(await ledger.dailyTotal('agent-1', '2026-10-29'), 80);
  const r = await runPayment(makeIntent({ id: 'n', amount: 50, createdAt: '2026-10-28T12:00:00.000Z' }), policy, ledger, delayedAdapter(0));
  assert.equal(r.decision.status, 'approved');
  const r2 = await runPayment(makeIntent({ id: 'm', amount: 71 }), basePolicy(), ledger, delayedAdapter(0));
  assert.equal(reasonCode(r2.decision), ReasonCode.DailyLimitExceeded);
});
