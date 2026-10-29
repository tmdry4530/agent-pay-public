import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, runPayment, type Ledger } from '../src/index.ts';
import { basePolicy, delayedAdapter, legacyView, makeIntent, newLedger, tempDir } from './helpers.ts';

for (const mode of ['ledger', 'legacy'] as const) {
  const wrap = (l: Ledger) => (mode === 'legacy' ? legacyView(l) : l);

  test(`F1 [${mode}]: concurrent runPayment cannot exceed dailyMax`, async (t) => {
    const ledger = wrap(newLedger(await tempDir(t)));
    const adapter = delayedAdapter(5);
    const policy = basePolicy({ dailyMax: 200 });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => runPayment(makeIntent({ id: `pi-${n}`, amount: 50 }), policy, ledger, adapter)),
    );
    const paid = results.filter((r) => r.status === 'paid');
    assert.equal(paid.length, 4);
    assert.equal(results.filter((r) => r.decision.reason.startsWith('daily_limit_exceeded')).length, 1);
    assert.equal(adapter.calls.length, 4);
    assert.equal(await ledger.dailyTotal('agent-1'), 200);
  });

  test(`F1 [${mode}]: concurrent approvals cannot exceed dailyMax`, async (t) => {
    const ledger = wrap(newLedger(await tempDir(t)));
    const adapter = delayedAdapter(5);
    const policy = basePolicy({ dailyMax: 200, requireApprovalAbove: 50 });
    for (const n of [1, 2, 3]) {
      const r = await runPayment(makeIntent({ id: `pa-${n}`, amount: 80 }), policy, ledger, adapter);
      assert.equal(r.status, 'needs_approval');
    }
    const results = await Promise.all(
      [1, 2, 3].map((n) => approve(`pa-${n}`, { policy, ledger, adapter, approver: 'ops' })),
    );
    assert.equal(results.filter((r) => r.status === 'paid').length, 2);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(await ledger.dailyTotal('agent-1'), 160);
  });
}
