import type { AgentPayClient } from './agentPayClient';
import { createHttpClient } from './httpClient';
import { createInMemoryClient } from './inMemoryClient';

export function createClient(env: ImportMetaEnv = import.meta.env): AgentPayClient {
  const raw = env.VITE_API_BASE;
  const base = typeof raw === 'string' ? raw.trim() : '';
  if (!base) {
    return createInMemoryClient();
  }
  return createHttpClient({ baseUrl: base });
}
