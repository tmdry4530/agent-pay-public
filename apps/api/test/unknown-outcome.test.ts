import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base58Encode, receiptMeta, type Receipt } from '@agent-pay/adapters';
import { createAdapter, createServer, railSeed } from '../src/index.ts';

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

async function startPayPalMock(
  t: { after: (fn: () => Promise<void>) => void },
  handlers: {
    payoutsPost?: (body: unknown) => { status: number; json: unknown };
    payoutGet?: (batchId: string) => { status: number; json: unknown };
  },
) {
  let payoutsPosts = 0;
  let payoutGets = 0;
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const send = (status: number, json: unknown) => {
        const text = JSON.stringify(json);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      };
      if (req.method === 'POST' && url.pathname === '/v1/oauth2/token') {
        send(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/payments/payouts') {
        payoutsPosts++;
        const out = handlers.payoutsPost?.(body) ?? { status: 201, json: {} };
        send(out.status, out.json);
        return;
      }
      const getMatch = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && getMatch) {
        payoutGets++;
        const batchId = decodeURIComponent(getMatch[1] ?? '');
        const out = handlers.payoutGet?.(batchId) ?? { status: 404, json: { name: 'NOT_FOUND' } };
        send(out.status, out.json);
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
  return { baseUrl: `http://127.0.0.1:${port}`, get counts() { return { payoutsPosts, payoutGets }; } };
}

async function startNearMock(
  t: { after: (fn: () => Promise<void>) => void },
  handlers: {
    sendTx?: () => unknown;
    txStatus?: (params: { tx_hash: string; sender_account_id: string }) => unknown;
  },
) {
  let sendTxCalls = 0;
  let txCalls = 0;
  let lastTxSender: string | undefined;
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: { method?: string; params?: Record<string, unknown> } = {};
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
        send({
          jsonrpc: '2.0',
          id: '1',
          result: { nonce: 1, block_hash: zeroBlockHash() },
        });
        return;
      }
      if (parsed.method === 'send_tx') {
        sendTxCalls++;
        send(handlers.sendTx?.() ?? { jsonrpc: '2.0', id: '1', result: { final_execution_status: 'FINAL', status: { SuccessValue: '' } } });
        return;
      }
      if (parsed.method === 'tx') {
        txCalls++;
        const params = parsed.params ?? {};
        lastTxSender = typeof params.sender_account_id === 'string' ? params.sender_account_id : undefined;
        const txHash = typeof params.tx_hash === 'string' ? params.tx_hash : '';
        send(
          handlers.txStatus?.({ tx_hash: txHash, sender_account_id: lastTxSender ?? '' }) ?? {
            jsonrpc: '2.0',
            id: '1',
            result: { final_execution_status: 'FINAL', status: { SuccessValue: '' } },
          },
        );
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
      return { sendTxCalls, txCalls, lastTxSender };
    },
  };
}

async function startApi(
  t: { after: (fn: () => Promise<void>) => void },
  rail: 'paypal' | 'near',
  env: Record<string, string>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-unknown-'));
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
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });
  return { base, seed };
}

const paypalIntent = (seed: ReturnType<typeof railSeed>) => ({
  id: 'pi_unknown_paypal',
  agentId: 'demo-agent',
  payee: seed.payees['openai-api']!,
  amount: 10,
  currency: 'USD',
  purpose: 'test',
  createdAt: FIXED_NOW.toISOString(),
});

const nearIntent = (seed: ReturnType<typeof railSeed>) => ({
  id: 'pi_unknown_near',
  agentId: 'demo-agent',
  payee: seed.payees['openai-api']!,
  amount: 0.1,
  currency: 'NEAR',
  purpose: 'test',
  createdAt: FIXED_NOW.toISOString(),
});

test('PayPal: payouts 500 → pending unknownOutcome, replay, refresh unchanged', async (t) => {
  const mock = await startPayPalMock(t, {
    payoutsPost: () => ({ status: 500, json: { name: 'INTERNAL' } }),
  });
  const env = {
    PAYPAL_CLIENT_ID: 'test-client',
    PAYPAL_CLIENT_SECRET: 'test-secret',
    PAYPAL_BASE_URL: mock.baseUrl,
  };
  const { base, seed } = await startApi(t, 'paypal', env);
  const body = paypalIntent(seed);

  const first = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(first.status, 201);
  const r1 = (await first.json()) as { status: string; receipt: { status: string; externalId: string } };
  assert.equal(r1.status, 'paid');
  assert.equal(r1.receipt.status, 'pending');
  assert.equal(r1.receipt.externalId, '');
  assert.equal(receiptMeta(r1.receipt as Receipt)?.unknownOutcome, 'true');

  const second = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(second.status, 200);
  const r2 = (await second.json()) as { replayed?: boolean; receipt: { status: string; externalId: string } };
  assert.equal(r2.replayed, true);
  assert.equal(r2.receipt.status, 'pending');
  assert.equal(mock.counts.payoutsPosts, 1);

  const refresh = await fetch(`${base}/intents/${body.id}/refresh`, { method: 'POST' });
  assert.equal(refresh.status, 200);
  const r3 = (await refresh.json()) as { changed: boolean; receipt: { status: string } };
  assert.equal(r3.changed, false);
  assert.equal(r3.receipt.status, 'pending');
  assert.equal(mock.counts.payoutsPosts, 1);
  assert.equal(mock.counts.payoutGets, 0);
});

test('PayPal: pending batch → replay → refresh succeeds', async (t) => {
  const batchId = 'BATCH-PEND-1';
  const mock = await startPayPalMock(t, {
    payoutsPost: () => ({
      status: 201,
      json: {
        batch_header: { payout_batch_id: batchId, batch_status: 'PENDING' },
        items: [{ transaction_status: 'PENDING' }],
      },
    }),
    payoutGet: () => ({
      status: 200,
      json: {
        batch_header: { payout_batch_id: batchId, batch_status: 'SUCCESS' },
        items: [{ transaction_status: 'SUCCESS' }],
      },
    }),
  });
  const env = {
    PAYPAL_CLIENT_ID: 'test-client',
    PAYPAL_CLIENT_SECRET: 'test-secret',
    PAYPAL_BASE_URL: mock.baseUrl,
  };
  const { base, seed } = await startApi(t, 'paypal', env);
  const body = { ...paypalIntent(seed), id: 'pi_paypal_refresh' };

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(mock.counts.payoutsPosts, 1);

  const refresh = await fetch(`${base}/intents/${body.id}/refresh`, { method: 'POST' });
  const refreshed = (await refresh.json()) as { changed: boolean; receipt: { status: string; externalId: string } };
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.receipt.status, 'succeeded');
  assert.equal(refreshed.receipt.externalId, batchId);
  assert.equal(mock.counts.payoutGets, 1);
  assert.equal(mock.counts.payoutsPosts, 1);
});

test('NEAR: send_tx timeout → replay → refresh succeeded', async (t) => {
  const nearKey = nearTestKey();
  const accountId = 'payer.testnet';
  const mock = await startNearMock(t, {
    sendTx: () => ({
      jsonrpc: '2.0',
      id: '1',
      error: {
        code: -32000,
        message: 'timeout',
        data: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } },
      },
    }),
    txStatus: () => ({
      jsonrpc: '2.0',
      id: '1',
      result: { final_execution_status: 'FINAL', status: { SuccessValue: '' } },
    }),
  });
  const env = {
    NEAR_ACCOUNT_ID: accountId,
    NEAR_PRIVATE_KEY: nearKey,
    NEAR_RPC_URL: mock.rpcUrl,
    NEAR_NETWORK: 'testnet',
  };
  const { base, seed } = await startApi(t, 'near', env);
  const body = nearIntent(seed);

  const first = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const r1 = (await first.json()) as { status: string; receipt: { status: string; externalId: string } };
  assert.equal(r1.status, 'paid');
  assert.equal(r1.receipt.status, 'pending');
  assert.ok(r1.receipt.externalId.length > 0);

  await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(mock.counts.sendTxCalls, 1);

  const refresh = await fetch(`${base}/intents/${body.id}/refresh`, { method: 'POST' });
  const r3 = (await refresh.json()) as { changed: boolean; receipt: { status: string } };
  assert.equal(r3.changed, true);
  assert.equal(r3.receipt.status, 'succeeded');
  assert.equal(mock.counts.sendTxCalls, 1);
  assert.ok(mock.counts.txCalls >= 1);
  assert.equal(mock.counts.lastTxSender, accountId);
});
