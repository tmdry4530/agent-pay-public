import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
} from 'react';
import {
  createInMemoryClient,
  type AgentPayClient,
  type InMemoryClientOptions,
} from './inMemoryClient';

const ClientContext = createContext<AgentPayClient | null>(null);

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
    <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
  );
}

export function useAgentPayClient(): AgentPayClient {
  const client = useContext(ClientContext);
  if (!client) {
    throw new Error('useAgentPayClient must be used within ClientProvider');
  }
  return client;
}
