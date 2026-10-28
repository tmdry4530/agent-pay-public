import type { AgentPayClient } from './agentPayClient';
import { createHttpClient } from './httpClient';
import { createInMemoryClient } from './inMemoryClient';

export function createClient(env: ImportMetaEnv = import.meta.env): AgentPayClient {
  const raw = env.VITE_API_BASE;
  const base = typeof raw === 'string' ? raw.trim() : '';
  if (!base) {
    let pendingSettlement: { afterChecks: number; outcome?: 'succeeded' | 'failed' } | undefined;
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('simulatePending') === '1') {
        pendingSettlement = { afterChecks: 1 };
      }
    }
    return createInMemoryClient({ pendingSettlement });
  }
  return createHttpClient({ baseUrl: base });
}
