// TODO: switch to @agent-pay/core types once packages/core is published by 개발팀1

export type Rail = 'mock' | 'paypal' | 'near';

export type PaymentIntent = {
  id: string;
  agentId: string;
  payee: string;
  amount: number;
  currency: string;
  purpose: string;
  createdAt: string;
};

export type Decision = {
  status: 'approved' | 'rejected' | 'needs_approval';
  reason: string;
};

export type Receipt = {
  intentId: string;
  rail: Rail;
  externalId: string;
  status: 'settled' | 'failed';
  at: string;
};

export type Policy = {
  agentId: string;
  dailyLimit: number;
  perTxCap: number;
  autoApproveBelow: number;
  allowedPayees: string[];
  currency: string;
};

export type LedgerEventType =
  | 'intent_created'
  | 'policy_decision'
  | 'human_approved'
  | 'human_denied'
  | 'payment_settled'
  | 'receipt';

export type LedgerEvent = {
  id: string;
  type: LedgerEventType;
  at: string;
  intentId?: string;
  amount?: number;
  currency?: string;
  rail?: Rail;
  externalId?: string;
  decision?: Decision;
  purpose?: string;
  payee?: string;
};

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
      payee: 'openai.example',
      amount: 12,
    },
    testId: 'scenario-approved',
  },
  {
    id: 'rejected',
    label: 'Rent GPU cluster',
    task: {
      purpose: 'Rent GPU cluster',
      payee: 'gpu-cloud.example',
      amount: 480,
    },
    testId: 'scenario-rejected',
  },
  {
    id: 'needs_approval',
    label: 'Purchase dataset license',
    task: {
      purpose: 'Purchase dataset license',
      payee: 'data-market.example',
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
