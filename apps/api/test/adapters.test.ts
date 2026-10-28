import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { PaymentIntent, Rail } from '@agent-pay/core';
import {
  AdapterConfigError,
  DEFAULT_LEDGER_PATH,
  DEFAULT_PORT,
  adapterRegistry,
  createAdapter,
  createMockAdapter,
  loadConfig,
  parseRail,
} from '../src/index.ts';
import type { AdapterFactory } from '../src/index.ts';

const execFileAsync = promisify(execFile);
const NOW = () => new Date('2026-10-28T12:00:00.000Z');

const intent = (): PaymentIntent => ({
  id: 'pi_test',
  agentId: 'demo-agent',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'test',
  createdAt: '2026-10-28T12:00:00.000Z',
});

test('parseRail(undefined) and parseRail("") default to mock', () => {
  assert.equal(parseRail(undefined), 'mock');
  assert.equal(parseRail(''), 'mock');
});

test('parseRail("bogus") throws AdapterConfigError', () => {
  assert.throws(() => parseRail('bogus'), AdapterConfigError);
});

test('createAdapter rejects unwired paypal and near rails', async () => {
  const ctx = { env: {}, now: NOW };
  await assert.rejects(createAdapter('paypal', ctx), /adapter not wired yet/);
  await assert.rejects(createAdapter('near', ctx), /adapter not wired yet/);
});

test('createAdapter("mock") pays with a succeeded receipt matching the intent', async () => {
  const adapter = await createAdapter('mock', { env: {}, now: NOW });
  const i = intent();
  const receipt = await adapter.pay(i);
  assert.equal(receipt.intentId, i.id);
  assert.equal(receipt.rail, 'mock');
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.at, NOW().toISOString());
  assert.match(receipt.externalId, /^mock_/);
});

test('createAdapter rejects factory that returns wrong rail', async () => {
  const badRegistry: Record<Rail, AdapterFactory | undefined> = {
    ...adapterRegistry,
    paypal: () => ({
      rail: 'mock',
      pay: async () => ({
        intentId: 'x',
        rail: 'mock',
        externalId: 'y',
        status: 'succeeded',
        at: NOW().toISOString(),
      }),
    }),
  };
  await assert.rejects(createAdapter('paypal', { env: {}, now: NOW }, badRegistry), /adapter_mismatch/);
});

test('createAdapter uses a custom registry plug-in for paypal', async () => {
  let plugInCalled = false;
  const registry: Record<Rail, AdapterFactory | undefined> = {
    ...adapterRegistry,
    paypal: (ctx) => {
      plugInCalled = true;
      return { ...createMockAdapter(ctx), rail: 'paypal' as const };
    },
  };
  const adapter = await createAdapter('paypal', { env: {}, now: NOW }, registry);
  assert.equal(plugInCalled, true);
  assert.equal(adapter.rail, 'paypal');
});

test('main entrypoint exits 1 when RAIL=near is not wired', async () => {
  const mainPath = join(import.meta.dirname, '../src/main.ts');
  try {
    await execFileAsync(process.execPath, [mainPath], {
      env: { ...process.env, RAIL: 'near', PORT: '0' },
      timeout: 10_000,
      encoding: 'utf8',
    });
    assert.fail('expected main to exit with code 1');
  } catch (err: unknown) {
    const e = err as { code?: number; stderr?: string };
    assert.equal(e.code, 1);
    assert.match(e.stderr ?? '', /adapter not wired yet/);
  }
});

test('loadConfig defaults: port 8787, rail mock, ledger under apps/api/.data', () => {
  const config = loadConfig({});
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.port, 8787);
  assert.equal(config.rail, 'mock');
  assert.ok(config.ledgerPath.endsWith('apps/api/.data/ledger.json'));
  assert.equal(config.ledgerPath, DEFAULT_LEDGER_PATH);
});

test('loadConfig throws on invalid PORT', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), AdapterConfigError);
});
