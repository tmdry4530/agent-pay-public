import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createMockAdapter, createServer, loadConfig } from '../src/index.ts';
import { DEFAULT_POLICY } from '../src/policy-defaults.ts';

const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');

async function startTestServer(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-payees-'));
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
  return { base };
}

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
  assert.equal(typeof record.error, 'string');
  assert.equal(typeof record.message, 'string');
  const error = record.error as string;
  const message = record.message as string;
  assert.ok(error.length > 0 && !error.includes(':'));
  assert.ok(message.length > 0);
  return { error, message };
}

async function readApiError(res: Response): Promise<{ error: string; message: string }> {
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  return parseApiErrorBody(await res.json());
}

function putJson(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/policy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function assertPolicyUnchangedAfterInvalidPut(
  base: string,
  allowedPayees: string[],
  opts: { messageMatch?: RegExp } = {},
): Promise<void> {
  const before = await fetch(`${base}/policy`);
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), DEFAULT_POLICY);

  const res = await putJson(base, { ...DEFAULT_POLICY, allowedPayees });
  assert.equal(res.status, 400);
  const err = await readApiError(res);
  assert.equal(err.error, 'invalid_policy');
  if (opts.messageMatch) assert.match(err.message, opts.messageMatch);

  const after = await fetch(`${base}/policy`);
  assert.equal(after.status, 200);
  assert.deepEqual(await after.json(), DEFAULT_POLICY);
}

test('PUT /policy duplicate allowedPayees is 400 invalid_policy and policy stays', async (t) => {
  const { base } = await startTestServer(t);
  await assertPolicyUnchangedAfterInvalidPut(base, ['openai-api', 'openai-api'], {
    messageMatch: /duplicate/i,
  });
});

test('PUT /policy allowedPayees with leading or trailing whitespace is 400 invalid_policy and policy stays', async (t) => {
  const { base } = await startTestServer(t);
  for (const allowedPayees of [[' openai-api'], ['openai-api ']] as const) {
    await assertPolicyUnchangedAfterInvalidPut(base, [...allowedPayees], {
      messageMatch: /whitespace/i,
    });
  }
});

test('PUT /policy allowedPayees empty string is 400 invalid_policy and policy stays', async (t) => {
  const { base } = await startTestServer(t);
  await assertPolicyUnchangedAfterInvalidPut(base, ['']);
});

test('PUT /policy allowedPayees whitespace-only entry is 400 invalid_policy and policy stays', async (t) => {
  const { base } = await startTestServer(t);
  await assertPolicyUnchangedAfterInvalidPut(base, ['   ']);
});

test('PUT /policy with distinct allowedPayees is 200', async (t) => {
  const { base } = await startTestServer(t);
  const valid = {
    ...DEFAULT_POLICY,
    allowedPayees: ['openai-api', 'anthropic-api', 'custom-vendor'],
  };
  const res = await putJson(base, valid);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), valid);

  const get = await fetch(`${base}/policy`);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), valid);
});
