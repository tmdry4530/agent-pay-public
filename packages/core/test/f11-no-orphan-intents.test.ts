import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPayment, type Policy } from '../src/index.ts';
import { basePolicy, delayedAdapter, makeIntent, newLedger, tempDir } from './helpers.ts';

test('F11: Ledger.recordIntentAndDecide writes intent + decision together, or nothing', async (t) => {
  const ledger = newLedger(await tempDir(t));
  await assert.rejects(
    ledger.recordIntentAndDecide(makeIntent(), () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await ledger.get('pi-1'), undefined);

  const first = await ledger.recordIntentAndDecide(makeIntent(), (state) => ({
    decision: { status: 'approved', reason: `within_policy: total ${state.dailyTotal}` },
    actor: 'policy',
  }));
  assert.equal(first.created, true);
  assert.equal(first.entry.decision?.status, 'approved');
  assert.equal(first.entry.decisions.length, 1);
  assert.equal(first.entry.decisions[0]?.actor, 'policy');

  const again = await ledger.recordIntentAndDecide(makeIntent(), () => {
    throw new Error('must not be called for an existing id');
  });
  assert.equal(again.created, false);
  assert.deepEqual(again.entry, first.entry);
});

test('F11: a failure while deciding leaves no undecided (stuck in_progress) entry', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const adapter = delayedAdapter(0);
  const broken = basePolicy();
  Object.defineProperty(broken, 'perTxMax', {
    get() {
      throw new Error('policy store unavailable');
    },
  });
  await assert.rejects(runPayment(makeIntent(), broken as Policy, ledger, adapter), /policy store unavailable/);
  assert.equal(await ledger.get('pi-1'), undefined);
  // The client's retry with the same id is processed normally instead of failing in_progress.
  const retry = await runPayment(makeIntent(), basePolicy(), ledger, adapter);
  assert.equal(retry.status, 'paid');
  assert.equal(retry.replayed, undefined);
});
