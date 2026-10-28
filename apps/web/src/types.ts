// Domain types re-exported from packages/core; web-only demo types live below.

export type {
  Currency,
  Decision,
  DecisionStatus,
  PaymentIntent,
  Policy,
  Rail,
  Receipt,
  ReceiptStatus,
} from '@agent-pay/core';

export type { PaymentResult, RunStatus } from '@agent-pay/core';
export type { LedgerEntry } from '@agent-pay/core';

export type { LedgerSnapshot } from './data/agentPayClient';

export type AgentTask = {
  purpose: string;
  payee: string;
  amount: number;
};

export type DemoScenario = {
  id: string;
  label: string;
  task: AgentTask;
  testId: string;
};

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'approved',
    label: 'Buy API credits',
    task: {
      purpose: 'Buy API credits',
      payee: 'openai-api',
      amount: 12,
    },
    testId: 'scenario-approved',
  },
  {
    id: 'rejected',
    label: 'Rent GPU cluster',
    task: {
      purpose: 'Rent GPU cluster',
      payee: 'near-compute',
      amount: 480,
    },
    testId: 'scenario-rejected',
  },
  {
    id: 'needs_approval',
    label: 'Buy NEAR compute hours',
    task: {
      purpose: 'Buy NEAR compute hours',
      payee: 'near-compute',
      amount: 75,
    },
    testId: 'scenario-needs-approval',
  },
];

export type PipelineStep =
  | 'task'
  | 'quote'
  | 'policy'
  | 'decision'
  | 'approval'
  | 'payment'
  | 'receipt';

export type { TimelineEvent } from './data/ledgerTimeline';
