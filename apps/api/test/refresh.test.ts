import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { PaymentAdapter, PaymentIntent, Receipt } from '@agent-pay/core';
import { createServer, loadConfig } from '../src/index.ts';

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');

const baseIntent = (over: Record<string, unknown> = {}) => ({
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  createdAt: FIXED_NOW.toISOString(),
  ...over,
});

function createPendingStatusAdapter(opts: {
  statusSequence?: (receipt: Receipt, n: number) => Receipt | Promise<Receipt>;
  throwOnStatus?: boolean;
}): PaymentAdapter {
  let statusCalls = 0;
  return {
    rail: 'mock',
    async pay(intent: PaymentIntent): Promise<Receipt> {
      return {
        intentId: intent.id,
        rail: 'mock',
        externalId: `mock_${intent.id}`,
        status: 'pending',
        at: FIXED_NOW.toISOString(),
      };
    },
    async status(receipt: Receipt): Promise<Receipt> {
      statusCalls += 1;
      if (opts.throwOnStatus) throw new Error('status exploded');
      if (opts.statusSequence) return opts.statusSequence(receipt, statusCalls);
      return { ...receipt, status: statusCalls === 1 ? 'pending' : 'succeeded' };
    },
  };
}

async function startServer(
  t: { after: (fn: () => Promise<void>) => void },
  adapter: PaymentAdapter,
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-refresh-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  const now = () => new Date(FIXED_NOW);
  const server: Server = createServer({ ledger: config.ledgerPath, adapter, now });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return base;
}

async function readError(res: Response): Promise<{ error: string; message: string }> {
  const body: unknown = await res.json();
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body));
  const record = body as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ['error', 'message']);
  assert.equal(typeof record.error, 'string');
  assert.equal(typeof record.message, 'string');
  const error = record.error as string;
  const message = record.message as string;
  assert.ok(error.length > 0 && !error.includes(':'));
  assert.ok(message.length > 0);
  return { error, message };
}

test('refresh pending -> pending then succeeded', async (t) => {
  const base = await startServer(t, createPendingStatusAdapter({}));
  const create = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_refresh_ok' })),
  });
  assert.equal(create.status, 201);
  const created = (await create.json()) as { status: string; receipt: { status: string } };
  assert.equal(created.status, 'paid');
  assert.equal(created.receipt.status, 'pending');

  const first = await fetch(`${base}/intents/pi_refresh_ok/refresh`, { method: 'POST' });
  assert.equal(first.status, 200);
  const r1 = (await first.json()) as { changed: boolean; status: string; receipt: { status: string } };
  assert.equal(r1.changed, false);
  assert.equal(r1.receipt.status, 'pending');

  const second = await fetch(`${base}/intents/pi_refresh_ok/refresh`, { method: 'POST' });
  assert.equal(second.status, 200);
  const r2 = (await second.json()) as Record<string, unknown> & { changed: boolean; status: string; receipt: { status: string } };
  assert.equal(r2.changed, true);
  assert.equal(r2.status, 'paid');
  assert.equal(r2.receipt.status, 'succeeded');
  // Same PaymentResult shape as /approve, plus `changed`.
  assert.deepEqual(Object.keys(r2).sort(), ['changed', 'decision', 'intentId', 'receipt', 'status']);
  assert.equal(r2.intentId, 'pi_refresh_ok');
});

test('refresh pending -> failed drops today totals', async (t) => {
  const base = await startServer(
    t,
    createPendingStatusAdapter({
      statusSequence: (r) => ({ ...r, status: 'failed' }),
    }),
  );
  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_fail', amount: 10 })),
  });
  const ledgerBefore = (await (await fetch(`${base}/ledger`)).json()) as { today: { totals: Record<string, number> } };
  assert.equal(ledgerBefore.today.totals['demo-agent'], 10);

  const res = await fetch(`${base}/intents/pi_fail/refresh`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; error?: string };
  assert.equal(body.status, 'failed');
  assert.match(body.error ?? '', /^payment_declined:/);

  const ledgerAfter = (await (await fetch(`${base}/ledger`)).json()) as { today: { totals: Record<string, number> } };
  assert.equal(ledgerAfter.today.totals['demo-agent'], undefined);
});

test('refresh errors: 404, 409 no_receipt, 409 settled, 409 unsupported, 502', async (t) => {
  const pendingOnly: PaymentAdapter = {
    rail: 'mock',
    async pay(intent) {
      return {
        intentId: intent.id,
        rail: 'mock',
        externalId: 'x',
        status: 'pending',
        at: FIXED_NOW.toISOString(),
      };
    },
  };
  const basePlain = await startServer(t, pendingOnly);
  const missing = await fetch(`${basePlain}/intents/nope/refresh`, { method: 'POST' });
  assert.equal(missing.status, 404);

  await fetch(`${basePlain}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ payee: 'evil-corp', id: 'pi_rej' })),
  });
  const noReceipt = await fetch(`${basePlain}/intents/pi_rej/refresh`, { method: 'POST' });
  assert.equal(noReceipt.status, 409);
  assert.equal((await readError(noReceipt)).error, 'no_receipt');

  const baseSettle = await startServer(
    t,
    createPendingStatusAdapter({ statusSequence: (r) => ({ ...r, status: 'succeeded' }) }),
  );
  await fetch(`${baseSettle}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_done' })),
  });
  await fetch(`${baseSettle}/intents/pi_done/refresh`, { method: 'POST' });
  const settled = await fetch(`${baseSettle}/intents/pi_done/refresh`, { method: 'POST' });
  assert.equal(settled.status, 409);
  assert.equal((await readError(settled)).error, 'receipt_not_pending');

  await fetch(`${basePlain}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_unsup' })),
  });
  const unsupported = await fetch(`${basePlain}/intents/pi_unsup/refresh`, { method: 'POST' });
  assert.equal(unsupported.status, 409);
  assert.equal((await readError(unsupported)).error, 'status_unsupported');

  const baseThrow = await startServer(t, createPendingStatusAdapter({ throwOnStatus: true }));
  await fetch(`${baseThrow}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_boom' })),
  });
  const boom = await fetch(`${baseThrow}/intents/pi_boom/refresh`, { method: 'POST' });
  assert.equal(boom.status, 502);
  assert.equal((await readError(boom)).error, 'status_check_failed');

  const baseMismatch = await startServer(
    t,
    createPendingStatusAdapter({ statusSequence: (r) => ({ ...r, rail: 'paypal', status: 'succeeded' }) }),
  );
  await fetch(`${baseMismatch}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ id: 'pi_mismatch' })),
  });
  const mismatch = await fetch(`${baseMismatch}/intents/pi_mismatch/refresh`, { method: 'POST' });
  assert.equal(mismatch.status, 502);
  const mismatchErr = await readError(mismatch);
  assert.equal(mismatchErr.error, 'status_check_failed');
  assert.match(mismatchErr.message, /^receipt_mismatch:/);
  const after = (await (await fetch(`${baseMismatch}/ledger`)).json()) as { entries: { receipt?: { status: string; rail: string } }[] };
  assert.deepEqual(after.entries[0]?.receipt && [after.entries[0].receipt.status, after.entries[0].receipt.rail], ['pending', 'mock']);
});
