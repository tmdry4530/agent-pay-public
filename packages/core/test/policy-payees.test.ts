import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Ledger,
  LedgerError,
  ReasonCode,
  approve,
  evaluate,
  policyProblem,
  reasonCode,
  runPayment,
  type PaymentAdapter,
  type PaymentIntent,
  type Policy,
} from '../src/index.ts';
import { NOW, basePolicy, legacyView, makeIntent, newLedger, tempDir } from './helpers.ts';

function countingAdapter(): PaymentAdapter & { calls: number } {
  const a = {
    rail: 'mock' as const,
    calls: 0,
    async pay(i: PaymentIntent) {
      a.calls++;
      return { intentId: i.id, rail: 'mock' as const, externalId: `x-${i.id}`, status: 'succeeded' as const, at: NOW };
    },
  };
  return a;
}

// ---- 1. allowedPayees validation (policyProblem → invalid_policy) ----

const badPayees: [string, unknown[]][] = [
  ['exact duplicate', ['openai-api', 'vercel', 'openai-api']],
  ['leading whitespace', [' openai-api']],
  ['trailing whitespace', ['openai-api ']],
  ['trailing newline', ['openai-api\n']],
  ['empty string', ['openai-api', '']],
  ['whitespace-only (counts as empty)', ['openai-api', '   ']],
  ['tab-only (counts as empty)', ['\t']],
  ['non-string entry', ['openai-api', 42]],
];

for (const [name, allowedPayees] of badPayees) {
  test(`allowedPayees ${name} → policyProblem reports it, evaluate rejects invalid_policy`, () => {
    const policy = basePolicy({ allowedPayees: allowedPayees as string[] });
    assert.ok(policyProblem(policy, { dailyTotal: 0 }), 'policyProblem should report a problem');
    const d = evaluate(policy, makeIntent({ amount: 1 }), { dailyTotal: 0 });
    assert.equal(d.status, 'rejected');
    assert.equal(reasonCode(d), ReasonCode.InvalidPolicy, d.reason);
  });
}

test('allowedPayees: whitespace-only is reported as empty, not as surrounding whitespace', () => {
  const p = policyProblem(basePolicy({ allowedPayees: ['  '] }), { dailyTotal: 0 });
  assert.match(p ?? '', /empty/);
});

test('allowedPayees: case-different entries are distinct (exact-string match, no case folding); [] is valid', () => {
  assert.equal(policyProblem(basePolicy({ allowedPayees: ['openai-api', 'OpenAI-API'] }), { dailyTotal: 0 }), undefined);
  assert.equal(policyProblem(basePolicy({ allowedPayees: [] }), { dailyTotal: 0 }), undefined);
  // Inner whitespace is not "surrounding" whitespace.
  assert.equal(policyProblem(basePolicy({ allowedPayees: ['acme corp'] }), { dailyTotal: 0 }), undefined);
});

// ---- 2. empty / whitespace-only intent payee → payee_not_allowed ----

test('evaluate: empty or whitespace-only payee → payee_not_allowed', () => {
  for (const payee of ['', '   ', '\t\n']) {
    const d = evaluate(basePolicy(), makeIntent({ payee }), { dailyTotal: 0 });
    assert.equal(reasonCode(d), ReasonCode.PayeeNotAllowed, JSON.stringify(payee));
  }
});

for (const legacy of [false, true]) {
  const path = legacy ? 'legacy ledger' : 'Ledger';

  test(`runPayment (${path}): whitespace-only payee → rejected payee_not_allowed by 'policy', nothing paid`, async (t) => {
    const real = newLedger(await tempDir(t));
    const ledger = legacy ? legacyView(real) : real;
    const adapter = countingAdapter();
    const r = await runPayment(makeIntent({ payee: '   ' }), basePolicy(), ledger, adapter);
    assert.equal(r.status, 'rejected');
    assert.equal(reasonCode(r.decision), ReasonCode.PayeeNotAllowed);
    assert.equal(adapter.calls, 0);
    const e = await real.get('pi-1');
    assert.equal(e?.decisions.at(-1)?.actor, 'policy');
    assert.equal(await real.dailyTotal('agent-1'), 0);
  });

  test(`runPayment (${path}): a policy listing a whitespace-only payee is invalid_policy, nothing paid`, async (t) => {
    const real = newLedger(await tempDir(t));
    const ledger = legacy ? legacyView(real) : real;
    const adapter = countingAdapter();
    const r = await runPayment(makeIntent({ payee: '   ' }), basePolicy({ allowedPayees: ['   ', 'openai-api'] }), ledger, adapter);
    assert.equal(r.status, 'rejected');
    assert.equal(reasonCode(r.decision), ReasonCode.InvalidPolicy);
    assert.equal(adapter.calls, 0);
  });

  test(`runPayment (${path}): empty payee throws LedgerError invalid_input, writes nothing, ledger stays readable`, async (t) => {
    const dir = await tempDir(t);
    const real = newLedger(dir);
    const ledger = legacy ? legacyView(real) : real;
    const adapter = countingAdapter();
    await assert.rejects(
      runPayment(makeIntent({ payee: '' }), basePolicy({ allowedPayees: ['', 'openai-api'] }), ledger, adapter),
      (err: unknown) => err instanceof LedgerError && err.code === 'invalid_input',
    );
    assert.equal(adapter.calls, 0);
    // A fresh process must still be able to read the ledger file (no ledger_corrupt).
    assert.deepEqual(await newLedger(dir).list(), []);
  });

  test(`approve (${path}): pending whitespace-only payee → re-check rejects (payee_not_allowed / invalid_policy), nothing paid`, async (t) => {
    const real: Ledger = newLedger(await tempDir(t));
    const ledger = legacy ? legacyView(real) : real;
    const pending = { status: 'needs_approval' as const, reason: 'approval_required: test' };
    await real.recordIntentAndDecide(makeIntent({ payee: '   ', amount: 150 }), () => ({ decision: pending, actor: 'policy' }));
    await real.recordIntentAndDecide(makeIntent({ id: 'pi-2', payee: '   ', amount: 150 }), () => ({ decision: pending, actor: 'policy' }));
    const adapter = countingAdapter();

    const a = await approve('pi-1', { policy: basePolicy({ perTxMax: 200 }), ledger, adapter, approver: 'alice' });
    assert.equal(a.status, 'rejected');
    assert.equal(reasonCode(a.decision), ReasonCode.PayeeNotAllowed);

    const b = await approve('pi-2', {
      policy: basePolicy({ perTxMax: 200, allowedPayees: ['   ', 'openai-api'] }),
      ledger,
      adapter,
      approver: 'alice',
    });
    assert.equal(b.status, 'rejected');
    assert.equal(reasonCode(b.decision), ReasonCode.InvalidPolicy);

    assert.equal(adapter.calls, 0);
    for (const id of ['pi-1', 'pi-2']) assert.equal((await real.get(id))?.decisions.at(-1)?.actor, 'policy');
    assert.equal(await real.dailyTotal('agent-1'), 0);
  });
}
