import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createPayPalAdapter } from '@agent-pay/adapters';
import { createServer } from '../src/index.ts';

const NOW = new Date('2026-11-01T03:00:00.000Z');
const TOKEN = 'A21AAledgertesttoken0123456789abcdef';
const SECRET = 'ledger-test-client-secret-0001';

test('declined PayPal payout: API answer and ledger carry the redacted PayPal error detail', async (t) => {
  const fetchMock: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: TOKEN, expires_in: 3600 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        name: 'RECEIVER_UNREGISTERED',
        message: `Receiver is unregistered (Authorization: Bearer ${TOKEN})`,
        debug_id: 'dbg77ledger',
        details: [{ issue: 'RECEIVER_UNREGISTERED', description: 'Receiver is unregistered' }],
      }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    );
  };
  const adapter = createPayPalAdapter({ clientId: 'ledger-test-client-id', clientSecret: SECRET, fetch: fetchMock });
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-err-'));
  const ledgerPath = join(dir, 'ledger.json');
  const server: Server = createServer({
    ledger: ledgerPath,
    adapter,
    now: () => new Date(NOW),
    policy: { agentId: 'demo-agent', perTxMax: 100, dailyMax: 200, requireApprovalAbove: 50, currency: 'USD', allowedPayees: ['merchant@example.com'] },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const res = await fetch(`${base}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'pi_err', agentId: 'demo-agent', payee: 'merchant@example.com', amount: 10, currency: 'USD', purpose: 'x', createdAt: NOW.toISOString() }),
  });
  const body = (await res.json()) as { status: string; error: string; receipt: { meta: Record<string, string> } };
  assert.equal(body.status, 'failed');
  assert.match(body.error, /^payment_declined: paypal declined \(paypal payout failed: HTTP 422: RECEIVER_UNREGISTERED: /);
  assert.match(body.error, /debug_id dbg77ledger/);
  assert.equal(body.receipt.meta.errorStatus, '422');

  const onDisk = await readFile(ledgerPath, 'utf8');
  assert.match(onDisk, /"errorDebugId": ?"dbg77ledger"/);
  assert.match(onDisk, /"errorName": ?"RECEIVER_UNREGISTERED"/);
  assert.ok(!onDisk.includes(TOKEN), 'access token never reaches the ledger');
  assert.ok(!onDisk.includes(SECRET), 'client secret never reaches the ledger');
});
