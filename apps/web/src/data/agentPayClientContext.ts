import { createContext } from 'react';
import type { AgentPayClient } from './agentPayClient';

export const AgentPayClientContext = createContext<AgentPayClient | null>(null);
