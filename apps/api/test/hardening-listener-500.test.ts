import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp, createMockAdapter, loadConfig } from '../src/index.ts';

/**
 * L1: Exercises createApp().listener last-resort catch when `handle()` rejects after
 * the normal error path also fails to write a response. Fake `ServerResponse`: the first
 * two `writeHead` calls throw (success-path `send`, then catch-path `send`); the third
 * is the listener's `writeHead(500)` fallback (must emit JSON once hardened).
 */
test('L1: listener last-resort 500 is JSON internal_error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-api-l1-'));
  const config = loadConfig({ LEDGER_PATH: join(dir, 'ledger.json'), PORT: '0' });
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const { listener } = createApp({
    ledger: config.ledgerPath,
    adapter: createMockAdapter({ now: () => new Date('2026-10-28T12:00:00.000Z') }),
  });

  const req = new Readable({
    read() {
      this.push(null);
    },
  }) as IncomingMessage;
  req.method = 'GET';
  req.url = '/health';
  req.headers = {};

  let writeHeadCalls = 0;
  let statusCode = 0;
  let headersOut: Record<string, unknown> = {};
  let bodyOut = '';

  type FakeResponse = {
    headersSent: boolean;
    writeHead(
      status: number,
      headers?: Record<string, unknown> | string,
      maybeHeaders?: Record<string, unknown>,
    ): FakeResponse;
    end(chunk?: string): void;
  };

  const res: FakeResponse = {
    headersSent: false,
    writeHead(status, headers, maybeHeaders) {
      writeHeadCalls += 1;
      if (writeHeadCalls <= 2) {
        throw new Error('simulated response write failure');
      }
      this.headersSent = true;
      statusCode = status;
      if (typeof headers === 'object' && headers !== null) headersOut = headers;
      else if (typeof maybeHeaders === 'object' && maybeHeaders !== null) headersOut = maybeHeaders;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) bodyOut += chunk;
    },
  };

  const serverRes = res as unknown as ServerResponse;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listener did not finish')), 5000);
    listener(req, serverRes);
    const wait = () => {
      if (writeHeadCalls >= 3) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setImmediate(wait);
    };
    setImmediate(wait);
  });

  assert.ok(writeHeadCalls >= 3, 'expected listener last-resort writeHead after send failures');
  assert.equal(statusCode, 500);
  const ct = String(headersOut['Content-Type'] ?? headersOut['content-type'] ?? '');
  assert.match(ct, /application\/json/i);
  assert.deepEqual(JSON.parse(bodyOut), { error: 'internal_error: unexpected server error' });
});
