import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createMockAdapter, createServer } from '@agent-pay/api';
import {
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_CHAT_URL,
  OpenRouterPlanner,
  createPlanner,
  redactOpenRouterSecrets,
  runAgent,
  type AgentEvent,
  type Quote,
} from '../src/index.ts';

// Built at runtime so the repo's sk-or- secret scan never matches a literal in this file. Not a real key.
const FAKE_KEY = ['sk', 'or', 'v1', 'unit0test0only0not0a0real0key0000000000'].join('-');
const CTX = { agentId: 'demo-agent', currency: 'USD' };

interface Call {
  url: string;
  init: RequestInit;
}

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ id: 'gen-test', choices: [{ index: 0, message: { role: 'assistant', content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fn, calls };
}

function assertNoKey(value: unknown): void {
  assert.ok(!JSON.stringify(value).includes(FAKE_KEY), 'API key must not appear in the plan/trace');
}

test('success: valid JSON proposal becomes the quote; request is a plain Chat Completions POST', async () => {
  const { fetch, calls } = mockFetch(() =>
    chatResponse('{"payee":"openai-api","amount":10,"currency":"USD","purpose":"1M GPT tokens"}'),
  );
  const planner = new OpenRouterPlanner({ apiKey: FAKE_KEY, fetch });
  const quote = await planner.plan('buy 1M tokens of GPT inference', CTX);

  assert.equal(quote.payee, 'openai-api');
  assert.equal(quote.amount, 10);
  assert.equal(quote.currency, 'USD');
  assert.equal(quote.purpose, `1M GPT tokens (openrouter ${DEFAULT_OPENROUTER_MODEL})`);
  assert.deepEqual(quote.trace, { planner: 'openrouter', model: DEFAULT_OPENROUTER_MODEL });
  assertNoKey(quote);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, OPENROUTER_CHAT_URL);
  assert.equal(OPENROUTER_CHAT_URL, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0]!.init.method, 'POST');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${FAKE_KEY}`);
  const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; messages: Array<{ role: string; content: string }> };
  assert.equal(body.model, DEFAULT_OPENROUTER_MODEL);
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(body.messages[1]!.content, 'buy 1M tokens of GPT inference');
  assert.ok(!JSON.stringify(body).includes(FAKE_KEY), 'key only in the Authorization header');
});

test('OPENROUTER_MODEL overrides the model; fenced JSON is accepted', async () => {
  const { fetch, calls } = mockFetch(() =>
    chatResponse('```json\n{"payee":"vercel","amount":40,"currency":"usd","purpose":"2 deploys"}\n```'),
  );
  const planner = createPlanner('llm', { env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_MODEL: 'some/model-id' }, fetch });
  const quote = await planner.plan('2 vercel deploys', CTX);
  assert.equal(quote.payee, 'vercel');
  assert.equal(quote.currency, 'USD');
  assert.equal(quote.trace?.model, 'some/model-id');
  assert.equal((JSON.parse(String(calls[0]!.init.body)) as { model: string }).model, 'some/model-id');
});

test('missing key: no network call, rule-based quote with the fallback recorded', async () => {
  const { fetch, calls } = mockFetch(() => {
    throw new Error('must not be called');
  });
  for (const env of [{}, { OPENROUTER_API_KEY: '' }, { OPENROUTER_API_KEY: '   ' }]) {
    const quote = await createPlanner('llm', { env, fetch }).plan('buy 1M tokens of GPT inference', CTX);
    assert.equal(quote.amount, 10);
    assert.equal(quote.payee, 'openai-api');
    assert.equal(quote.trace?.planner, 'rule-based');
    assert.deepEqual(quote.trace?.fallback, { from: 'openrouter', reason: 'missing_api_key: OPENROUTER_API_KEY is not set' });
  }
  assert.equal(calls.length, 0);
});

test('HTTP error: falls back; reason has the status and a redacted message, never the key', async () => {
  const { fetch } = mockFetch(
    () =>
      new Response(JSON.stringify({ error: { code: 401, message: `Invalid key ${FAKE_KEY} (Authorization: Bearer ${FAKE_KEY})` } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const quote = await new OpenRouterPlanner({ apiKey: FAKE_KEY, fetch }).plan('buy 1M tokens of GPT inference', CTX);
  assert.equal(quote.trace?.planner, 'rule-based');
  assert.match(quote.trace!.fallback!.reason, /^http_401: Invalid key \[redacted\]/);
  assertNoKey(quote);

  const { fetch: fetch500 } = mockFetch(() => new Response('upstream down', { status: 502 }));
  const q2 = await new OpenRouterPlanner({ apiKey: FAKE_KEY, fetch: fetch500 }).plan('buy 1M tokens of GPT inference', CTX);
  assert.equal(q2.trace?.fallback?.reason, 'http_502');
});

test('network error and timeout: fall back', async () => {
  const { fetch: broken } = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  const q1 = await new OpenRouterPlanner({ apiKey: FAKE_KEY, fetch: broken }).plan('buy 1M tokens of GPT inference', CTX);
  assert.equal(q1.trace?.fallback?.reason, 'network_error: TypeError');

  const hang: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const q2 = await new OpenRouterPlanner({ apiKey: FAKE_KEY, fetch: hang, timeoutMs: 20 }).plan('buy 1M tokens of GPT inference', CTX);
  assert.equal(q2.trace?.fallback?.reason, 'timeout: no response within 20 ms');
  assert.equal(q2.amount, 10);
});

test('malformed or off-schema output: falls back with the reason', async () => {
  const cases: Array<[string, RegExp]> = [
    ['not json at all', /^invalid_json: /],
    ['[1,2]', /^invalid_output: not an object/],
    ['{"payee":"openai-api","amount":"10","currency":"USD","purpose":"x"}', /^invalid_output: amount/],
    ['{"payee":"openai-api","amount":-5,"currency":"USD","purpose":"x"}', /^invalid_output: amount/],
    ['{"payee":"openai-api","amount":10.005,"currency":"USD","purpose":"x"}', /^invalid_output: amount has more than 2 decimals/],
    ['{"payee":"openai-api","amount":10,"currency":"EUR","purpose":"x"}', /^invalid_output: currency must be USD/],
    ['{"payee":"bad payee; drop","amount":10,"currency":"USD","purpose":"x"}', /^invalid_output: payee/],
    ['{"payee":"openai-api","amount":10,"currency":"USD"}', /^invalid_output: purpose/],
    ['', /^invalid_output: empty content/],
  ];
  for (const [content, reason] of cases) {
    const { fetch } = mockFetch(() => chatResponse(content));
    const quote = await new OpenRouterPlanner({ apiKey: FAKE_KEY, fetch }).plan('buy 1M tokens of GPT inference', CTX);
    assert.equal(quote.trace?.planner, 'rule-based', content);
    assert.match(quote.trace!.fallback!.reason, reason, content);
    assert.equal(quote.amount, 10);
  }
  const { fetch: notJsonBody } = mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
  const q = await new OpenRouterPlanner({ apiKey: FAKE_KEY, fetch: notJsonBody }).plan('buy 1M tokens of GPT inference', CTX);
  assert.equal(q.trace?.fallback?.reason, 'invalid_json: response body is not JSON');
});

test('redactOpenRouterSecrets removes the key, sk-or- keys and Bearer credentials', () => {
  const other = ['sk', 'or', 'v1', 'another0key0abc'].join('-');
  const out = redactOpenRouterSecrets(`a ${FAKE_KEY} b ${other} Authorization: Bearer xyz.abc "authorization":"q1"`, FAKE_KEY);
  assert.ok(!out.includes(FAKE_KEY) && !out.includes(other) && !out.includes('xyz.abc') && !out.includes('q1'));
});

/** Real API (mock rail) + agent with an LLM planner whose fetch is mocked: the policy still decides. */
async function runWithLlm(t: { after: (fn: () => Promise<void>) => void }, content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-llm-'));
  const ledgerPath = join(dir, 'ledger.json');
  const server: Server = createServer({ ledger: ledgerPath, adapter: createMockAdapter() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const { fetch } = mockFetch(() => chatResponse(content));
  const events: AgentEvent[] = [];
  const lines: string[] = [];
  const result = await runAgent(
    {
      apiUrl: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`,
      agentId: 'demo-agent',
      task: 'buy 1M tokens of GPT inference',
      pollMs: 20,
      timeoutMs: 200,
      planner: new OpenRouterPlanner({ apiKey: FAKE_KEY, fetch }),
    },
    { emit: (e) => events.push(e), writeLine: (l) => lines.push(l) },
  );
  return { result, events, lines, ledger: await readFile(ledgerPath, 'utf8') };
}

test('policy guard: an over-limit LLM proposal is rejected by the API, no payment', async (t) => {
  const { result, events, ledger } = await runWithLlm(t, '{"payee":"openai-api","amount":5000,"currency":"USD","purpose":"lots"}');
  assert.equal(result.status, 'rejected');
  assert.equal(result.exitCode, 2);
  assert.match(result.reason ?? '', /^per_tx_limit_exceeded/);
  const quoteStep = events.find((e) => e.type === 'step' && e.step === 'quote') as { planner?: string; plannerTrace?: unknown };
  assert.equal(quoteStep.planner, 'openrouter');
  assert.ok(!ledger.includes('"paymentStatus": "paid"'));
  assertNoKey(events);
  assert.ok(!ledger.includes(FAKE_KEY));
});

test('policy guard: an LLM proposal to a payee outside the allowlist is rejected', async (t) => {
  const { result } = await runWithLlm(t, '{"payee":"attacker@example.com","amount":1,"currency":"USD","purpose":"x"}');
  assert.equal(result.status, 'rejected');
  assert.match(result.reason ?? '', /^payee_not_allowed/);
});

test('policy guard: an LLM proposal above the approval threshold is held for a human', async (t) => {
  const { result } = await runWithLlm(t, '{"payee":"openai-api","amount":75,"currency":"USD","purpose":"7.5M tokens"}');
  assert.equal(result.status, 'approval_timeout');
  assert.equal(result.exitCode, 3);
  assert.equal((result.quote as Quote).trace?.planner, 'openrouter');
});

test('agent trace shows the fallback line when the LLM is unavailable', async (t) => {
  const { result, lines } = await runWithLlm(t, 'garbage');
  assert.equal(result.status, 'paid');
  assert.ok(lines.some((l) => /^\[quote\] rule-based quoted 10 USD to openai-api .*\[fallback from openrouter: invalid_json: /.test(l)), lines.join('\n'));
});

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('CLI --planner llm without OPENROUTER_API_KEY falls back to rules (no network); bad --planner exits 1', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-llm-cli-'));
  const server: Server = createServer({ ledger: join(dir, 'ledger.json'), adapter: createMockAdapter() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const api = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const env = { ...process.env, OPENROUTER_API_KEY: '' };
  const ok = await runCli(['--api', api, '--planner', 'llm', '--scenario', 'small', '--json'], env);
  assert.equal(ok.code, 0, ok.stderr);
  const quote = ok.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.step === 'quote')!;
  assert.equal(quote.planner, 'rule-based');
  assert.deepEqual((quote.plannerTrace as { fallback: unknown }).fallback, { from: 'openrouter', reason: 'missing_api_key: OPENROUTER_API_KEY is not set' });

  const bad = await runCli(['--api', api, '--planner', 'gpt', '--scenario', 'small'], env);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /invalid --planner/);
});
