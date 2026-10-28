import { join } from 'node:path';
import type { Rail } from '@agent-pay/core';
import { AdapterConfigError, parseRail } from './adapters.ts';

export interface ApiConfig {
  port: number;
  host: string;
  ledgerPath: string;
  rail: Rail;
}

/** apps/api/.data/ledger.json, independent of the working directory. Gitignored. */
export const DEFAULT_LEDGER_PATH = join(import.meta.dirname, '..', '.data', 'ledger.json');
export const DEFAULT_PORT = 8787;

/** Reads PORT, HOST, LEDGER_PATH and RAIL. Throws AdapterConfigError on bad values. */
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): ApiConfig {
  const portRaw = env.PORT;
  const port = portRaw === undefined || portRaw === '' ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AdapterConfigError(`invalid_port: PORT must be an integer 0-65535, got "${portRaw}"`);
  }
  return {
    port,
    host: env.HOST || '127.0.0.1',
    ledgerPath: env.LEDGER_PATH || DEFAULT_LEDGER_PATH,
    rail: parseRail(env.RAIL),
  };
}
