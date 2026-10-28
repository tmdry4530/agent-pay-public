import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger,
  PaymentError,
  resolveIntent,
  type PaymentIntent,
  type Receipt,
  type ResolveInput,
} from '../src/index.ts';

const NOW = '2026-10-28T12:00:00.000Z';

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

type PendingPayPalReceipt = Receipt & {
  meta?: { needsManualResolve?: string; duplicateSenderBatchId?: string };
};

const pendingPayPalReceipt = (intentId: string, over: Partial<PendingPayPalReceipt> = {}): PendingPayPalReceipt => ({
  intentId,
  rail: 'paypal',
  externalId: '',
  status: 'pending',
  at: NOW,
  meta: { needsManualResolve: 'true', duplicateSenderBatchId: 'true' },
  ...over,
});

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-resolve-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'ledger.json');
  return { filePath, ledger: new Ledger({ filePath, now: () => new Date(NOW) }) };
}

async function recordPendingPaid(ledger: Ledger, i: PaymentIntent, receipt: Receipt): Promise<void> {
  await ledger.recordIntent(i);
  await ledger.recordDecision(i.id, { status: 'approved', reason: 'within_policy: test' });
  await ledger.recordPayment(i.id, 'paid');
  await ledger.recordReceipt(i.id, receipt);
}

test('resolveIntent: failed drops daily total, preserves meta, records resolution', async (t) => {
  const { ledger } = await setup(t);
  const i = intent();
  const stored = pendingPayPalReceipt(i.id);
  await recordPendingPaid(ledger, i, stored as Receipt);
  assert.equal(await ledger.dailyTotal('agent-1', '2026-10-28'), 10);

  const result = await resolveIntent(i.id, ledger, { status: 'failed', note: 'duplicate batch id' }, () => new Date(NOW));

  assert.equal(result.changed, true);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /^payment_failed: /);
  assert.equal(await ledger.dailyTotal('agent-1', '2026-10-28'), 0);

  const entry = await ledger.get(i.id);
  assert.equal(entry?.paymentStatus, 'failed');
  assert.equal(entry?.receipt?.status, 'failed');
  const meta = (entry?.receipt as PendingPayPalReceipt | undefined)?.meta;
  assert.deepEqual(meta, stored.meta);
  assert.equal(entry?.resolution?.resolvedBy, 'operator');
  assert.equal(entry?.resolution?.note, 'duplicate batch id');
  assert.equal(entry?.resolution?.at, NOW);
  assert.equal(entry?.resolution?.previousExternalId, '');
});

test('resolveIntent: succeeded with externalId updates receipt, daily total unchanged', async (t) => {
  const { ledger } = await setup(t);
  const i = intent();
  await recordPendingPaid(ledger, i, pendingPayPalReceipt(i.id) as Receipt);
  assert.equal(await ledger.dailyTotal('agent-1'), 10);

  const result = await resolveIntent(
    i.id,
    ledger,
    { status: 'succeeded', note: 'confirmed on PayPal dashboard', externalId: 'BATCH123' },
    () => new Date(NOW),
  );

  assert.equal(result.status, 'paid');
  assert.equal(result.receipt?.externalId, 'BATCH123');
  assert.equal(result.resolution.previousExternalId, '');
  assert.equal(await ledger.dailyTotal('agent-1'), 10);
});

test('resolveIntent: refunded keeps daily total and paymentStatus paid', async (t) => {
  const { ledger } = await setup(t);
  const i = intent();
  await recordPendingPaid(ledger, i, pendingPayPalReceipt(i.id) as Receipt);
  assert.equal(await ledger.dailyTotal('agent-1'), 10);

  const result = await resolveIntent(i.id, ledger, { status: 'refunded', note: 'chargeback settled' }, () => new Date(NOW));

  assert.equal(result.status, 'paid');
  assert.equal((await ledger.get(i.id))?.paymentStatus, 'paid');
  assert.equal((await ledger.get(i.id))?.receipt?.status, 'refunded');
  assert.equal(await ledger.dailyTotal('agent-1'), 10);
});

test('resolveIntent: resolvedBy default and custom', async (t) => {
  const { ledger } = await setup(t);
  const i = intent({ id: 'by-default' });
  await recordPendingPaid(ledger, i, pendingPayPalReceipt(i.id) as Receipt);
  await resolveIntent(i.id, ledger, { status: 'succeeded', note: 'ok' }, () => new Date(NOW));
  assert.equal((await ledger.get(i.id))?.resolution?.resolvedBy, 'operator');

  const i2 = intent({ id: 'by-custom' });
  await recordPendingPaid(ledger, i2, pendingPayPalReceipt(i2.id) as Receipt);
  await resolveIntent(
    i2.id,
    ledger,
    { status: 'succeeded', note: 'ok', resolvedBy: 'alice@example.com' },
    () => new Date(NOW),
  );
  assert.equal((await ledger.get(i2.id))?.resolution?.resolvedBy, 'alice@example.com');
});

test('resolveIntent: second resolve and missing intent / no receipt errors', async (t) => {
  const { ledger } = await setup(t);
  const i = intent();
  await recordPendingPaid(ledger, i, pendingPayPalReceipt(i.id) as Receipt);
  await resolveIntent(i.id, ledger, { status: 'succeeded', note: 'first' }, () => new Date(NOW));

  await assert.rejects(resolveIntent(i.id, ledger, { status: 'failed', note: 'again' }), (e: unknown) => {
    return e instanceof PaymentError && e.code === 'receipt_not_pending';
  });

  await assert.rejects(resolveIntent('missing', ledger, { status: 'succeeded', note: 'x' }), (e: unknown) => {
    return e instanceof PaymentError && e.code === 'intent_not_found';
  });

  await ledger.recordIntent(intent({ id: 'no-rcpt' }));
  await ledger.recordDecision('no-rcpt', { status: 'approved', reason: 'within_policy: test' });
  await ledger.recordPayment('no-rcpt', 'paid');
  await assert.rejects(resolveIntent('no-rcpt', ledger, { status: 'succeeded', note: 'x' }), (e: unknown) => {
    return e instanceof PaymentError && e.code === 'no_receipt';
  });
});

test('resolveIntent: invalid status or note rejects without ledger change', async (t) => {
  const { ledger, filePath } = await setup(t);
  const i = intent();
  await recordPendingPaid(ledger, i, pendingPayPalReceipt(i.id) as Receipt);
  const before = await readFile(filePath, 'utf8');

  for (const input of [
    { status: 'pending', note: 'ok' },
    { status: 'succeeded', note: '' },
    { status: 'succeeded', note: '   ' },
  ] as ResolveInput[]) {
    await assert.rejects(resolveIntent(i.id, ledger, input), (e: unknown) => {
      return e instanceof TypeError && /^invalid_resolve: /.test(e.message);
    });
  }

  assert.equal(await readFile(filePath, 'utf8'), before);
  assert.equal((await ledger.get(i.id))?.receipt?.status, 'pending');
});
