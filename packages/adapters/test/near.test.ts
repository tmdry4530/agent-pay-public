import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdapterValidationError,
  createNearAdapter,
  formatYoctoToNear,
  isAcceptedPayee,
  isValidNearAccountId,
  parseNearToYocto,
  type NearAdapterOptions,
  type NearClient,
  type NearSendResult,
  type NearStatusResult,
  type NearTransferRequest,
  type PaymentIntent,
  type Receipt,
  type AdapterReceipt,
  type ReceiptStatus,
  receiptMeta,
} from '../src/index.ts';

const ALLOWED: ReadonlySet<ReceiptStatus> = new Set(['succeeded', 'pending', 'failed', 'refunded']);
const AT = new Date('2026-04-01T00:00:00.000Z');

function baseIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'intent-near-1',
    agentId: 'agent-1',
    payee: 'bob.testnet',
    amount: 1,
    currency: 'NEAR',
    purpose: 'demo',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface FakeClient extends NearClient {
  calls: { op: 'send' | 'status'; arg: unknown }[];
}

function createFakeClient(handlers: {
  accountId?: string;
  sendTransfer?: (req: NearTransferRequest) => Promise<NearSendResult> | NearSendResult;
  txStatus?: (txHash: string) => Promise<NearStatusResult> | NearStatusResult;
} = {}): FakeClient {
  const calls: FakeClient['calls'] = [];
  return {
    accountId: handlers.accountId ?? 'alice.testnet',
    calls,
    async sendTransfer(req) {
      calls.push({ op: 'send', arg: req });
      if (!handlers.sendTransfer) {
        return { kind: 'final', txHash: 'hash-1', success: true };
      }
      return handlers.sendTransfer(req);
    },
    async txStatus(txHash) {
      calls.push({ op: 'status', arg: txHash });
      if (!handlers.txStatus) {
        return { kind: 'final', success: true };
      }
      return handlers.txStatus(txHash);
    },
  };
}

function adapterFor(
  client: NearClient,
  extra: Partial<Omit<NearAdapterOptions, 'client'>> = {},
) {
  return createNearAdapter({ client, now: () => AT, ...extra });
}

function assertContract(receipt: AdapterReceipt, intentId: string): void {
  assert.equal(receipt.intentId, intentId);
  assert.equal(receipt.rail, 'near');
  assert.ok(ALLOWED.has(receipt.status), `unexpected status: ${receipt.status}`);
}

describe('parseNearToYocto', () => {
  it('converts whole and fractional NEAR without float error', () => {
    assert.equal(parseNearToYocto(1), '1000000000000000000000000');
    assert.equal(parseNearToYocto(0.5), '500000000000000000000000');
    assert.equal(parseNearToYocto(0.1), '100000000000000000000000');
    assert.equal(parseNearToYocto('1.000000000000000000000001'), '1000000000000000000000001');
    assert.equal(parseNearToYocto('12.3456'), '12345600000000000000000000');
    assert.equal(parseNearToYocto('1.2300'), '1230000000000000000000000');
    assert.equal(parseNearToYocto(1e-7), '100000000000000000');
    assert.equal(parseNearToYocto('1e-7'), '100000000000000000');
    assert.equal(parseNearToYocto('1e+21'), `1${'0'.repeat(45)}`);
  });

  it('formats yocto back to a NEAR decimal', () => {
    assert.equal(formatYoctoToNear('1000000000000000000000000'), '1');
    assert.equal(formatYoctoToNear('500000000000000000000000'), '0.5');
    assert.equal(formatYoctoToNear('100000000000000000000000'), '0.1');
    assert.equal(formatYoctoToNear('1000000000000000000000001'), '1.000000000000000000000001');
    assert.equal(formatYoctoToNear(parseNearToYocto('12.3456')), '12.3456');
  });

  it('rejects zero, negative, NaN, non-finite, and too many decimals', () => {
    for (const amount of [0, -1, -0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0', '-1', '0.0']) {
      assert.throws(() => parseNearToYocto(amount), Error);
    }
    assert.throws(() => parseNearToYocto(`0.${'0'.repeat(24)}1`), /24 decimal/);
    assert.throws(() => parseNearToYocto('1.2.3'), /invalid amount/);
  });
});

describe('NEAR account ids', () => {
  const implicit = 'a'.repeat(64);

  it('accepts nearcore account ids and rejects malformed ones', () => {
    for (const id of ['alice.testnet', 'alice.near', 'alice', 'aa', 'bob.alice.testnet', implicit, '1'.repeat(64)]) {
      assert.equal(isValidNearAccountId(id), true, id);
    }
    for (const id of [
      'a',
      '',
      'Alice.testnet',
      'alice..testnet',
      '-alice.testnet',
      'alice-.testnet',
      '.alice.testnet',
      'alice.',
      'a'.repeat(65),
      'g'.repeat(65),
    ]) {
      assert.equal(isValidNearAccountId(id), false, id);
    }
  });

  it('accepts network suffixes and implicit accounts only', () => {
    assert.equal(isAcceptedPayee('alice.testnet', 'testnet'), true);
    assert.equal(isAcceptedPayee('bob.alice.testnet', 'testnet'), true);
    assert.equal(isAcceptedPayee(implicit, 'testnet'), true);
    assert.equal(isAcceptedPayee(implicit, 'mainnet'), true);
    assert.equal(isAcceptedPayee('alice.near', 'mainnet'), true);

    for (const id of ['Alice.testnet', 'alice..testnet', '-alice.testnet', 'a', 'alice']) {
      assert.equal(isAcceptedPayee(id, 'testnet'), false, id);
    }
    assert.equal(isAcceptedPayee('alice.near', 'testnet'), false);
    assert.equal(isAcceptedPayee('alice.testnet', 'mainnet'), false);
    assert.equal(isAcceptedPayee('g'.repeat(64), 'testnet'), false);
    assert.equal(isValidNearAccountId('alice'), true);
  });
});

describe('createNearAdapter', () => {
  it('has no refund and maps each send outcome onto the receipt contract', async () => {
    const cases: { name: string; send: NearSendResult | 'throw'; status: ReceiptStatus; externalId: string; unknown: boolean }[] = [
      { name: 'final success', send: { kind: 'final', txHash: 'tx-ok', success: true }, status: 'succeeded', externalId: 'tx-ok', unknown: false },
      { name: 'final failure', send: { kind: 'final', txHash: 'tx-bad', success: false, failure: { reason: 'err' } }, status: 'failed', externalId: 'tx-bad', unknown: false },
      { name: 'rejected with hash', send: { kind: 'rejected', txHash: 'tx-rej', error: 'InvalidNonce' }, status: 'failed', externalId: 'tx-rej', unknown: false },
      { name: 'rejected without hash', send: { kind: 'rejected', error: 'no key' }, status: 'failed', externalId: '', unknown: false },
      { name: 'unknown with hash', send: { kind: 'unknown', txHash: 'tx-unk', error: 'timeout' }, status: 'pending', externalId: 'tx-unk', unknown: true },
      { name: 'unknown without hash', send: { kind: 'unknown', error: 'timeout' }, status: 'pending', externalId: '', unknown: true },
    ];

    for (const item of cases) {
      const client = createFakeClient({
        sendTransfer: () => {
          if (item.send === 'throw') {
            throw new Error('boom');
          }
          return item.send;
        },
      });
      const adapter = adapterFor(client);
      assert.equal(adapter.refund, undefined);
      assert.equal(adapter.rail, 'near');
      const receipt = await adapter.pay(baseIntent());
      assertContract(receipt, 'intent-near-1');
      assert.equal(receipt.status, item.status, item.name);
      assert.equal(receipt.externalId, item.externalId, item.name);
      assert.equal(receipt.at, AT.toISOString());
      assert.equal(receiptMeta(receipt)?.amountYocto, '1000000000000000000000000');
      assert.equal(receiptMeta(receipt)?.receiverId, 'bob.testnet');
      assert.equal(receiptMeta(receipt)?.network, 'testnet');
      assert.equal(receiptMeta(receipt)?.unknownOutcome, item.unknown ? 'true' : undefined, item.name);
    }

    const errors: unknown[] = [];
    const throwing = createFakeClient({
      sendTransfer: () => {
        throw new Error('socket down');
      },
    });
    const adapter = adapterFor(throwing, {
      onError: (error, ctx) => {
        errors.push({ error, ctx });
      },
    });
    const receipt = await adapter.pay(baseIntent());
    assertContract(receipt, 'intent-near-1');
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.externalId, '');
    assert.equal(receiptMeta(receipt)?.unknownOutcome, 'true');
    assert.equal(errors.length, 1);
    const reported = errors[0] as { error: Error; ctx: { intentId: string; op: string } };
    assert.equal(reported.error.message, 'socket down');
    assert.equal(reported.ctx.intentId, 'intent-near-1');
    assert.equal(reported.ctx.op, 'send');
  });

  it('calls onError for failed, rejected, and unknown send outcomes', async () => {
    const secretMarker = 'ed25519:NEVER_LEAK_THIS_PRIVATE_KEY';
    const cases: { name: string; send: NearSendResult; expected: unknown }[] = [
      {
        name: 'final failure',
        send: { kind: 'final', txHash: 'tx-bad', success: false, failure: { reason: 'err' } },
        expected: { reason: 'err' },
      },
      {
        name: 'rejected',
        send: { kind: 'rejected', txHash: 'tx-rej', error: 'InvalidNonce' },
        expected: 'InvalidNonce',
      },
      {
        name: 'unknown',
        send: { kind: 'unknown', txHash: 'tx-unk', error: 'timeout' },
        expected: 'timeout',
      },
    ];

    for (const item of cases) {
      const errors: unknown[] = [];
      const client = createFakeClient({ sendTransfer: () => item.send });
      const adapter = adapterFor(client, {
        onError: (error, ctx) => {
          errors.push({ error, ctx });
          const payload = JSON.stringify({ error, ctx });
          assert.ok(!payload.includes(secretMarker), `${item.name}: onError payload must not contain key material`);
        },
      });
      await adapter.pay(baseIntent());
      assert.equal(errors.length, 1, item.name);
      const reported = errors[0] as { error: unknown; ctx: { intentId: string; op: string } };
      assert.deepEqual(reported.error, item.expected, item.name);
      assert.equal(reported.ctx.intentId, 'intent-near-1', item.name);
      assert.equal(reported.ctx.op, 'send', item.name);
    }

    const successErrors: unknown[] = [];
    await adapterFor(createFakeClient(), {
      onError: (error, ctx) => successErrors.push({ error, ctx }),
    }).pay(baseIntent());
    assert.equal(successErrors.length, 0);
  });

  it('passes yocto amounts to the client', async () => {
    const client = createFakeClient();
    const adapter = adapterFor(client);
    await adapter.pay(baseIntent({ amount: 0.1, currency: 'near' }));
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0], {
      op: 'send',
      arg: { receiverId: 'bob.testnet', amountYocto: '100000000000000000000000' },
    });
  });

  it('throws validation errors without calling the client', async () => {
    const client = createFakeClient({
      accountId: 'alice.testnet',
      sendTransfer: () => {
        throw new Error('client should not be called');
      },
    });
    const adapter = adapterFor(client);
    const cases: { name: string; intent: PaymentIntent; field: string }[] = [
      { name: 'usd', intent: baseIntent({ currency: 'USD' }), field: 'currency' },
      { name: 'uppercase', intent: baseIntent({ payee: 'Alice.testnet' }), field: 'payee' },
      { name: 'double dot', intent: baseIntent({ payee: 'alice..testnet' }), field: 'payee' },
      { name: 'leading dash', intent: baseIntent({ payee: '-alice.testnet' }), field: 'payee' },
      { name: 'too short', intent: baseIntent({ payee: 'a' }), field: 'payee' },
      { name: 'no suffix', intent: baseIntent({ payee: 'alice' }), field: 'payee' },
      { name: 'mainnet suffix', intent: baseIntent({ payee: 'alice.near' }), field: 'payee' },
      { name: 'self', intent: baseIntent({ payee: 'alice.testnet' }), field: 'payee' },
      { name: 'zero', intent: baseIntent({ amount: 0 }), field: 'amount' },
    ];
    for (const item of cases) {
      await assert.rejects(
        () => adapter.pay(item.intent),
        (error: unknown) => {
          assert.ok(error instanceof AdapterValidationError, item.name);
          assert.equal(error.field, item.field, item.name);
          return true;
        },
      );
    }
    assert.equal(client.calls.length, 0);

    const mainnetClient = createFakeClient({ accountId: 'alice.near' });
    const mainnet = adapterFor(mainnetClient, { networkId: 'mainnet' });
    await assert.rejects(
      () => mainnet.pay(baseIntent({ payee: 'bob.testnet' })),
      (error: unknown) => error instanceof AdapterValidationError && error.field === 'payee',
    );
    assert.equal(mainnetClient.calls.length, 0);
  });

  it('re-checks status for each tx outcome', async () => {
    const pending: AdapterReceipt = {
      intentId: 'intent-near-1',
      rail: 'near',
      externalId: 'tx-pending',
      status: 'pending',
      at: '2026-01-02T00:00:00.000Z',
      meta: { amountYocto: '1', receiverId: 'bob.testnet', network: 'testnet', unknownOutcome: 'true' },
    };

    const successClient = createFakeClient({ txStatus: () => ({ kind: 'final', success: true }) });
    const succeeded = await adapterFor(successClient).status!(pending);
    assertContract(succeeded, pending.intentId);
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.externalId, 'tx-pending');
    assert.equal(succeeded.rail, 'near');
    assert.deepEqual(receiptMeta(succeeded), pending.meta);
    assert.equal(succeeded.at, AT.toISOString());

    const failClient = createFakeClient({
      txStatus: () => ({ kind: 'final', success: false, failure: { ActionError: 'x' } }),
    });
    const failed = await adapterFor(failClient).status!(pending);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.intentId, pending.intentId);
    assert.equal(failed.externalId, pending.externalId);
    assert.deepEqual(receiptMeta(failed), pending.meta);

    const missingClient = createFakeClient({ txStatus: () => ({ kind: 'notFound' }) });
    const stillPending = await adapterFor(missingClient).status!(pending);
    assert.equal(stillPending, pending);
    assert.equal(stillPending.status, 'pending');

    const seen: unknown[] = [];
    const unknownClient = createFakeClient({
      txStatus: () => ({ kind: 'unknown', error: new Error('rpc down') }),
    });
    const unchanged = await adapterFor(unknownClient, {
      onError: (error, ctx) => seen.push({ error, ctx }),
    }).status!(pending);
    assert.equal(unchanged, pending);
    assert.equal(seen.length, 1);
    const reported = seen[0] as { error: Error; ctx: { intentId: string; op: string } };
    assert.equal(reported.error.message, 'rpc down');
    assert.equal(reported.ctx.op, 'status');
    assert.equal(reported.ctx.intentId, pending.intentId);

    const throwing = createFakeClient({
      txStatus: () => {
        throw new Error('status exploded');
      },
    });
    const thrownSeen: string[] = [];
    const afterThrow = await adapterFor(throwing, {
      onError: (error) => {
        thrownSeen.push(error instanceof Error ? error.message : 'other');
      },
    }).status!(pending);
    assert.equal(afterThrow, pending);
    assert.deepEqual(thrownSeen, ['status exploded']);

    const other: AdapterReceipt = { ...pending, rail: 'mock' };
    await assert.rejects(() => adapterFor(createFakeClient()).status!(other), /another rail/);

    const empty: AdapterReceipt = { ...pending, externalId: '' };
    const emptyClient = createFakeClient();
    const same = await adapterFor(emptyClient).status!(empty);
    assert.equal(same, empty);
    assert.equal(emptyClient.calls.length, 0);
  });

  it('status succeeds from plain core Receipt without meta', async () => {
    const sender = 'signer.testnet';
    const client = createFakeClient({
      accountId: sender,
      txStatus: (hash) => {
        assert.equal(hash, 'tx-hash-only');
        return { kind: 'final', success: true };
      },
    });
    const plain: Receipt = {
      intentId: 'intent-near-1',
      rail: 'near',
      externalId: 'tx-hash-only',
      status: 'pending',
      at: '2026-01-02T00:00:00.000Z',
    };
    assert.equal('meta' in plain, false);
    const out = await adapterFor(client, { networkId: 'testnet' }).status!(plain);
    assert.equal(out.status, 'succeeded');
    assert.equal(receiptMeta(out), undefined);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0]?.op, 'status');
  });

  it('status failed from plain Receipt without meta', async () => {
    const client = createFakeClient({
      txStatus: () => ({ kind: 'final', success: false, failure: { err: 'x' } }),
    });
    const out = await adapterFor(client).status!({
      intentId: 'intent-near-1',
      rail: 'near',
      externalId: 'tx-bad',
      status: 'pending',
      at: '2026-01-02T00:00:00.000Z',
    });
    assert.equal(out.status, 'failed');
  });

  it('pay() to 64-hex implicit account', async () => {
    const implicit = 'a'.repeat(64);
    const client = createFakeClient({ accountId: 'alice.testnet' });
    const adapter = adapterFor(client);
    const receipt = await adapter.pay(baseIntent({ payee: implicit }));
    assertContract(receipt, 'intent-near-1');
    assert.equal(client.calls[0]?.op, 'send');
    assert.deepEqual((client.calls[0]?.arg as { receiverId: string }).receiverId, implicit);
  });
});
