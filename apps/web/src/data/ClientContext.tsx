import { useRef, type ReactNode } from 'react';
import type { AgentPayClient } from './agentPayClient';
import { AgentPayClientContext } from './agentPayClientContext';
import { createClient } from './createClient';

export function ClientProvider({
  children,
  client: injected,
}: {
  children: ReactNode;
  client?: AgentPayClient;
}) {
  const clientRef = useRef<AgentPayClient | null>(null);
  if (injected) {
    clientRef.current = injected;
  } else if (!clientRef.current) {
    clientRef.current = createClient();
  }
  const client = injected ?? clientRef.current!;

  return (
    <AgentPayClientContext.Provider value={client}>
      {children}
    </AgentPayClientContext.Provider>
  );
}
