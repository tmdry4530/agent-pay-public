import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  Ledger,
  LedgerError,
  reasonCode,
  type Decision,
  type LedgerEntry,
  type LedgerErrorCode,
  type PaymentAdapter,
  type PaymentIntent,
  type Policy,
  type Receipt,
} from '@agent-pay/core';
import { DEFAULT_POLICY, createApp, createMockAdapter, createServer, loadConfig } from '../src/index.ts';

/**
 * New error body is exactly {"error":"<bare code>","message":"<detail>"} — those
 * two keys only. `error` is a non-empty machine code with no ":". `message` is a
 * non-empty detail. app.ts today still sends {"error":"<code>: <detail>"} for
 * several of these, so most cases fail until that mapping lands. Unknown routes
 * keep code `not_found` (HttpError 404, detail `no route for …`).
 *
 * GET /ledger `today.totals` is keyed by agentId. Each value is the per-currency
 * object from Ledger.dailyTotals (no totalsByCurrency, no currency scalar).
 */

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');
const AGENT = 'demo-agent';

const baseIntent = (over: Record<string, unknown> = {}) => ({
  agentId: AGENT,
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  ...over,
});

class ThrowingListLedger extends Ledger {
  readonly #code: LedgerErrorCode;

  constructor(filePath: string, code: LedgerErrorCode) {
    super({ filePath, now: () => new Date(FIXED_NOW) });
    this.#code = code;
  }

  override async list(): Promise<LedgerEntry[]> {
    throw new LedgerError(this.#code, 'x');
  }
}

type SlowPay = {
  adapter: PaymentAdapter;
  payCalls: { n: number };
  waitUntilPayEntered: () => Promise<void>;
  releasePay: () => void;
};

function createSlowPayAdapter(now: () => Date): SlowPay {
  const payCalls = { n: 0 };
  const inner = createMockAdapter({ now });
  let enteredResolve!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let releasePay!: () => void;
  const payGate = new Promise<void>((resolve) => {
    releasePay = resolve;
  });
  const adapter: PaymentAdapter = {
    rail: inner.rail,
    async pay(intent: PaymentIntent): Promise<Receipt> {
      payCalls.n += 1;
      enteredResolve();
      await payGate;
      return inner.pay(intent);
    },
  };
  return {
    adapter,
    payCalls,
    waitUntilPayEntered: () => enteredPromise,
    releasePay: () => releasePay(),
  };
}

function createCountingMockAdapter(now: () => Date): { adapter: PaymentAdapter; payCalls: { n: number } } {
  const payCalls = { n: 0 };
  const inner = createMockAdapter({ now });
  const adapter: PaymentAdapter = {
    rail: inner.rail,
    async pay(intent: PaymentIntent): Promise<Receipt> {
      payCalls.n += 1;
      return inner.pay(intent);
    },
  };
  return { adapter, payCalls };
}

type StartOpts = {
  adapter?: PaymentAdapter;
  policy?: Policy;
  /** GET /ledger calls list(); that call throws LedgerError(code, 'x'). */
  throwOnList?: LedgerErrorCode;
};

async function startTestServer(t: { after: (fn: () => Promise<void>) => void }, opts: StartOpts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-map-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  const now = () => new Date(FIXED_NOW);
  const ledger: Ledger | string = opts.throwOnList
    ? new ThrowingListLedger(config.ledgerPath, opts.throwOnList)
    : config.ledgerPath;
  const server: Server = createServer({
    ledger,
    adapter: opts.adapter ?? createMockAdapter({ now }),
    now,
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return { base };
}

/** Exactly `{error, message}`: both non-empty strings, `error` a bare code (no ":"). */
function parseApiErrorBody(body: unknown): { error: string; message: string } {
  assert.ok(
    body !== null && typeof body === 'object' && !Array.isArray(body),
    `expected {"error","message"} JSON, got ${JSON.stringify(body)}`,
  );
  const record = body as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(record).sort(),
    ['error', 'message'],
    `error body must have exactly keys error and message, got ${JSON.stringify(body)}`,
  );
  assert.equal(typeof record.error, 'string', `error must be a string, got ${JSON.stringify(body)}`);
  assert.equal(typeof record.message, 'string', `message must be a string, got ${JSON.stringify(body)}`);
  const error = record.error as string;
  const message = record.message as string;
  assert.ok(error.length > 0, 'error must be a non-empty string');
  assert.ok(message.length > 0, 'message must be a non-empty string');
  assert.equal(error.includes(':'), false, `error must be a bare code, got ${JSON.stringify(error)}`);
  return { error, message };
}

/** New contract: bare `error` code plus a non-empty `message`, and no other keys. */
async function readApiError(res: Response): Promise<{ error: string; message: string }> {
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  return parseApiErrorBody(await res.json());
}

function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function putJson(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type LedgerView = {
  entries: {
    intent: { id: string; agentId: string; amount: number; currency: string; createdAt: string };
    needsManualResolve?: true;
    receipt?: { status: string };
    paymentStatus?: string;
  }[];
  today: {
    day: string;
    totals: Record<string, Record<string, number>>;
  };
};

async function getLedger(base: string): Promise<LedgerView> {
  const res = await fetch(`${base}/ledger`);
  assert.equal(res.status, 200);
  return (await res.json()) as LedgerView;
}

const LEDGER_CASES: { code: LedgerErrorCode; status: number; retry?: boolean }[] = [
  { code: 'precondition_failed', status: 409 },
  { code: 'not_found', status: 404 },
  { code: 'duplicate_intent', status: 409 },
  { code: 'invalid_input', status: 400 },
  { code: 'lock_timeout', status: 503, retry: true },
  { code: 'ledger_corrupt', status: 503 },
  { code: 'ledger_missing', status: 503 },
];

for (const spec of LEDGER_CASES) {
  test(`LedgerError ${spec.code} on GET /ledger is ${spec.status}`, async (t) => {
    const { base } = await startTestServer(t, { throwOnList: spec.code });
    const res = await fetch(`${base}/ledger`);
    assert.equal(res.status, spec.status);
    if (spec.retry) {
      const retryAfter = res.headers.get('retry-after');
      assert.ok(
        retryAfter !== null && /^[1-9]\d*$/.test(retryAfter),
        `Retry-After must be delta-seconds (e.g. "1"), got ${JSON.stringify(retryAfter)}`,
      );
    }
    const err = await readApiError(res);
    assert.equal(err.error, spec.code);
    if (spec.retry) assert.match(err.message, /retry/i);
  });
}

test('approve twice is 409 already_paid', async (t) => {
  const { base } = await startTestServer(t);
  const created = await postJson(base, '/intents', baseIntent({ amount: 80, id: 'pi_map_approve' }));
  assert.equal(created.status, 201);

  const first = await postJson(base, '/intents/pi_map_approve/approve', { approver: 'alice' });
  assert.equal(first.status, 200);
  const paid = (await first.json()) as { status: string };
  assert.equal(paid.status, 'paid');

  const again = await postJson(base, '/intents/pi_map_approve/approve', { approver: 'alice' });
  assert.equal(again.status, 409);
  const err = await readApiError(again);
  assert.equal(err.error, 'already_paid');
});

test('approve after reject is 409 not_pending', async (t) => {
  const { base } = await startTestServer(t);
  const created = await postJson(base, '/intents', baseIntent({ amount: 80, id: 'pi_map_reject' }));
  assert.equal(created.status, 201);

  const rejected = await postJson(base, '/intents/pi_map_reject/reject', { approver: 'bob', note: 'no' });
  assert.equal(rejected.status, 200);

  const approve = await postJson(base, '/intents/pi_map_reject/approve', { approver: 'alice' });
  assert.equal(approve.status, 409);
  const err = await readApiError(approve);
  assert.equal(err.error, 'not_pending');
});

test('replay while pay() is in flight is 409 in_progress', { timeout: 10_000 }, async (t) => {
  const now = () => new Date(FIXED_NOW);
  const slow = createSlowPayAdapter(now);
  const { base } = await startTestServer(t, { adapter: slow.adapter });
  const payload = baseIntent({
    id: 'pi_submitting',
    amount: 10,
    createdAt: FIXED_NOW.toISOString(),
  });
  const first = postJson(base, '/intents', payload);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slow.releasePay();
  };
  t.after(async () => {
    release();
    await first.catch(() => undefined);
  });

  await slow.waitUntilPayEntered();
  const secondPromise = postJson(base, '/intents', payload);
  // A server that does not answer 409 holds this request inside pay() until the
  // 60s rail timeout. Release the gate so the response settles and the assertion
  // fails instead of hanging.
  const failFast = setTimeout(release, 1_500);
  try {
    const second = await secondPromise;
    assert.equal(slow.payCalls.n, 1);
    assert.equal(second.status, 409);
    const err = await readApiError(second);
    assert.equal(err.error, 'in_progress');

    release();
    const firstRes = await first;
    assert.equal(firstRes.status, 201);
  } finally {
    clearTimeout(failFast);
    release();
    await first.catch(() => undefined);
  }
});

test('refresh of needsManualResolve is 409 status_unsupported and points at resolve', async (t) => {
  const adapter: PaymentAdapter = {
    rail: 'mock',
    async pay(): Promise<Receipt> {
      throw new Error('rail down');
    },
  };
  const { base } = await startTestServer(t, { adapter });
  const created = await postJson(base, '/intents', baseIntent({ id: 'pi_manual', amount: 10 }));
  assert.equal(created.status, 201);

  const ledger = await getLedger(base);
  const entry = ledger.entries.find((e) => e.intent.id === 'pi_manual');
  assert.ok(entry);
  assert.equal(entry.needsManualResolve, true);
  assert.equal(entry.receipt?.status, 'pending');

  const refresh = await fetch(`${base}/intents/pi_manual/refresh`, { method: 'POST' });
  assert.equal(refresh.status, 409);
  const err = await readApiError(refresh);
  assert.equal(err.error, 'status_unsupported');
  assert.ok(err.message.includes('POST /intents/'), `message should name POST /intents/, got ${JSON.stringify(err.message)}`);
  assert.ok(err.message.includes('/resolve'), `message should name /resolve, got ${JSON.stringify(err.message)}`);
});

test('USD amount with more than 2 decimals is 400 invalid_amount and is not recorded', async (t) => {
  const now = () => new Date(FIXED_NOW);
  const counting = createCountingMockAdapter(now);
  const { base } = await startTestServer(t, { adapter: counting.adapter });

  const res = await postJson(base, '/intents', baseIntent({ amount: 10.005, currency: 'USD', id: 'pi_subcent' }));
  assert.equal(res.status, 400);
  const err = await readApiError(res);
  assert.equal(err.error, 'invalid_amount');
  assert.equal(counting.payCalls.n, 0);

  const ledger = await getLedger(base);
  assert.equal(ledger.entries.length, 0);
});

test('USD amount 10.5 (2 decimals or fewer) is still 201', async (t) => {
  const { base } = await startTestServer(t);
  const res = await postJson(base, '/intents', baseIntent({ amount: 10.5, currency: 'USD', id: 'pi_half' }));
  assert.equal(res.status, 201);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, 'paid');
});

test('PUT /policy perTxMax 10.005 USD is 400 invalid_policy and policy stays', async (t) => {
  const { base } = await startTestServer(t);
  const before = await fetch(`${base}/policy`);
  assert.deepEqual(await before.json(), DEFAULT_POLICY);

  const res = await putJson(base, { ...DEFAULT_POLICY, perTxMax: 10.005 });
  assert.equal(res.status, 400);
  const err = await readApiError(res);
  assert.equal(err.error, 'invalid_policy');

  const after = await fetch(`${base}/policy`);
  assert.deepEqual(await after.json(), DEFAULT_POLICY);
});

test('PUT /policy currency XYZ is 400 invalid_policy and policy stays', async (t) => {
  const { base } = await startTestServer(t);
  const res = await putJson(base, { ...DEFAULT_POLICY, currency: 'XYZ' });
  assert.equal(res.status, 400);
  const err = await readApiError(res);
  assert.equal(err.error, 'invalid_policy');

  const after = await fetch(`${base}/policy`);
  assert.deepEqual(await after.json(), DEFAULT_POLICY);
});

test('PUT /policy with a malformed perTxMax is still 400', async (t) => {
  const { base } = await startTestServer(t);
  const res = await putJson(base, { ...DEFAULT_POLICY, perTxMax: 'abc' });
  assert.equal(res.status, 400);
  const err = await readApiError(res);
  assert.ok(
    err.error === 'invalid_body' || err.error === 'invalid_policy',
    `expected invalid_body or invalid_policy, got ${JSON.stringify(err.error)}`,
  );

  const after = await fetch(`${base}/policy`);
  assert.deepEqual(await after.json(), DEFAULT_POLICY);
});

test('PUT /policy with a valid policy is 200', async (t) => {
  const { base } = await startTestServer(t);
  const valid = { ...DEFAULT_POLICY, perTxMax: 40, requireApprovalAbove: 5 };
  const res = await putJson(base, valid);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), valid);
});

test('invalid initial policy rejects the intent with reason invalid_policy', async (t) => {
  // createApp stores options.policy via structuredClone and does not run policyProblem,
  // so a NaN dailyMax reaches evaluate. If startup starts rejecting that policy, skip
  // this case instead of asserting a 201.
  const { base } = await startTestServer(t, {
    policy: { ...DEFAULT_POLICY, dailyMax: Number.NaN },
  });
  const res = await postJson(base, '/intents', baseIntent({ id: 'pi_bad_policy', amount: 10 }));
  assert.equal(res.status, 201);
  const body = (await res.json()) as { status: string; decision: Decision };
  assert.equal(body.status, 'rejected');
  assert.equal(body.decision.status, 'rejected');
  assert.equal(reasonCode(body.decision), 'invalid_policy');
});

test('GET /ledger today.totals is keyed by agentId with per-currency amounts', async (t) => {
  const { base } = await startTestServer(t);

  const usd = await postJson(base, '/intents', baseIntent({ id: 'pi_usd', amount: 10, currency: 'USD' }));
  assert.equal(usd.status, 201);
  assert.equal(((await usd.json()) as { status: string }).status, 'paid');

  const nearPolicy = { ...DEFAULT_POLICY, currency: 'NEAR' };
  const switched = await putJson(base, nearPolicy);
  assert.equal(switched.status, 200);

  const near = await postJson(base, '/intents', baseIntent({ id: 'pi_near', amount: 5, currency: 'NEAR' }));
  assert.equal(near.status, 201);
  assert.equal(((await near.json()) as { status: string }).status, 'paid');

  const back = await putJson(base, DEFAULT_POLICY);
  assert.equal(back.status, 200);

  const ledger = await getLedger(base);
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.today.day, '2026-10-28');
  assert.deepEqual(ledger.today.totals[AGENT], { USD: 10, NEAR: 5 });
});

test('intent createdAt on a past day still counts today when it was approved today', async (t) => {
  const { base } = await startTestServer(t);
  const created = await postJson(
    base,
    '/intents',
    baseIntent({ id: 'pi_backdated', amount: 10, currency: 'USD', createdAt: '2026-10-27T23:30:00.000Z' }),
  );
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { status: string }).status, 'paid');

  const ledger = await getLedger(base);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.today.day, '2026-10-28');
  assert.deepEqual(ledger.today.totals[AGENT], { USD: 10 });
});

test('non-JSON Content-Type with a non-empty body is 415 unsupported_media_type', async (t) => {
  const { base } = await startTestServer(t);
  const res = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(baseIntent({ id: 'pi_text' })),
  });
  assert.equal(res.status, 415);
  const err = await readApiError(res);
  assert.equal(err.error, 'unsupported_media_type');
});

test('listener last-resort failure is 500 internal_error with a message', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-map-l1-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const { listener } = createApp({
    ledger: config.ledgerPath,
    adapter: createMockAdapter({ now: () => new Date(FIXED_NOW) }),
  });

  const req = new Readable({
    read() {
      this.push(null);
    },
  }) as IncomingMessage;
  req.method = 'GET';
  req.url = '/health';
  req.headers = {};

  let writeHeadCalls = 0;
  let statusCode = 0;
  let headersOut: Record<string, unknown> = {};
  let bodyOut = '';

  type FakeResponse = {
    headersSent: boolean;
    writeHead(
      status: number,
      headers?: Record<string, unknown> | string,
      maybeHeaders?: Record<string, unknown>,
    ): FakeResponse;
    end(chunk?: string): void;
  };

  const res: FakeResponse = {
    headersSent: false,
    writeHead(status, headers, maybeHeaders) {
      writeHeadCalls += 1;
      if (writeHeadCalls <= 2) throw new Error('simulated response write failure');
      this.headersSent = true;
      statusCode = status;
      if (typeof headers === 'object' && headers !== null) headersOut = headers;
      else if (typeof maybeHeaders === 'object' && maybeHeaders !== null) headersOut = maybeHeaders;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) bodyOut += chunk;
    },
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listener did not finish')), 5000);
    listener(req, res as unknown as ServerResponse);
    const wait = () => {
      if (writeHeadCalls >= 3) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setImmediate(wait);
    };
    setImmediate(wait);
  });

  assert.ok(writeHeadCalls >= 3);
  assert.equal(statusCode, 500);
  const ct = String(headersOut['Content-Type'] ?? headersOut['content-type'] ?? '');
  assert.match(ct, /application\/json/i);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyOut);
  } catch {
    assert.fail(`last-resort body is not JSON: ${JSON.stringify(bodyOut)}`);
  }
  const err = parseApiErrorBody(parsed);
  assert.equal(err.error, 'internal_error');
});

test('forbidden Origin is 403 forbidden_origin', async (t) => {
  const { base } = await startTestServer(t);
  const res = await postJson(base, '/intents', baseIntent({ id: 'pi_origin' }), {
    Origin: 'https://evil.example',
  });
  assert.equal(res.status, 403);
  const err = await readApiError(res);
  assert.equal(err.error, 'forbidden_origin');
});

test('invalid JSON is 400 invalid_json', async (t) => {
  const { base } = await startTestServer(t);
  const res = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(res.status, 400);
  const err = await readApiError(res);
  assert.equal(err.error, 'invalid_json');
});

test('unknown route is 404 not_found', async (t) => {
  const { base } = await startTestServer(t);
  const res = await fetch(`${base}/no-such-route`);
  assert.equal(res.status, 404);
  const err = await readApiError(res);
  assert.equal(err.error, 'not_found');
});
