import type { AgentPayClient } from './agentPayClient';
import { createHttpClient } from './httpClient';
import { createInMemoryClient, type InMemoryClientOptions } from './inMemoryClient';

function mockOptionsFromUrl(): InMemoryClientOptions {
  const options: InMemoryClientOptions = {};
  if (typeof window === 'undefined') return options;
  const params = new URLSearchParams(window.location.search);
  if (params.get('simulatePending') === '1') {
    options.pendingSettlement = { afterChecks: 1 };
  }
  const submittingMs = params.get('simulateSubmitting');
  if (submittingMs !== null && submittingMs !== '') {
    const ms = Number(submittingMs);
    if (Number.isFinite(ms) && ms >= 0) options.payDelayMs = ms;
  }
  const manualResolve = params.get('simulateManualResolve');
  if (manualResolve === '1') {
    options.payOutcome = 'timeout';
  } else if (manualResolve === 'throw') {
    options.payOutcome = 'throw';
  } else if (manualResolve === 'mismatch') {
    options.payOutcome = 'mismatch';
  }
  if (params.get('simulateStuck') === '1') {
    options.payOutcome = 'hang';
  }
  if (params.get('simulateInvalidPolicy') === '1') {
    options.invalidPolicy = true;
  }
  return options;
}

export function createClient(env: ImportMetaEnv = import.meta.env): AgentPayClient {
  const raw = env.VITE_API_BASE;
  const base = typeof raw === 'string' ? raw.trim() : '';
  if (!base) {
    return createInMemoryClient(mockOptionsFromUrl());
  }
  return createHttpClient({ baseUrl: base });
}
