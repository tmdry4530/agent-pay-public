import { join } from 'node:path';
import type { Rail } from '@agent-pay/core';
import { AdapterConfigError, parseRail } from './adapters.ts';

export interface ApiConfig {
  port: number;
  host: string;
  ledgerPath: string;
  rail: Rail;
  /** Background re-check of pending receipts; undefined when RECEIPT_POLL_MS=0. */
  receiptPoll?: { intervalMs: number; timeoutMs: number };
}

export const DEFAULT_RECEIPT_POLL_MS = 5000;
export const DEFAULT_RECEIPT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

function nonNegativeIntEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new AdapterConfigError(`invalid_${name.toLowerCase()}: ${name} must be a non-negative integer (ms), got "${raw}"`);
  }
  return n;
}

/** apps/api/.data/ledger.json, independent of the working directory. Gitignored. */
export const DEFAULT_LEDGER_PATH = join(import.meta.dirname, '..', '.data', 'ledger.json');
export const DEFAULT_PORT = 8787;

/**
 * Reads PORT, HOST, LEDGER_PATH, RAIL, RECEIPT_POLL_MS (default 5000, 0 = off) and RECEIPT_POLL_TIMEOUT_MS
 * (default 600000). Throws AdapterConfigError on bad values.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): ApiConfig {
  const portRaw = env.PORT;
  const port = portRaw === undefined || portRaw === '' ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AdapterConfigError(`invalid_port: PORT must be an integer 0-65535, got "${portRaw}"`);
  }
  const pollMs = nonNegativeIntEnv(env, 'RECEIPT_POLL_MS', DEFAULT_RECEIPT_POLL_MS);
  const pollTimeoutMs = nonNegativeIntEnv(env, 'RECEIPT_POLL_TIMEOUT_MS', DEFAULT_RECEIPT_POLL_TIMEOUT_MS);
  return {
    port,
    host: env.HOST || '127.0.0.1',
    ledgerPath: env.LEDGER_PATH || DEFAULT_LEDGER_PATH,
    rail: parseRail(env.RAIL),
    ...(pollMs > 0 && pollTimeoutMs > 0 ? { receiptPoll: { intervalMs: pollMs, timeoutMs: pollTimeoutMs } } : {}),
  };
}
