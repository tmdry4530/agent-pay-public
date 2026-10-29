import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, type PaymentAdapter, type PaymentIntent, type Policy, type Rail, type Receipt } from '../src/index.ts';

export async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export const NOW = '2026-10-28T12:00:00.000Z';
export const fixedClock = (iso: string = NOW) => () => new Date(iso);

export const basePolicy = (over: Partial<Policy> = {}): Policy => ({
  agentId: 'agent-1',
  perTxMax: 100,
  dailyMax: 200,
  allowedPayees: ['openai-api'],
  requireApprovalAbove: 100,
  ...over,
});

export const makeIntent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: 'pi-1',
  agentId: 'agent-1',
  payee: 'openai-api',
  amount: 10,
  currency: 'USD',
  purpose: 'inference credits',
  createdAt: '2026-10-28T10:00:00.000Z',
  ...over,
});

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Adapter whose pay() succeeds after `delayMs` (widens race windows). */
export function delayedAdapter(
  delayMs = 5,
  rail: Rail = 'mock',
  status: Receipt['status'] = 'succeeded',
): PaymentAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    rail,
    calls,
    async pay(intent) {
      calls.push(intent.id);
      await sleep(delayMs);
      return { intentId: intent.id, rail, externalId: `x-${intent.id}`, status, at: NOW };
    },
  };
}

/**
 * Exposes only the Ledger methods that existed before hardening (the shape the
 * web demo's MemoryLedger implements), so tests cover the orchestrator's
 * duck-typed fallback path.
 */
export function legacyView(ledger: Ledger): Ledger {
  const names = [
    'list', 'get', 'recordIntent', 'recordDecision', 'recordPayment', 'recordReceipt',
    'settleReceipt', 'dailyTotal', 'ledgerStateFor',
  ] as const;
  const view: Record<string, unknown> = {};
  for (const n of names) view[n] = (ledger as unknown as Record<string, (...a: unknown[]) => unknown>)[n]!.bind(ledger);
  return view as unknown as Ledger;
}

export function newLedger(dir: string, now: () => Date = fixedClock()): Ledger {
  return new Ledger({ filePath: join(dir, 'ledger.json'), now });
}
