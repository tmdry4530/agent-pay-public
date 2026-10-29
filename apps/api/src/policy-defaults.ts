import type { Policy } from '@agent-pay/core';

/** Seed policy for demos. Replace at runtime with PUT /policy. */
export const DEFAULT_POLICY: Policy = {
  agentId: 'demo-agent',
  perTxMax: 100,
  dailyMax: 200,
  allowedPayees: ['openai-api', 'anthropic-api', 'vercel', 'near-compute'],
  requireApprovalAbove: 50,
  currency: 'USD',
};
