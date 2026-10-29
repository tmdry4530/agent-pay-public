import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerError, PaymentError, approve, reject, runPayment, type Ledger } from '../src/index.ts';
import { basePolicy, delayedAdapter, legacyView, makeIntent, newLedger, tempDir } from './helpers.ts';

test('F12: LedgerError carries a machine-readable code', async (t) => {
  const ledger = newLedger(await tempDir(t));
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      assert.ok(err instanceof LedgerError);
      assert.match(err.message, new RegExp(`^${err.code}: `));
      return err.code;
    }
    assert.fail('expected a LedgerError');
  };
  await ledger.recordIntent(makeIntent());
  assert.equal(await code(ledger.recordIntent(makeIntent())), 'duplicate_intent');
  assert.equal(await code(ledger.recordPayment('nope', 'paid')), 'not_found');
  assert.equal(await code(ledger.recordPayment('pi-1', 'paid')), 'precondition_failed');
  await ledger.recordDecision('pi-1', { status: 'needs_approval', reason: 'approval_required: x' });
  assert.equal(
    await code(ledger.recordDecision('pi-1', { status: 'approved', reason: 'x' }, { ifStatus: 'approved' })),
    'precondition_failed',
  );
});

const isRaceLoss = (err: unknown) =>
  err instanceof PaymentError && (err.code === 'not_pending' || err.code === 'already_paid');

for (const mode of ['ledger', 'legacy'] as const) {
  const wrap = (l: Ledger) => (mode === 'legacy' ? legacyView(l) : l);

  test(`F12 [${mode}]: losing an approve/approve race is a PaymentError (409), not a LedgerError (500)`, async (t) => {
    const ledger = wrap(newLedger(await tempDir(t)));
    const adapter = delayedAdapter(5);
    const policy = basePolicy({ requireApprovalAbove: 50 });
    await runPayment(makeIntent({ amount: 80 }), policy, ledger, adapter);
    const settled = await Promise.allSettled([
      approve('pi-1', { policy, ledger, adapter, approver: 'a' }),
      approve('pi-1', { policy, ledger, adapter, approver: 'b' }),
    ]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const lost = settled.filter((s) => s.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(lost.length, 1);
    assert.ok(isRaceLoss((lost[0] as PromiseRejectedResult).reason), String((lost[0] as PromiseRejectedResult).reason));
    assert.equal(adapter.calls.length, 1);
  });

  test(`F12 [${mode}]: approve vs reject race: loser gets not_pending`, async (t) => {
    const ledger = wrap(newLedger(await tempDir(t)));
    const adapter = delayedAdapter(5);
    const policy = basePolicy({ requireApprovalAbove: 50 });
    await runPayment(makeIntent({ amount: 80 }), policy, ledger, adapter);
    const settled = await Promise.allSettled([
      reject('pi-1', { ledger, approver: 'r' }),
      approve('pi-1', { policy, ledger, adapter, approver: 'a' }),
    ]);
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
    const lost = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    assert.ok(isRaceLoss(lost.reason), String(lost.reason));
  });
}
