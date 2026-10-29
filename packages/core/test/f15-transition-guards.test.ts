import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerError, type Receipt } from '../src/index.ts';
import { NOW, makeIntent, newLedger, tempDir } from './helpers.ts';

const isPrecondition = (err: unknown) => err instanceof LedgerError && err.code === 'precondition_failed';
const receipt = (status: Receipt['status'], id = 'pi-1'): Receipt => ({ intentId: id, rail: 'mock', externalId: `x-${status}`, status, at: NOW });
const approved = { status: 'approved', reason: 'within_policy: ok' } as const;
const rejected = { status: 'rejected', reason: 'rejected_by_human: no' } as const;
const held = { status: 'needs_approval', reason: 'approval_required: big' } as const;

test('F15: decisions: undecided → any, needs_approval → approved/rejected, approved/rejected are terminal', async (t) => {
  const ledger = newLedger(await tempDir(t));
  await ledger.recordIntent(makeIntent({ id: 'r' }));
  await ledger.recordDecision('r', rejected);
  await assert.rejects(ledger.recordDecision('r', approved), isPrecondition, 'rejected → approved');
  await assert.rejects(ledger.recordDecision('r', held), isPrecondition, 'rejected → needs_approval');

  await ledger.recordIntent(makeIntent({ id: 'a' }));
  await ledger.recordDecision('a', approved);
  await assert.rejects(ledger.recordDecision('a', rejected), isPrecondition, 'approved → rejected');

  await ledger.recordIntent(makeIntent({ id: 'h' }));
  await ledger.recordDecision('h', held);
  await assert.rejects(ledger.recordDecision('h', held), isPrecondition, 'needs_approval → needs_approval');
  await ledger.recordDecision('h', approved);
  assert.equal((await ledger.get('h'))?.decision?.status, 'approved');
  assert.equal((await ledger.dailyTotal('agent-1')), 20, 'the flipped rejected entry never counts');
});

test('F15: recordReceipt: first receipt must match paymentStatus; only succeeded → refunded may replace it', async (t) => {
  const ledger = newLedger(await tempDir(t));
  await ledger.recordIntent(makeIntent());
  await ledger.recordDecision('pi-1', approved);
  await ledger.recordPayment('pi-1', 'paid');
  await assert.rejects(ledger.recordReceipt('pi-1', receipt('refunded')), isPrecondition, 'paid + refunded first');
  await ledger.recordReceipt('pi-1', receipt('succeeded'));
  await assert.rejects(ledger.recordReceipt('pi-1', receipt('failed')), isPrecondition, 'succeeded → failed');
  await assert.rejects(ledger.recordReceipt('pi-1', receipt('pending')), isPrecondition, 'succeeded → pending');
  assert.equal(await ledger.dailyTotal('agent-1'), 10, 'budget not silently freed');
  await ledger.recordReceipt('pi-1', receipt('refunded'));
  await assert.rejects(ledger.recordReceipt('pi-1', receipt('succeeded')), isPrecondition, 'refunded is terminal');
  const entry = await ledger.get('pi-1');
  assert.equal(entry?.paymentStatus, 'paid');
  assert.equal(entry?.receipt?.status, 'refunded');
});

test('F15: a failed first receipt on a paid payment marks the payment failed (consistent state)', async (t) => {
  const ledger = newLedger(await tempDir(t));
  await ledger.recordIntent(makeIntent());
  await ledger.recordDecision('pi-1', approved);
  await ledger.recordPayment('pi-1', 'paid');
  await ledger.recordReceipt('pi-1', receipt('failed'));
  assert.equal((await ledger.get('pi-1'))?.paymentStatus, 'failed');
  await assert.rejects(ledger.recordReceipt('pi-1', receipt('succeeded')), isPrecondition);
});

test('F15: a pending receipt can only be replaced through settleReceipt; a failed payment only takes a failed receipt', async (t) => {
  const ledger = newLedger(await tempDir(t));
  await ledger.recordIntent(makeIntent());
  await ledger.recordDecision('pi-1', approved);
  await ledger.recordPayment('pi-1', 'paid');
  await ledger.recordReceipt('pi-1', receipt('pending'));
  await assert.rejects(ledger.recordReceipt('pi-1', receipt('succeeded')), isPrecondition);
  await ledger.settleReceipt('pi-1', receipt('succeeded'));

  await ledger.recordIntent(makeIntent({ id: 'f' }));
  await ledger.recordDecision('f', approved);
  await ledger.recordPayment('f', 'failed');
  await assert.rejects(ledger.recordReceipt('f', receipt('succeeded', 'f')), isPrecondition);
  await ledger.recordReceipt('f', receipt('failed', 'f'));
});
