import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createMockAdapter, createServer, loadConfig } from '@agent-pay/api';
import { runAgent, type AgentEvent, type RunAgentOptions } from '../src/index.ts';

type Mode = 'drop' | 'slow' | '503' | 'pass';

/** Real apps/api (mock rail) behind a proxy that misbehaves on POST /intents per `modes` (one per attempt). */
async function startFlakyApi(t: { after: (fn: () => Promise<void>) => void }, modes: Mode[]) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-f14-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0', RAIL: 'mock' });
  const api: Server = createServer({ ledger: config.ledgerPath, adapter: createMockAdapter() });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()));
  const apiAddr = api.address();
  const apiBase = `http://127.0.0.1:${typeof apiAddr === 'object' && apiAddr ? apiAddr.port : 0}`;
  const bodies: Record<string, unknown>[] = [];
  const readBody = async (req: IncomingMessage) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw;
  };
  const proxy = createHttpServer(async (req, res) => {
    const raw = await readBody(req);
    const forward = () =>
      fetch(`${apiBase}${req.url}`, { method: req.method, headers: { 'Content-Type': 'application/json' }, body: req.method === 'GET' ? undefined : raw });
    if (req.method === 'POST' && req.url === '/intents') {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      const mode = modes[bodies.length - 1] ?? 'pass';
      if (mode === '503') {
        res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'lock_timeout: busy' }));
        return;
      }
      const upstream = await forward(); // the server really processes (and pays) the intent
      const text = await upstream.text();
      if (mode === 'drop') {
        req.socket.destroy(); // response lost on the way back
        return;
      }
      if (mode === 'slow') await new Promise((r) => setTimeout(r, 300)); // longer than submitTimeoutMs
      if (res.destroyed) return;
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(text);
      return;
    }
    const upstream = await forward();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(await upstream.text());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
  const addr = proxy.address();
  t.after(async () => {
    proxy.closeAllConnections();
    api.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, apiBase, bodies };
}

async function run(opts: Partial<RunAgentOptions> & { apiUrl: string }) {
  const events: AgentEvent[] = [];
  const result = await runAgent(
    { agentId: 'demo-agent', pollMs: 20, submitRetryDelayMs: 10, ...opts },
    { emit: (e) => events.push(e), writeLine: () => {} },
  );
  return { result, steps: events.flatMap((e) => (e.type === 'step' ? [e.step] : [])) };
}

async function entries(apiBase: string) {
  return ((await (await fetch(`${apiBase}/ledger`)).json()) as { entries: { intent: { id: string }; paymentStatus?: string }[] }).entries;
}

for (const mode of ['drop', 'slow'] as const) {
  test(`F14: response lost (${mode}) → the retry resends the same intent id; paid once`, async (t) => {
    const { base, apiBase, bodies } = await startFlakyApi(t, [mode, 'pass']);
    const { result, steps } = await run({ apiUrl: base, scenario: 'small', submitTimeoutMs: 100 });
    assert.equal(result.status, 'paid');
    assert.equal(bodies.length, 2);
    assert.equal(typeof bodies[0]?.id, 'string');
    assert.equal(bodies[1]?.id, bodies[0]?.id, 'same intent id on retry');
    assert.deepEqual(bodies[1], bodies[0], 'identical body on retry');
    assert.equal(result.intentId, bodies[0]?.id);
    assert.ok(steps.includes('submit_retry'));
    const ledger = await entries(apiBase);
    assert.equal(ledger.length, 1, 'one intent, paid once');
    assert.equal(ledger[0]?.paymentStatus, 'paid');
  });
}

test('F14: 5xx is retried with the same body; a fresh run gets a new id', async (t) => {
  const { base, apiBase, bodies } = await startFlakyApi(t, ['503', 'pass', 'pass']);
  const first = await run({ apiUrl: base, scenario: 'small' });
  assert.equal(first.result.status, 'paid');
  assert.deepEqual(bodies[1], bodies[0]);
  const second = await run({ apiUrl: base, scenario: 'small' });
  assert.equal(second.result.status, 'paid');
  assert.notEqual(bodies[2]?.id, bodies[0]?.id, 'id is per run');
  assert.equal((await entries(apiBase)).length, 2);
});

test('F14: retries are bounded by submitAttempts', async (t) => {
  const { base, apiBase, bodies } = await startFlakyApi(t, ['503', '503', '503', 'pass']);
  const { result } = await run({ apiUrl: base, scenario: 'small', submitAttempts: 2 });
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /lock_timeout/);
  assert.equal(bodies.length, 2);
  assert.equal((await entries(apiBase)).length, 0);
});
