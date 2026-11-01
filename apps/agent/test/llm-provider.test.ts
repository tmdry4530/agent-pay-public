import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  NO_LLM_KEY_REASON,
  OPENAI_CHAT_URL,
  OPENROUTER_CHAT_URL,
  OpenAIPlanner,
  createPlanner,
  redactLlmSecrets,
} from '../src/index.ts';

// Fake keys are assembled at runtime so no key-shaped literal is committed (see scripts/secret-scan.sh).
const OPENAI_KEY = ['sk', 'proj', 'unit0test0only0' + 'A'.repeat(24)].join('-');
const OPENAI_LEGACY_KEY = ['sk', 'unit0test0legacy0' + 'B'.repeat(24)].join('-');
const OPENROUTER_KEY = ['sk', 'or', 'v1', 'unit0test0only0' + 'C'.repeat(24)].join('-');
const CTX = { agentId: 'demo-agent', currency: 'USD' };
const TASK = 'buy 1M tokens of GPT inference';
const GOOD = '{"payee":"openai-api","amount":10,"currency":"USD","purpose":"1M GPT tokens"}';

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(respond: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: typeof fetch = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fn, calls };
}

function chat(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });
}

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function bodyOf(call: Call): { model: string } {
  return JSON.parse(String(call.init.body)) as { model: string };
}

test('both keys set: OpenAI is used (one request to api.openai.com), trace records provider and model', async () => {
  const { fetch, calls } = mockFetch(() => chat(GOOD));
  const planner = createPlanner('llm', { env: { OPENAI_API_KEY: OPENAI_KEY, OPENROUTER_API_KEY: OPENROUTER_KEY }, fetch });
  const quote = await planner.plan(TASK, CTX);
  assert.equal(planner.name, 'openai');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, OPENAI_CHAT_URL);
  assert.equal(OPENAI_CHAT_URL, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headersOf(calls[0]!).Authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(headersOf(calls[0]!)['X-Title'], undefined, 'OpenRouter-only header not sent to OpenAI');
  assert.equal(bodyOf(calls[0]!).model, DEFAULT_OPENAI_MODEL);
  assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-4o-mini');
  assert.deepEqual(quote.trace, { planner: 'openai', provider: 'openai', model: 'gpt-4o-mini' });
  assert.equal(quote.purpose, '1M GPT tokens (openai gpt-4o-mini)');
  assert.ok(!JSON.stringify(quote).includes(OPENAI_KEY));
});

test('only OPENROUTER_API_KEY set (OPENAI_API_KEY blank): OpenRouter is used', async () => {
  const { fetch, calls } = mockFetch(() => chat(GOOD));
  const quote = await createPlanner('llm', { env: { OPENAI_API_KEY: '  ', OPENROUTER_API_KEY: OPENROUTER_KEY }, fetch }).plan(TASK, CTX);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, OPENROUTER_CHAT_URL);
  assert.equal(headersOf(calls[0]!).Authorization, `Bearer ${OPENROUTER_KEY}`);
  assert.equal(headersOf(calls[0]!)['X-Title'], 'agent-pay');
  assert.equal(bodyOf(calls[0]!).model, DEFAULT_OPENROUTER_MODEL);
  assert.deepEqual(quote.trace, { planner: 'openrouter', provider: 'openrouter', model: DEFAULT_OPENROUTER_MODEL });
});

test('neither key set: rule-based quote, no request, fallback reason names both env vars', async () => {
  const { fetch, calls } = mockFetch(() => {
    throw new Error('must not be called');
  });
  for (const env of [{}, { OPENAI_API_KEY: '', OPENROUTER_API_KEY: ' ' }]) {
    const quote = await createPlanner('llm', { env, fetch }).plan(TASK, CTX);
    assert.equal(quote.amount, 10);
    assert.deepEqual(quote.trace, { planner: 'rule-based', fallback: { from: 'llm', reason: NO_LLM_KEY_REASON } });
  }
  assert.equal(NO_LLM_KEY_REASON, 'missing_api_key: neither OPENAI_API_KEY nor OPENROUTER_API_KEY is set');
  assert.equal(calls.length, 0);
});

test('OpenAI HTTP error falls back to rule-based, without retrying on OpenRouter; key redacted', async () => {
  const { fetch, calls } = mockFetch(
    () =>
      new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}`, type: 'invalid_request_error' } }), {
        status: 401,
      }),
  );
  const quote = await createPlanner('llm', { env: { OPENAI_API_KEY: OPENAI_KEY, OPENROUTER_API_KEY: OPENROUTER_KEY }, fetch }).plan(TASK, CTX);
  assert.equal(calls.length, 1, 'exactly one request, to OpenAI');
  assert.equal(calls[0]!.url, OPENAI_CHAT_URL);
  assert.equal(quote.trace?.planner, 'rule-based');
  assert.equal(quote.trace?.provider, 'openai');
  assert.equal(quote.trace?.fallback?.from, 'openai');
  assert.equal(quote.trace?.fallback?.reason, 'http_401: Incorrect API key provided: [redacted]');
  assert.equal(quote.amount, 10);
  assert.ok(!JSON.stringify(quote).includes(OPENAI_KEY));
});

test('OpenAI malformed output and network error fall back the same way', async () => {
  const { fetch: bad } = mockFetch(() => chat('sure! here is your payment'));
  const q1 = await new OpenAIPlanner({ apiKey: OPENAI_KEY, fetch: bad }).plan(TASK, CTX);
  assert.match(q1.trace?.fallback?.reason ?? '', /^invalid_json: /);
  const { fetch: down } = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  const q2 = await new OpenAIPlanner({ apiKey: OPENAI_KEY, fetch: down }).plan(TASK, CTX);
  assert.equal(q2.trace?.fallback?.reason, 'network_error: TypeError');
  const q3 = await new OpenAIPlanner({ fetch: down }).plan(TASK, CTX);
  assert.equal(q3.trace?.fallback?.reason, 'missing_api_key: OPENAI_API_KEY is not set');
});

test('OPENAI_MODEL overrides the OpenAI model', async () => {
  const { fetch, calls } = mockFetch(() => chat(GOOD));
  const quote = await createPlanner('llm', { env: { OPENAI_API_KEY: OPENAI_KEY, OPENAI_MODEL: ' gpt-4.1-mini ', OPENROUTER_MODEL: 'ignored/model' }, fetch }).plan(TASK, CTX);
  assert.equal(bodyOf(calls[0]!).model, 'gpt-4.1-mini');
  assert.equal(quote.trace?.model, 'gpt-4.1-mini');
});

test('redactLlmSecrets removes sk-proj-, legacy sk- and sk-or- keys and Bearer values, leaves ordinary words', () => {
  const text = `proj ${OPENAI_KEY} legacy ${OPENAI_LEGACY_KEY} or ${OPENROUTER_KEY} Authorization: Bearer abc.def "authorization":"zzz" task-risk-desk-flow`;
  const out = redactLlmSecrets(text);
  for (const secret of [OPENAI_KEY, OPENAI_LEGACY_KEY, OPENROUTER_KEY, 'abc.def', 'zzz']) assert.ok(!out.includes(secret), secret);
  assert.ok(!out.includes('unit0test0'));
  assert.ok(out.includes('task-risk-desk-flow'), 'words that merely contain "sk-" are kept');
  // the configured key is removed even if it does not look like sk-…
  assert.equal(redactLlmSecrets('x custom-key-123 y', 'custom-key-123'), 'x [redacted] y');
});
