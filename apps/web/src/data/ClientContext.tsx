import { useRef, type ReactNode } from 'react';
import {
  createInMemoryClient,
  type AgentPayClient,
  type InMemoryClientOptions,
} from './inMemoryClient';
import { AgentPayClientContext } from './agentPayClientContext';

export function ClientProvider({
  children,
  options,
  client: injected,
}: {
  children: ReactNode;
  options?: InMemoryClientOptions;
  client?: AgentPayClient;
}) {
  const clientRef = useRef<AgentPayClient | null>(null);
  if (injected) {
    clientRef.current = injected;
  } else if (!clientRef.current) {
    clientRef.current = createInMemoryClient(options);
  }
  const client = injected ?? clientRef.current!;

  return (
    <AgentPayClientContext.Provider value={client}>
      {children}
    </AgentPayClientContext.Provider>
  );
}
