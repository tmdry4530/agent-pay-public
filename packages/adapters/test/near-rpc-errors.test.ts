import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import type { PaymentIntent } from '../src/index.ts';
import { createNearAdapter } from '../src/near.ts';
import { receiptMeta } from '../src/adapter-types.ts';
import {
  base58Encode,
  createNearRpcClient,
  type NearClient,
} from '../src/near-rpc.ts';
import {
  HANDLER_DOES_NOT_TRACK_SHARD,
  HANDLER_INTERNAL_ERROR,
  HANDLER_INVALID_TRANSACTION,
  HANDLER_REQUEST_ROUTED,
  HANDLER_TIMEOUT_DOES_NOT_TRACK_SHARD,
  HANDLER_TIMEOUT_ERROR_CAUSE,
  HANDLER_TIMEOUT_NO_INFO,
  HANDLER_TIMEOUT_NOT_OBSERVED,
  HANDLER_TIMEOUT_PENDING,
  HANDLER_UNKNOWN_TRANSACTION,
  PLACEHOLDER_HASH,
  REQUEST_VALIDATION_METHOD_NOT_FOUND,
  REQUEST_VALIDATION_PARSE_ERROR,
  TOP_INTERNAL_ERROR,
  resultWithStatus,
} from './fixtures/near-rpc-errors.ts';

const AT = new Date('2026-04-01T00:00:00.000Z');
const accountId = 'alice.testnet';
const receiverId = 'bob.testnet';
const amountYocto = '1000000000000000000000000';
const accessNonce = 15;
const blockHash = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

interface RpcRequest {
  jsonrpc: string;
  id: unknown;
  method: string;
  params: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcResult(result: unknown): unknown {
  return { jsonrpc: '2.0', id: 'dontcare', result };
}

function accessKeyBody(): unknown {
  return rpcResult({
    nonce: accessNonce,
    permission: 'FullAccess',
    block_hash: base58Encode(blockHash),
  });
}

function createRpcFetch(handler: (req: RpcRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RpcRequest[];
} {
  const calls: RpcRequest[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const req = JSON.parse(String(init?.body)) as RpcRequest;
    calls.push(req);
    return handler(req);
  };
  return { fetchImpl, calls };
}

function throwawayKey(): { nearKey: string; rawPub: Uint8Array } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
    throw new Error('expected ed25519 jwk material');
  }
  const seed = new Uint8Array(Buffer.from(jwk.d, 'base64url'));
  const rawPub = new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  assert.equal(seed.length, 32);
  assert.equal(rawPub.length, 32);
  const material = concatBytes(seed, rawPub);
  return { nearKey: `ed25519:${base58Encode(material)}`, rawPub };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function decodeSignedTx(signedTxBase64: string): Uint8Array {
  const signed = new Uint8Array(Buffer.from(signedTxBase64, 'base64'));
  assert.ok(signed.length > 65);
  const txLength = signed.length - 65;
  assert.equal(signed[txLength], 0);
  return signed.subarray(0, txLength);
}

function txHashFromSignedTxBase64(signedTxBase64: string): string {
  const txBytes = decodeSignedTx(signedTxBase64);
  const hash = createHash('sha256').update(txBytes).digest();
  return base58Encode(new Uint8Array(hash));
}

function baseIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'intent-near-err-1',
    agentId: 'agent-1',
    payee: receiverId,
    amount: 1,
    currency: 'NEAR',
    purpose: 'demo',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildAdapter(
  onSendTx: (req: RpcRequest) => Response | Promise<Response>,
  onError?: (error: unknown) => void,
): { adapter: ReturnType<typeof createNearAdapter>; calls: RpcRequest[]; client: NearClient } {
  const key = throwawayKey();
  const { fetchImpl, calls } = createRpcFetch((req) => {
    if (req.method === 'query') {
      return jsonResponse(accessKeyBody());
    }
    if (req.method === 'send_tx') {
      return onSendTx(req);
    }
    if (req.method === 'tx') {
      return jsonResponse({ jsonrpc: '2.0', id: 'dontcare', error: { message: 'unexpected tx in pay setup' } }, 500);
    }
    return jsonResponse({ error: 'unexpected method' }, 500);
  });
  const client = createNearRpcClient({
    rpcUrl: 'https://rpc.invalid',
    accountId,
    privateKey: key.nearKey,
    fetch: fetchImpl,
  });
  const adapter = createNearAdapter({
    client,
    networkId: 'testnet',
    now: () => AT,
    onError: onError
      ? (error, _ctx) => {
          onError(error);
        }
      : undefined,
  });
  return { adapter, calls, client };
}

function assertSendTxParams(calls: RpcRequest[]): string {
  const send = calls[1];
  assert.ok(send);
  assert.equal(send.method, 'send_tx');
  assert.equal(send.params.wait_until, 'EXECUTED_OPTIMISTIC');
  const signedTxBase64 = send.params.signed_tx_base64;
  assert.equal(typeof signedTxBase64, 'string');
  if (typeof signedTxBase64 !== 'string') {
    throw new Error('signed_tx_base64 missing');
  }
  return signedTxBase64;
}

const TIMEOUT_FIXTURES: ReadonlyArray<{ name: string; body: unknown }> = [
  { name: 'HANDLER_TIMEOUT_NO_INFO', body: HANDLER_TIMEOUT_NO_INFO },
  { name: 'HANDLER_TIMEOUT_NOT_OBSERVED', body: HANDLER_TIMEOUT_NOT_OBSERVED },
  { name: 'HANDLER_TIMEOUT_PENDING', body: HANDLER_TIMEOUT_PENDING },
  { name: 'HANDLER_TIMEOUT_DOES_NOT_TRACK_SHARD', body: HANDLER_TIMEOUT_DOES_NOT_TRACK_SHARD },
  { name: 'HANDLER_TIMEOUT_ERROR_CAUSE', body: HANDLER_TIMEOUT_ERROR_CAUSE },
];

describe('near RPC error fixtures — pay()', () => {
  for (const { name, body } of TIMEOUT_FIXTURES) {
    it(`${name} -> pending with tx hash and unknownOutcome`, async () => {
      const errors: unknown[] = [];
      const { adapter, calls } = buildAdapter(() => jsonResponse(body), (e) => errors.push(e));
      const receipt = await adapter.pay(baseIntent());
      assert.equal(receipt.status, 'pending');
      const signed = assertSendTxParams(calls);
      assert.equal(receipt.externalId, txHashFromSignedTxBase64(signed));
      assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
      assert.equal(errors.length, 1);
    });
  }

  it('HANDLER_INVALID_TRANSACTION -> failed with tx hash, no unknownOutcome', async () => {
    const errors: unknown[] = [];
    const { adapter, calls } = buildAdapter(
      () => jsonResponse(HANDLER_INVALID_TRANSACTION),
      (e) => errors.push(e),
    );
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'failed');
    const signed = assertSendTxParams(calls);
    assert.equal(receipt.externalId, txHashFromSignedTxBase64(signed));
    assert.equal(receiptMeta(receipt)?.unknownOutcome, undefined);
    assert.equal(errors.length, 1);
  });

  for (const { name, body } of [
    { name: 'REQUEST_VALIDATION_METHOD_NOT_FOUND', body: REQUEST_VALIDATION_METHOD_NOT_FOUND },
    { name: 'REQUEST_VALIDATION_PARSE_ERROR', body: REQUEST_VALIDATION_PARSE_ERROR },
  ]) {
    it(`${name} -> failed`, async () => {
      const errors: unknown[] = [];
      const { adapter, calls } = buildAdapter(() => jsonResponse(body), (e) => errors.push(e));
      const receipt = await adapter.pay(baseIntent());
      assert.equal(receipt.status, 'failed');
      assertSendTxParams(calls);
      assert.ok(receipt.externalId.length > 0);
      assert.equal(errors.length, 1);
    });
  }

  for (const { name, body } of [
    { name: 'HANDLER_DOES_NOT_TRACK_SHARD', body: HANDLER_DOES_NOT_TRACK_SHARD },
    { name: 'HANDLER_REQUEST_ROUTED', body: HANDLER_REQUEST_ROUTED },
    { name: 'HANDLER_UNKNOWN_TRANSACTION', body: HANDLER_UNKNOWN_TRANSACTION },
    { name: 'HANDLER_INTERNAL_ERROR', body: HANDLER_INTERNAL_ERROR },
    { name: 'TOP_INTERNAL_ERROR', body: TOP_INTERNAL_ERROR },
  ]) {
    it(`${name} -> pending with tx hash and unknownOutcome`, async () => {
      const errors: unknown[] = [];
      const { adapter, calls } = buildAdapter(() => jsonResponse(body), (e) => errors.push(e));
      const receipt = await adapter.pay(baseIntent());
      assert.equal(receipt.status, 'pending');
      const signed = assertSendTxParams(calls);
      assert.equal(receipt.externalId, txHashFromSignedTxBase64(signed));
      assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
      assert.equal(errors.length, 1);
    });
  }

  it('resultWithStatus SuccessValue at EXECUTED_OPTIMISTIC -> succeeded', async () => {
    const errors: unknown[] = [];
    const { adapter, calls } = buildAdapter(
      () => jsonResponse(resultWithStatus({ SuccessValue: '' }, 'EXECUTED_OPTIMISTIC')),
      (e) => errors.push(e),
    );
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'succeeded');
    const signed = assertSendTxParams(calls);
    assert.equal(receipt.externalId, txHashFromSignedTxBase64(signed));
    assert.equal(receiptMeta(receipt)?.unknownOutcome, undefined);
    assert.equal(errors.length, 0);
  });

  it('resultWithStatus Failure at EXECUTED_OPTIMISTIC -> failed', async () => {
    const errors: unknown[] = [];
    const { adapter, calls } = buildAdapter(
      () => jsonResponse(resultWithStatus({ Failure: {} }, 'EXECUTED_OPTIMISTIC')),
      (e) => errors.push(e),
    );
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'failed');
    assertSendTxParams(calls);
    assert.equal(errors.length, 1);
  });

  for (const { label, status, finality } of [
    { label: 'NotStarted at NONE', status: 'NotStarted', finality: 'NONE' },
    { label: 'Started at INCLUDED', status: 'Started', finality: 'INCLUDED' },
  ]) {
    it(`resultWithStatus ${label} -> pending with unknownOutcome`, async () => {
      const errors: unknown[] = [];
      const { adapter, calls } = buildAdapter(
        () => jsonResponse(resultWithStatus(status, finality)),
        (e) => errors.push(e),
      );
      const receipt = await adapter.pay(baseIntent());
      assert.equal(receipt.status, 'pending');
      assertSendTxParams(calls);
      assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
      assert.equal(errors.length, 1);
    });
  }

  it('HTTP 500 with TOP_INTERNAL_ERROR -> pending with unknownOutcome', async () => {
    const errors: unknown[] = [];
    const { adapter, calls } = buildAdapter(
      () => jsonResponse(TOP_INTERNAL_ERROR, 500),
      (e) => errors.push(e),
    );
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'pending');
    assertSendTxParams(calls);
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(errors.length, 1);
  });

  it('HTTP 400 with REQUEST_VALIDATION_PARSE_ERROR -> failed', async () => {
    const errors: unknown[] = [];
    const { adapter, calls } = buildAdapter(
      () => jsonResponse(REQUEST_VALIDATION_PARSE_ERROR, 400),
      (e) => errors.push(e),
    );
    const receipt = await adapter.pay(baseIntent());
    assert.equal(receipt.status, 'failed');
    assertSendTxParams(calls);
    assert.equal(errors.length, 1);
  });

  it.todo(
    'send_tx SuccessValue at EXECUTED_OPTIMISTIC is mapped to succeeded; docs recommend final_execution_status FINAL before settlement',
  );
});

describe('near RPC error fixtures — status()', () => {
  const pendingReceipt = {
    intentId: 'i-1',
    rail: 'near' as const,
    externalId: PLACEHOLDER_HASH,
    status: 'pending' as const,
    at: AT.toISOString(),
    meta: {
      amountYocto: '1',
      receiverId: 'bob.testnet',
      network: 'testnet',
    },
  };

  function buildStatusAdapter(
    onTx: (req: RpcRequest) => Response | Promise<Response>,
    onError?: (error: unknown) => void,
  ): { adapter: ReturnType<typeof createNearAdapter>; calls: RpcRequest[] } {
    const key = throwawayKey();
    const { fetchImpl, calls } = createRpcFetch((req) => {
      if (req.method === 'tx') {
        return onTx(req);
      }
      return jsonResponse({ error: 'unexpected method' }, 500);
    });
    const client = createNearRpcClient({
      rpcUrl: 'https://rpc.invalid',
      accountId,
      privateKey: key.nearKey,
      fetch: fetchImpl,
    });
    const adapter = createNearAdapter({
      client,
      networkId: 'testnet',
      now: () => AT,
      onError: onError
        ? (error, _ctx) => {
            onError(error);
          }
        : undefined,
    });
    return { adapter, calls };
  }

  function assertTxParams(calls: RpcRequest[]): void {
    const tx = calls[0];
    assert.ok(tx);
    assert.equal(tx.method, 'tx');
    assert.equal(tx.params.tx_hash, PLACEHOLDER_HASH);
    assert.equal(tx.params.sender_account_id, accountId);
  }

  it('HANDLER_UNKNOWN_TRANSACTION -> unchanged receipt, onError not called', async () => {
    const errors: unknown[] = [];
    const { adapter, calls } = buildStatusAdapter(
      () => jsonResponse(HANDLER_UNKNOWN_TRANSACTION),
      (e) => errors.push(e),
    );
    const out = await adapter.status(pendingReceipt);
    assert.deepEqual(out, pendingReceipt);
    assertTxParams(calls);
    assert.equal(errors.length, 0);
  });

  const STATUS_ERROR_FIXTURES: ReadonlyArray<{ name: string; body: unknown }> = [
    { name: 'HANDLER_TIMEOUT_NO_INFO', body: HANDLER_TIMEOUT_NO_INFO },
    { name: 'HANDLER_TIMEOUT_NOT_OBSERVED', body: HANDLER_TIMEOUT_NOT_OBSERVED },
    { name: 'HANDLER_TIMEOUT_PENDING', body: HANDLER_TIMEOUT_PENDING },
    { name: 'HANDLER_TIMEOUT_DOES_NOT_TRACK_SHARD', body: HANDLER_TIMEOUT_DOES_NOT_TRACK_SHARD },
    { name: 'HANDLER_TIMEOUT_ERROR_CAUSE', body: HANDLER_TIMEOUT_ERROR_CAUSE },
    { name: 'HANDLER_INVALID_TRANSACTION', body: HANDLER_INVALID_TRANSACTION },
    { name: 'REQUEST_VALIDATION_METHOD_NOT_FOUND', body: REQUEST_VALIDATION_METHOD_NOT_FOUND },
    { name: 'REQUEST_VALIDATION_PARSE_ERROR', body: REQUEST_VALIDATION_PARSE_ERROR },
    { name: 'HANDLER_DOES_NOT_TRACK_SHARD', body: HANDLER_DOES_NOT_TRACK_SHARD },
    { name: 'HANDLER_REQUEST_ROUTED', body: HANDLER_REQUEST_ROUTED },
    { name: 'HANDLER_INTERNAL_ERROR', body: HANDLER_INTERNAL_ERROR },
    { name: 'TOP_INTERNAL_ERROR', body: TOP_INTERNAL_ERROR },
  ];

  for (const { name, body } of STATUS_ERROR_FIXTURES) {
    it(`status tx ${name} -> unchanged, onError once`, async () => {
      const errors: unknown[] = [];
      const { adapter, calls } = buildStatusAdapter(() => jsonResponse(body), (e) => errors.push(e));
      const out = await adapter.status(pendingReceipt);
      assert.deepEqual(out, pendingReceipt);
      assertTxParams(calls);
      assert.equal(errors.length, 1);
    });
  }

  it('resultWithStatus SuccessValue at FINAL -> succeeded, meta preserved', async () => {
    const errors: unknown[] = [];
    const { adapter, calls } = buildStatusAdapter(
      () => jsonResponse(resultWithStatus({ SuccessValue: '' }, 'FINAL')),
      (e) => errors.push(e),
    );
    const out = await adapter.status(pendingReceipt);
    assert.equal(out.status, 'succeeded');
    assert.equal(out.externalId, PLACEHOLDER_HASH);
    assert.equal(out.intentId, pendingReceipt.intentId);
    assert.deepEqual(receiptMeta(out), pendingReceipt.meta);
    assertTxParams(calls);
    assert.equal(errors.length, 0);
  });

  it('resultWithStatus Failure at FINAL -> failed, meta preserved', async () => {
    const errors: unknown[] = [];
    const { adapter, calls } = buildStatusAdapter(
      () => jsonResponse(resultWithStatus({ Failure: {} }, 'FINAL')),
      (e) => errors.push(e),
    );
    const out = await adapter.status(pendingReceipt);
    assert.equal(out.status, 'failed');
    assert.equal(out.externalId, PLACEHOLDER_HASH);
    assert.deepEqual(receiptMeta(out), pendingReceipt.meta);
    assertTxParams(calls);
    assert.equal(errors.length, 0);
  });

  for (const { label, status, finality } of [
    { label: 'NotStarted at NONE', status: 'NotStarted', finality: 'NONE' },
    { label: 'Started at INCLUDED', status: 'Started', finality: 'INCLUDED' },
  ]) {
    it(`resultWithStatus ${label} -> unchanged`, async () => {
      const errors: unknown[] = [];
      const { adapter, calls } = buildStatusAdapter(
        () => jsonResponse(resultWithStatus(status, finality)),
        (e) => errors.push(e),
      );
      const out = await adapter.status(pendingReceipt);
      assert.deepEqual(out, pendingReceipt);
      assertTxParams(calls);
      assert.equal(errors.length, 1);
    });
  }

  it('HTTP 500 TOP_INTERNAL_ERROR -> unchanged, onError once', async () => {
    const errors: unknown[] = [];
    const { adapter, calls } = buildStatusAdapter(
      () => jsonResponse(TOP_INTERNAL_ERROR, 500),
      (e) => errors.push(e),
    );
    const out = await adapter.status(pendingReceipt);
    assert.deepEqual(out, pendingReceipt);
    assertTxParams(calls);
    assert.equal(errors.length, 1);
  });
});
