import { createContext } from 'react';
import type { AgentPayClient } from './inMemoryClient';

export const AgentPayClientContext = createContext<AgentPayClient | null>(null);
