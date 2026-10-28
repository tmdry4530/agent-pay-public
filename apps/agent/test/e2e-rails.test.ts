import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base58Encode } from '@agent-pay/adapters';
import { createAdapter, createServer, railSeed } from '@agent-pay/api';

const AGENT_DIR = join(import.meta.dirname, '..');
const FIXED_NOW = new Date('2026-10-28T12:00:00.000Z');

function nearTestKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string };
  if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') throw new Error('expected ed25519 jwk');
  const seed = new Uint8Array(Buffer.from(jwk.d, 'base64url'));
  const rawPub = new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  const material = new Uint8Array(seed.length + rawPub.length);
  material.set(seed, 0);
  material.set(rawPub, seed.length);
  return `ed25519:${base58Encode(material)}`;
}

function zeroBlockHash(): string {
  return base58Encode(new Uint8Array(32));
}

async function startPayPalMock(t: { after: (fn: () => Promise<void>) => void }) {
  let payoutsPosts = 0;
  let payoutGets = 0;
  const batchId = 'BATCH-E2E';
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'POST' && url.pathname === '/v1/oauth2/token') {
        send(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/payments/payouts') {
        payoutsPosts++;
        send(201, {
          batch_header: { payout_batch_id: batchId, batch_status: 'PENDING' },
          items: [{ transaction_status: 'PENDING' }],
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v1/payments/payouts/${batchId}`) {
        payoutGets++;
        send(200, {
          batch_header: { payout_batch_id: batchId, batch_status: 'SUCCESS' },
          items: [{ transaction_status: 'SUCCESS' }],
        });
        return;
      }
      send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get counts() {
      return { payoutsPosts, payoutGets };
    },
  };
}

async function startNearMock(t: { after: (fn: () => Promise<void>) => void }) {
  let sendTxCalls = 0;
  let txCalls = 0;
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: { method?: string } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        parsed = {};
      }
      const send = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (parsed.method === 'query') {
        send({ jsonrpc: '2.0', id: '1', result: { nonce: 1, block_hash: zeroBlockHash() } });
        return;
      }
      if (parsed.method === 'send_tx') {
        sendTxCalls++;
        send({
          jsonrpc: '2.0',
          id: '1',
          error: {
            code: -32000,
            message: 'timeout',
            data: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } },
          },
        });
        return;
      }
      if (parsed.method === 'tx') {
        txCalls++;
        send({ jsonrpc: '2.0', id: '1', result: { status: { SuccessValue: '' } } });
        return;
      }
      send({ jsonrpc: '2.0', id: '1', error: { code: -32601, message: 'method not found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
  return {
    rpcUrl: `http://127.0.0.1:${port}`,
    get counts() {
      return { sendTxCalls, txCalls };
    },
  };
}

async function startApiServer(
  t: { after: (fn: () => Promise<void>) => void },
  rail: 'paypal' | 'near',
  env: Record<string, string>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-e2e-'));
  const seed = railSeed(rail, env);
  const adapter = await createAdapter(rail, { env, now: () => FIXED_NOW });
  const server: Server = createServer({
    ledger: join(dir, 'ledger.json'),
    adapter,
    policy: seed.policy,
    demo: { currency: seed.currency, amountScale: seed.amountScale, payees: seed.payees },
    now: () => FIXED_NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, seed };
}

function runAgentCli(apiUrl: string): Promise<{ code: number | null; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npm',
      ['run', 'agent', '--silent', '--', '--scenario', 'small', '--api', apiUrl, '--json', '--poll-ms', '50', '--timeout-ms', '10000'],
      { cwd: AGENT_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, lines: stdout.split('\n').filter((l) => l.trim()) });
    });
  });
}

test('e2e RAIL=paypal: agent small scenario pays via pending payout refresh', { timeout: 30_000 }, async (t) => {
  const mock = await startPayPalMock(t);
  const env = {
    PAYPAL_CLIENT_ID: 'test-client',
    PAYPAL_CLIENT_SECRET: 'test-secret',
    PAYPAL_BASE_URL: mock.baseUrl,
  };
  const { base, seed } = await startApiServer(t, 'paypal', env);
  const { code, lines } = await runAgentCli(base);
  assert.equal(code, 0);
  const summary = JSON.parse(lines[lines.length - 1] ?? '{}') as { type: string; status: string };
  assert.equal(summary.type, 'summary');
  assert.equal(summary.status, 'paid');
  const steps = lines.map((l) => JSON.parse(l) as { type: string; step?: string });
  assert.ok(steps.some((s) => s.type === 'step' && s.step === 'refresh'));
  assert.ok(steps.some((s) => s.type === 'step' && s.step === 'rail'));

  const ledger = (await (await fetch(`${base}/ledger`)).json()) as {
    entries: Array<{ intent: { payee: string; amount: number; currency: string }; receipt?: { status: string } }>;
  };
  const entry = ledger.entries[0];
  assert.equal(entry?.receipt?.status, 'succeeded');
  assert.equal(entry?.intent.payee, seed.payees['openai-api']);
  assert.equal(entry?.intent.currency, 'USD');
  assert.equal(entry?.intent.amount, 10);
  assert.equal(mock.counts.payoutsPosts, 1);
  assert.ok(mock.counts.payoutGets >= 1);
});

test('e2e RAIL=near: agent small scenario pays 0.1 NEAR after refresh', { timeout: 30_000 }, async (t) => {
  const mock = await startNearMock(t);
  const env = {
    NEAR_ACCOUNT_ID: 'payer.testnet',
    NEAR_PRIVATE_KEY: nearTestKey(),
    NEAR_RPC_URL: mock.rpcUrl,
    NEAR_NETWORK: 'testnet',
  };
  const { base, seed } = await startApiServer(t, 'near', env);
  const { code, lines } = await runAgentCli(base);
  assert.equal(code, 0);
  const summary = JSON.parse(lines[lines.length - 1] ?? '{}') as { type: string; status: string };
  assert.equal(summary.type, 'summary');
  assert.equal(summary.status, 'paid');
  const steps = lines.map((l) => JSON.parse(l) as { type: string; step?: string });
  assert.ok(steps.some((s) => s.type === 'step' && s.step === 'refresh'));

  const ledger = (await (await fetch(`${base}/ledger`)).json()) as {
    entries: Array<{ intent: { payee: string; amount: number; currency: string }; receipt?: { status: string } }>;
  };
  const entry = ledger.entries[0];
  assert.equal(entry?.receipt?.status, 'succeeded');
  assert.equal(entry?.intent.payee, seed.payees['openai-api']);
  assert.equal(entry?.intent.currency, 'NEAR');
  assert.equal(entry?.intent.amount, 0.1);
  assert.equal(mock.counts.sendTxCalls, 1);
  assert.ok(mock.counts.txCalls >= 1);
});
