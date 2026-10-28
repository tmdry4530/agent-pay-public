import { useContext } from 'react';
import { AgentPayClientContext } from './agentPayClientContext';
import type { AgentPayClient } from './inMemoryClient';

export function useAgentPayClient(): AgentPayClient {
  const client = useContext(AgentPayClientContext);
  if (!client) {
    throw new Error('useAgentPayClient must be used within ClientProvider');
  }
  return client;
}
