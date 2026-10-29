import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import {
  DEFAULT_POLICY,
  MAX_BODY_BYTES,
  createMockAdapter,
  createServer,
  loadConfig,
} from '../src/index.ts';

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');

const baseIntent = (over: Record<string, unknown> = {}) => ({
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  ...over,
});

async function startTestServer(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  const now = () => new Date(FIXED_NOW);
  const server: Server = createServer({
    ledger: config.ledgerPath,
    adapter: createMockAdapter({ now }),
    now,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return { base, now };
}

async function readError(res: Response): Promise<{ error: string; message: string }> {
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
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

test('GET /health', async (t) => {
  const { base } = await startTestServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, rail: 'mock' });
});

test('POST /intents paid, rejected, needs_approval', async (t) => {
  const { base } = await startTestServer(t);

  const paidRes = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 10 })),
  });
  assert.equal(paidRes.status, 201);
  const paid = (await paidRes.json()) as {
    status: string;
    replayed?: boolean;
    receipt?: { status: string; rail: string };
    intent: { id: string; createdAt: string };
  };
  assert.equal(paid.status, 'paid');
  assert.equal(paid.replayed, undefined);
  assert.match(paid.intent.id, /^pi_/);
  assert.equal(paid.intent.createdAt, FIXED_NOW.toISOString());
  assert.equal(paid.receipt?.status, 'succeeded');
  assert.equal(paid.receipt?.rail, 'mock');

  const rejRes = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ payee: 'evil-corp' })),
  });
  assert.equal(rejRes.status, 201);
  const rej = (await rejRes.json()) as { status: string; decision: { reason: string } };
  assert.equal(rej.status, 'rejected');
  assert.match(rej.decision.reason, /^payee_not_allowed:/);

  const pendingRes = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 80, id: 'pi_big' })),
  });
  assert.equal(pendingRes.status, 201);
  const pending = (await pendingRes.json()) as { status: string };
  assert.equal(pending.status, 'needs_approval');
});

test('POST /intents replay and intent_conflict', async (t) => {
  const { base } = await startTestServer(t);
  const body = baseIntent({
    id: 'pi_replay',
    createdAt: FIXED_NOW.toISOString(),
    amount: 15,
  });

  const first = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(first.status, 201);

  const second = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(second.status, 200);
  const replay = (await second.json()) as { replayed?: boolean };
  assert.equal(replay.replayed, true);

  const conflict = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, amount: 16 }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await readError(conflict)).error, 'intent_conflict');
});

test('POST approve, reject, and decision errors', async (t) => {
  const { base } = await startTestServer(t);

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 80, id: 'pi_approve' })),
  });

  const approveRes = await fetch(`${base}/intents/pi_approve/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approver: 'alice' }),
  });
  assert.equal(approveRes.status, 200);
  const approved = (await approveRes.json()) as { status: string };
  assert.equal(approved.status, 'paid');

  const again = await fetch(`${base}/intents/pi_approve/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approver: 'alice' }),
  });
  assert.equal(again.status, 409);
  assert.equal((await readError(again)).error, 'already_paid');

  const missing = await fetch(`${base}/intents/nope/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 404);
  assert.equal((await readError(missing)).error, 'intent_not_found');

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 80, id: 'pi_reject_flow' })),
  });

  const rejectRes = await fetch(`${base}/intents/pi_reject_flow/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approver: 'bob', note: 'too pricey' }),
  });
  assert.equal(rejectRes.status, 200);
  const rejected = (await rejectRes.json()) as { status: string; decision: { reason: string } };
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.decision.reason, /^rejected_by_human:/);
  assert.ok(rejected.decision.reason.includes('too pricey'));

  const approveRejected = await fetch(`${base}/intents/pi_reject_flow/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(approveRejected.status, 409);
  assert.equal((await readError(approveRejected)).error, 'not_pending');

  const emptyApprove = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 80, id: 'pi_empty_approve' })),
  });
  assert.equal(emptyApprove.status, 201);

  const noBody = await fetch(`${base}/intents/pi_empty_approve/approve`, { method: 'POST' });
  assert.equal(noBody.status, 200);
  const noBodyResult = (await noBody.json()) as { status: string };
  assert.equal(noBodyResult.status, 'paid');
});

test('validation and payload limits return JSON errors', async (t) => {
  const { base } = await startTestServer(t);
  const post = (body: unknown) =>
    fetch(`${base}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const cases: { body: unknown; label: string }[] = [
    { body: { payee: 'openai-api', amount: 10, currency: 'USD', purpose: 'x' }, label: 'missing agentId' },
    { body: baseIntent({ amount: -1 }), label: 'negative amount' },
    { body: { ...baseIntent(), amount: '10' }, label: 'amount string' },
    { body: { ...baseIntent(), extra: true }, label: 'unknown field' },
    { body: baseIntent({ createdAt: 'not-a-date' }), label: 'bad createdAt' },
    { body: baseIntent({ id: '!!!' }), label: 'bad id' },
  ];

  for (const { body } of cases) {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.equal((await readError(res)).error, 'invalid_body');
  }

  const badJson = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await readError(badJson)).error, 'invalid_json');

  const oversized = 'x'.repeat(MAX_BODY_BYTES + 1);
  const tooLarge = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(oversized)) },
    body: oversized,
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await readError(tooLarge)).error, 'payload_too_large');
});

test('GET /ledger entries and today totals', async (t) => {
  const { base } = await startTestServer(t);

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 10, id: 'pi_paid1' })),
  });
  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ payee: 'evil', id: 'pi_rej' })),
  });
  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 80, id: 'pi_pending' })),
  });
  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      baseIntent({ amount: 25, id: 'pi_yesterday', createdAt: '2026-10-27T12:00:00.000Z' }),
    ),
  });
  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ amount: 5, id: 'pi_paid2' })),
  });

  const res = await fetch(`${base}/ledger`);
  assert.equal(res.status, 200);
  const ledger = (await res.json()) as {
    entries: unknown[];
    today: { day: string; totals: Record<string, Record<string, number>> };
  };
  assert.ok(Array.isArray(ledger.entries));
  assert.equal(ledger.entries.length, 5);
  // Today totals use accountingDay (paid/approved day), so pi_yesterday counts today: 10 + 25 + 5.
  assert.deepEqual(ledger.today, { day: '2026-10-28', totals: { 'demo-agent': { USD: 40 } } });
});

test('GET /ledger includes each entry\'s decision history', async (t) => {
  const { base } = await startTestServer(t);
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await post('/intents', baseIntent({ amount: 10, id: 'pi_auto' }))).status, 201);
  assert.equal((await post('/intents', baseIntent({ amount: 80, id: 'pi_ok' }))).status, 201);
  assert.equal((await post('/intents/pi_ok/approve', { approver: 'alice' })).status, 200);
  assert.equal((await post('/intents', baseIntent({ amount: 80, id: 'pi_no' }))).status, 201);
  assert.equal((await post('/intents/pi_no/reject', { approver: 'bob' })).status, 200);

  const res = await fetch(`${base}/ledger`);
  assert.equal(res.status, 200);
  type Rec = { status: string; reason: string; at?: string; actor?: string };
  const body = (await res.json()) as { entries: { intent: { id: string }; decision: Rec; decisions: Rec[] }[] };
  const byId = new Map(body.entries.map((e) => [e.intent.id, e]));
  const summary = (id: string) =>
    byId.get(id)!.decisions.map((d) => `${d.status}/${d.reason.split(':')[0]}/${d.actor}@${d.at}`);
  const at = FIXED_NOW.toISOString();

  assert.deepEqual(summary('pi_auto'), [`approved/within_policy/policy@${at}`]);
  assert.deepEqual(summary('pi_ok'), [
    `needs_approval/approval_required/policy@${at}`,
    `approved/approved_by_human/alice@${at}`,
  ]);
  assert.deepEqual(summary('pi_no'), [
    `needs_approval/approval_required/policy@${at}`,
    `rejected/rejected_by_human/bob@${at}`,
  ]);
  // entry.decision is still the latest decision, in its original shape.
  assert.deepEqual(Object.keys(byId.get('pi_ok')!.decision).sort(), ['reason', 'status']);
  assert.equal(byId.get('pi_ok')!.decision.reason, byId.get('pi_ok')!.decisions.at(-1)!.reason);
});

test('GET and PUT /policy', async (t) => {
  const { base } = await startTestServer(t);

  const get0 = await fetch(`${base}/policy`);
  assert.equal(get0.status, 200);
  assert.deepEqual(await get0.json(), DEFAULT_POLICY);

  const badMissingPayees = await fetch(`${base}/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...DEFAULT_POLICY, allowedPayees: undefined }),
  });
  assert.equal(badMissingPayees.status, 400);
  assert.equal((await readError(badMissingPayees)).error, 'invalid_body');

  const badPerTx = await fetch(`${base}/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...DEFAULT_POLICY, perTxMax: -1 }),
  });
  assert.equal(badPerTx.status, 400);

  const badShape = await fetch(`${base}/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([]),
  });
  assert.equal(badShape.status, 400);

  const unchanged = await fetch(`${base}/policy`);
  assert.deepEqual(await unchanged.json(), DEFAULT_POLICY);

  const validPolicy = {
    ...DEFAULT_POLICY,
    requireApprovalAbove: 5,
    allowedPayees: ['new-payee'],
  };
  const putOk = await fetch(`${base}/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validPolicy),
  });
  assert.equal(putOk.status, 200);
  assert.deepEqual(await putOk.json(), validPolicy);

  const needs = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ payee: 'new-payee', amount: 10 })),
  });
  const needsBody = (await needs.json()) as { status: string };
  assert.equal(needsBody.status, 'needs_approval');

  const rej = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseIntent({ payee: 'openai-api', amount: 10 })),
  });
  const rejBody = (await rej.json()) as { status: string; decision: { reason: string } };
  assert.equal(rejBody.status, 'rejected');
  assert.match(rejBody.decision.reason, /^payee_not_allowed:/);
});

test('CORS allowed and disallowed origins', async (t) => {
  const { base } = await startTestServer(t);

  const allowed = [
    { origin: 'http://localhost:5173', expect: 'http://localhost:5173' },
    { origin: 'http://127.0.0.1:3000', expect: 'http://127.0.0.1:3000' },
  ];
  for (const { origin, expect } of allowed) {
    const res = await fetch(`${base}/health`, { headers: { Origin: origin } });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), expect);
  }

  for (const origin of ['https://evil.example', 'http://localhost.evil.com']) {
    const res = await fetch(`${base}/health`, { headers: { Origin: origin } });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }

  const preflightOk = await fetch(`${base}/intents`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(preflightOk.status, 204);
  assert.equal(preflightOk.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  assert.match(preflightOk.headers.get('Access-Control-Allow-Methods') ?? '', /POST/);
  assert.match(preflightOk.headers.get('Access-Control-Allow-Headers') ?? '', /Content-Type/);

  const preflightBad = await fetch(`${base}/intents`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(preflightBad.status, 204);
  assert.equal(preflightBad.headers.get('Access-Control-Allow-Origin'), null);
});

test('unknown route and method not allowed', async (t) => {
  const { base } = await startTestServer(t);

  const nope = await fetch(`${base}/nope`);
  assert.equal(nope.status, 404);
  assert.equal((await readError(nope)).error, 'not_found');

  const delPolicy = await fetch(`${base}/policy`, { method: 'DELETE' });
  assert.equal(delPolicy.status, 405);
  assert.equal((await readError(delPolicy)).error, 'method_not_allowed');
  assert.ok(delPolicy.headers.get('Allow')?.includes('GET'));

  const getIntents = await fetch(`${base}/intents`);
  assert.equal(getIntents.status, 405);
  assert.equal((await readError(getIntents)).error, 'method_not_allowed');
});
