import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { describe, it } from 'node:test';
import { nearConfigFromEnv } from '../src/index.ts';
import {
  base58Decode,
  base58Encode,
  createNearRpcClient,
  serializeTransferTransaction,
  type NearSendResult,
  type NearStatusResult,
} from '../src/near-rpc.ts';

const PUBKEY_B58 = 'Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC';
const BLOCK_B58 = '244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM';
const SERIALIZED_TX =
  '09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef6010000000301000000000000000000000000000000';

const blockHash = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const accountId = 'alice.testnet';
const receiverId = 'bob.testnet';
const amountYocto = '1000000000000000000000000';
const accessNonce = 15;

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

function rpcError(causeName: string, message = 'Server error'): unknown {
  return {
    jsonrpc: '2.0',
    id: 'dontcare',
    error: {
      code: -32000,
      message,
      data: {
        name: 'HANDLER_ERROR',
        cause: { name: causeName },
      },
    },
  };
}

function accessKeyBody(): unknown {
  return rpcResult({
    nonce: accessNonce,
    permission: 'FullAccess',
    block_hash: base58Encode(blockHash),
  });
}

function createRpcFetch(handler: (req: RpcRequest, init: RequestInit | undefined) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RpcRequest[];
} {
  const calls: RpcRequest[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const req = JSON.parse(String(init?.body)) as RpcRequest;
    calls.push(req);
    return handler(req, init);
  };
  return { fetchImpl, calls };
}

function throwawayKey(form: 'secret' | 'seed'): { nearKey: string; publicKey: KeyObject; rawPub: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
    throw new Error('expected ed25519 jwk material');
  }
  const seed = new Uint8Array(Buffer.from(jwk.d, 'base64url'));
  const rawPub = new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  assert.equal(seed.length, 32);
  assert.equal(rawPub.length, 32);
  const material = form === 'seed' ? seed : concatBytes(seed, rawPub);
  return { nearKey: `ed25519:${base58Encode(material)}`, publicKey, rawPub };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function assertNoSecret(value: unknown, secret: string): void {
  const texts: string[] = [];
  const walk = (current: unknown): void => {
    if (typeof current === 'string') {
      texts.push(current);
      return;
    }
    if (current instanceof Error) {
      texts.push(current.message);
      if (typeof current.stack === 'string') {
        texts.push(current.stack);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        walk(item);
      }
      return;
    }
    if (typeof current === 'object' && current !== null) {
      for (const item of Object.values(current)) {
        walk(item);
      }
    }
  };
  walk(value);
  for (const text of texts) {
    assert.equal(text.includes(secret), false);
  }
}

function decodeSignedTx(signedTxBase64: string): { txBytes: Uint8Array; signature: Uint8Array } {
  const signed = new Uint8Array(Buffer.from(signedTxBase64, 'base64'));
  assert.ok(signed.length > 65);
  const txLength = signed.length - 65;
  assert.equal(signed[txLength], 0);
  return {
    txBytes: signed.subarray(0, txLength),
    signature: signed.subarray(txLength + 1),
  };
}

function assertSigned(calls: RpcRequest[], rawPub: Uint8Array, publicKey: KeyObject, txHash: string): void {
  const query = calls[0];
  assert.ok(query);
  assert.equal(query.method, 'query');
  assert.equal(query.jsonrpc, '2.0');
  assert.equal(query.id, 'dontcare');
  assert.equal(query.params.request_type, 'view_access_key');
  assert.equal(query.params.finality, 'final');
  assert.equal(query.params.account_id, accountId);
  assert.equal(query.params.public_key, `ed25519:${base58Encode(rawPub)}`);

  const send = calls[1];
  assert.ok(send);
  assert.equal(send.method, 'send_tx');
  assert.equal(send.params.wait_until, 'EXECUTED_OPTIMISTIC');
  const signedTxBase64 = send.params.signed_tx_base64;
  assert.equal(typeof signedTxBase64, 'string');
  if (typeof signedTxBase64 !== 'string') {
    return;
  }
  const { txBytes, signature } = decodeSignedTx(signedTxBase64);
  const expected = serializeTransferTransaction({
    signerId: accountId,
    publicKey: rawPub,
    nonce: BigInt(accessNonce + 1),
    receiverId,
    blockHash,
    depositYocto: BigInt(amountYocto),
  });
  assert.equal(hex(txBytes), hex(expected));
  const hash = createHash('sha256').update(txBytes).digest();
  assert.equal(base58Encode(new Uint8Array(hash)), txHash);
  assert.equal(signature.length, 64);
  assert.equal(verify(null, hash, publicKey, Buffer.from(signature)), true);
}

describe('NEAR borsh and base58', () => {
  it('matches the near-api-js transfer serialization vector', () => {
    const publicKey = base58Decode(PUBKEY_B58);
    const block = base58Decode(BLOCK_B58);
    assert.equal(hex(publicKey), '917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d');
    assert.equal(hex(block), '0fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef6');
    const bytes = serializeTransferTransaction({
      signerId: 'test.near',
      publicKey,
      nonce: 1n,
      receiverId: 'whatever.near',
      blockHash: block,
      depositYocto: 1n,
    });
    assert.equal(hex(bytes), SERIALIZED_TX);
  });

  it('round-trips base58, including leading zeros', () => {
    const samples = [
      new Uint8Array(),
      Uint8Array.of(0),
      Uint8Array.of(0, 0),
      Uint8Array.of(0, 1),
      Uint8Array.of(1, 2, 3, 0, 255),
      base58Decode(PUBKEY_B58),
      base58Decode(BLOCK_B58),
    ];
    for (const sample of samples) {
      assert.equal(hex(base58Decode(base58Encode(sample))), hex(sample));
    }
    assert.equal(base58Encode(base58Decode(PUBKEY_B58)), PUBKEY_B58);
    assert.equal(base58Encode(base58Decode(BLOCK_B58)), BLOCK_B58);
  });
});

describe('createNearRpcClient', () => {
  async function sendWith(
    form: 'secret' | 'seed',
    onSend: (req: RpcRequest, nearKey: string) => Response | Promise<Response>,
    onQuery?: (req: RpcRequest, nearKey: string) => Response | Promise<Response>,
  ): Promise<{
    result: NearSendResult;
    calls: RpcRequest[];
    nearKey: string;
    publicKey: KeyObject;
    rawPub: Uint8Array;
  }> {
    const key = throwawayKey(form);
    const { fetchImpl, calls } = createRpcFetch((req, init) => {
      assert.equal(init?.method, 'POST');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('content-type'), 'application/json');
      if (req.method === 'query') {
        return onQuery ? onQuery(req, key.nearKey) : jsonResponse(accessKeyBody());
      }
      if (req.method === 'send_tx') {
        return onSend(req, key.nearKey);
      }
      return jsonResponse({ jsonrpc: '2.0', id: req.id, error: { message: 'unexpected method' } }, 500);
    });
    const client = createNearRpcClient({
      rpcUrl: 'https://rpc.testnet.near.org',
      accountId,
      privateKey: key.nearKey,
      fetch: fetchImpl,
    });
    const result = await client.sendTransfer({ receiverId, amountYocto });
    return { result, calls, nearKey: key.nearKey, publicKey: key.publicKey, rawPub: key.rawPub };
  }

  for (const form of ['secret', 'seed'] as const) {
    it(`signs a ${form} key transfer and reports final success`, async () => {
      const sent = await sendWith(form, () => jsonResponse(rpcResult({ status: { SuccessValue: '' } })));
      assert.equal(sent.result.kind, 'final');
      if (sent.result.kind !== 'final') {
        return;
      }
      assert.equal(sent.result.success, true);
      assert.equal(sent.result.failure, undefined);
      assertSigned(sent.calls, sent.rawPub, sent.publicKey, sent.result.txHash);
      assertNoSecret(sent.result, sent.nearKey);
    });
  }

  it('maps failure, rejection, timeout, transport errors, and a failed access-key query', async () => {
    const failure = await sendWith('secret', () =>
      jsonResponse(rpcResult({ status: { Failure: { ActionError: { kind: 'nope' } } } })),
    );
    assert.equal(failure.result.kind, 'final');
    if (failure.result.kind !== 'final') {
      return;
    }
    assert.equal(failure.result.success, false);
    assert.deepEqual(failure.result.failure, { ActionError: { kind: 'nope' } });
    assertSigned(failure.calls, failure.rawPub, failure.publicKey, failure.result.txHash);
    assertNoSecret(failure.result, failure.nearKey);

    const invalid = await sendWith('secret', (_req, nearKey) =>
      jsonResponse(rpcError('INVALID_TRANSACTION', `InvalidNonce ${nearKey}`)),
    );
    assert.equal(invalid.result.kind, 'rejected');
    if (invalid.result.kind !== 'rejected' || invalid.result.txHash === undefined) {
      throw new Error('expected rejected result with txHash');
    }
    assertSigned(invalid.calls, invalid.rawPub, invalid.publicKey, invalid.result.txHash);
    assertNoSecret(invalid.result, invalid.nearKey);

    const timeout = await sendWith('secret', (_req, nearKey) =>
      jsonResponse(rpcError('TIMEOUT_ERROR', `timed out ${nearKey}`)),
    );
    assert.equal(timeout.result.kind, 'unknown');
    if (timeout.result.kind !== 'unknown' || timeout.result.txHash === undefined) {
      throw new Error('expected unknown result with txHash');
    }
    assertSigned(timeout.calls, timeout.rawPub, timeout.publicKey, timeout.result.txHash);
    assertNoSecret(timeout.result, timeout.nearKey);

    const thrown = await sendWith('secret', (_req, nearKey) => {
      throw new Error(`socket ${nearKey}`);
    });
    assert.equal(thrown.result.kind, 'unknown');
    if (thrown.result.kind !== 'unknown' || thrown.result.txHash === undefined) {
      throw new Error('expected unknown result with txHash');
    }
    assert.equal(thrown.calls.length, 2);
    assertSigned(thrown.calls, thrown.rawPub, thrown.publicKey, thrown.result.txHash);
    assertNoSecret(thrown.result, thrown.nearKey);
    assert.ok(thrown.result.error instanceof Error);
    assert.equal(thrown.result.error.message.includes(thrown.nearKey), false);

    const server = await sendWith('secret', () => jsonResponse({ message: 'bad gateway' }, 503));
    assert.equal(server.result.kind, 'unknown');
    if (server.result.kind !== 'unknown') {
      return;
    }
    assert.equal(typeof server.result.txHash, 'string');
    assertNoSecret(server.result, server.nearKey);

    const queryFailed = await sendWith(
      'secret',
      () => {
        throw new Error('send should not run');
      },
      (_req, nearKey) => jsonResponse(rpcError('INVALID_ACCOUNT', nearKey)),
    );
    assert.deepEqual(
      { kind: queryFailed.result.kind, hasHash: 'txHash' in queryFailed.result },
      { kind: 'rejected', hasHash: false },
    );
    assert.equal(queryFailed.calls.length, 1);
    assert.equal(queryFailed.calls[0]?.method, 'query');
    assertNoSecret(queryFailed.result, queryFailed.nearKey);

    const queryThrown = await sendWith(
      'secret',
      () => jsonResponse(rpcResult({ status: { SuccessValue: '' } })),
      (_req, nearKey) => {
        throw new Error(`dns ${nearKey}`);
      },
    );
    assert.equal(queryThrown.result.kind, 'rejected');
    assert.equal('txHash' in queryThrown.result, false);
    assert.equal(queryThrown.calls.length, 1);
    assertNoSecret(queryThrown.result, queryThrown.nearKey);
  });

  it('maps tx status, including UNKNOWN_TRANSACTION', async () => {
    const key = throwawayKey('secret');
    let mode: 'success' | 'failure' | 'missing' | 'down' | 'http' = 'success';
    const { fetchImpl, calls } = createRpcFetch((req) => {
      assert.equal(req.method, 'tx');
      assert.equal(req.params.tx_hash, 'abc');
      assert.equal(req.params.sender_account_id, accountId);
      assert.equal(req.params.wait_until, 'EXECUTED_OPTIMISTIC');
      if (mode === 'success') {
        return jsonResponse(rpcResult({ status: { SuccessValue: '' } }));
      }
      if (mode === 'failure') {
        return jsonResponse(rpcResult({ status: { Failure: { kind: 'x' } } }));
      }
      if (mode === 'missing') {
        return jsonResponse(rpcError('UNKNOWN_TRANSACTION', key.nearKey));
      }
      if (mode === 'http') {
        return jsonResponse({ message: key.nearKey }, 503);
      }
      throw new Error(`down ${key.nearKey}`);
    });
    const client = createNearRpcClient({
      rpcUrl: 'https://rpc.testnet.near.org',
      accountId,
      privateKey: key.nearKey,
      fetch: fetchImpl,
    });

    const expectStatus = async (next: typeof mode, expected: NearStatusResult): Promise<void> => {
      mode = next;
      const before = calls.length;
      const result = await client.txStatus('abc');
      assert.deepEqual(result, expected);
      assert.ok(calls.length > before);
      assertNoSecret(result, key.nearKey);
    };

    await expectStatus('success', { kind: 'final', success: true });
    await expectStatus('failure', { kind: 'final', success: false, failure: { kind: 'x' } });
    await expectStatus('missing', { kind: 'notFound' });
    await expectStatus('http', { kind: 'unknown', error: { message: '[redacted]' } });

    mode = 'down';
    const down = await client.txStatus('abc');
    assert.equal(down.kind, 'unknown');
    if (down.kind === 'unknown') {
      assert.ok(down.error instanceof Error);
      assert.equal(down.error.message.includes(key.nearKey), false);
    }
    assertNoSecret(down, key.nearKey);
  });

  it('reads env config and rejects a bad key without echoing it', () => {
    const secret = 'ed25519:not-valid-base58-????';
    assert.throws(
      () =>
        createNearRpcClient({
          rpcUrl: 'https://rpc.testnet.near.org',
          accountId: 'alice.testnet',
          privateKey: secret,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes('not-valid-base58'), false);
        return true;
      },
    );

    const config = nearConfigFromEnv({
      NEAR_ACCOUNT_ID: 'alice.testnet',
      NEAR_PRIVATE_KEY: 'ed25519:example',
      NEAR_NETWORK: 'mainnet',
    } as NodeJS.ProcessEnv);
    assert.equal(config.accountId, 'alice.testnet');
    assert.equal(config.networkId, 'mainnet');
    assert.equal(config.rpcUrl, 'https://rpc.mainnet.near.org');
    assert.equal(config.privateKey, 'ed25519:example');
    assert.throws(() => nearConfigFromEnv({} as NodeJS.ProcessEnv), /NEAR_ACCOUNT_ID/);
    assert.throws(
      () => nearConfigFromEnv({ NEAR_ACCOUNT_ID: 'alice.testnet' } as NodeJS.ProcessEnv),
      /NEAR_PRIVATE_KEY/,
    );
  });
});
