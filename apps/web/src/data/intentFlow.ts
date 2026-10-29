import { ReasonCode, reasonCode } from '@agent-pay/core/policy.ts';
import type { DecisionRecord, LedgerEntry } from '@agent-pay/core';
import type { PaymentResult, PipelineStep } from '../types';

export const PENDING_SLOW_MS = 30_000;

export type FlowStageId = 'intent' | 'policy' | 'approval' | 'payment' | 'receipt';

export type FlowStageState =
  | 'done'
  | 'current'
  | 'waiting'
  | 'skipped'
  | 'rejected'
  | 'failed'
  | 'pending'
  | 'upcoming';

export type IntentFlowOverall =
  | 'paid'
  | 'pending'
  | 'awaiting_approval'
  | 'rejected_by_policy'
  | 'rejected_by_human'
  | 'failed'
  | 'resolved';

export type FlowStage = {
  id: FlowStageId;
  state: FlowStageState;
  label: string;
  detail?: string;
};

export type IntentFlowView = {
  stages: FlowStage[];
  overall: IntentFlowOverall;
  overallLabel: string;
};

const STAGE_LABELS: Record<FlowStageId, string> = {
  intent: 'Intent',
  policy: 'Policy',
  approval: 'Approval',
  payment: 'Payment',
  receipt: 'Receipt',
};

function decisionRecords(entry: LedgerEntry): DecisionRecord[] {
  if (entry.decisions.length > 0) return entry.decisions;
  if (entry.decision) {
    return [{ ...entry.decision, at: entry.updatedAt }];
  }
  return [];
}

function isHumanDecision(record: DecisionRecord): boolean {
  const code = reasonCode(record);
  return code === ReasonCode.ApprovedByHuman || code === ReasonCode.RejectedByHuman;
}

function policyRecord(records: DecisionRecord[]): DecisionRecord | undefined {
  return records.find((r) => !isHumanDecision(r));
}

function humanRecord(records: DecisionRecord[]): DecisionRecord | undefined {
  return records.find((r) => isHumanDecision(r));
}

function overallLabel(overall: IntentFlowOverall): string {
  const map: Record<IntentFlowOverall, string> = {
    paid: 'Paid',
    pending: 'Pending receipt',
    awaiting_approval: 'Awaiting approval',
    rejected_by_policy: 'Rejected by policy',
    rejected_by_human: 'Rejected by human',
    failed: 'Payment failed',
    resolved: 'Resolved',
  };
  return map[overall];
}

function terminalBeforePayment(
  policy: DecisionRecord | undefined,
  human: DecisionRecord | undefined,
): 'policy_reject' | 'human_reject' | null {
  if (policy?.status === 'rejected') return 'policy_reject';
  if (human && reasonCode(human) === ReasonCode.RejectedByHuman) return 'human_reject';
  return null;
}

export function deriveIntentFlow(entry: LedgerEntry): IntentFlowView {
  const records = decisionRecords(entry);
  const policy = policyRecord(records);
  const human = humanRecord(records);
  const terminal = terminalBeforePayment(policy, human);

  const intentStage: FlowStage = {
    id: 'intent',
    state: 'done',
    label: STAGE_LABELS.intent,
    detail: entry.intent.purpose,
  };

  let policyState: FlowStageState = 'done';
  if (!policy) {
    policyState = 'waiting';
  } else if (policy.status === 'rejected') {
    policyState = 'rejected';
  } else if (policy.status === 'needs_approval' && !human) {
    policyState = 'done';
  } else if (policy.status === 'approved') {
    policyState = 'done';
  }

  const policyStage: FlowStage = {
    id: 'policy',
    state: policyState,
    label: STAGE_LABELS.policy,
    detail: policy ? policy.status.replace('_', ' ') : undefined,
  };

  let approvalState: FlowStageState = 'upcoming';
  if (terminal === 'policy_reject') {
    approvalState = 'skipped';
  } else if (policy?.status === 'approved' && reasonCode(policy) === ReasonCode.WithinPolicy) {
    approvalState = 'skipped';
  } else if (policy?.status === 'needs_approval') {
    if (human && reasonCode(human) === ReasonCode.ApprovedByHuman) {
      approvalState = 'done';
    } else if (human && reasonCode(human) === ReasonCode.RejectedByHuman) {
      approvalState = 'rejected';
    } else {
      approvalState = 'waiting';
    }
  } else if (policy?.status === 'approved') {
    approvalState = 'skipped';
  }

  let paymentState: FlowStageState = 'upcoming';
  if (terminal === 'policy_reject' || terminal === 'human_reject') {
    paymentState = 'upcoming';
  } else if (entry.paymentStatus === 'paid') {
    paymentState = 'done';
  } else if (entry.paymentStatus === 'failed') {
    paymentState = 'failed';
  } else if (policy?.status === 'needs_approval' && !human) {
    paymentState = 'upcoming';
  } else if (policy?.status === 'approved' || human) {
    paymentState = entry.receipt ? 'done' : 'waiting';
  }

  let receiptState: FlowStageState = 'upcoming';
  if (terminal) {
    receiptState = 'upcoming';
  } else if (!entry.receipt) {
    receiptState = paymentState === 'done' ? 'waiting' : 'upcoming';
  } else if (entry.receipt.status === 'succeeded') {
    receiptState = 'done';
  } else if (entry.receipt.status === 'pending') {
    receiptState = 'pending';
  } else {
    receiptState = 'failed';
  }

  if (entry.resolution) {
    receiptState = 'done';
  }

  const approvalStage: FlowStage = {
    id: 'approval',
    state: approvalState,
    label: STAGE_LABELS.approval,
  };

  const paymentStage: FlowStage = {
    id: 'payment',
    state: paymentState,
    label: STAGE_LABELS.payment,
    detail: entry.paymentStatus,
  };

  const receiptStage: FlowStage = {
    id: 'receipt',
    state: receiptState,
    label: STAGE_LABELS.receipt,
    detail: entry.receipt?.status ?? entry.resolution?.status,
  };

  let overall: IntentFlowOverall = 'paid';
  if (entry.resolution) {
    overall = 'resolved';
  } else if (terminal === 'policy_reject') {
    overall = 'rejected_by_policy';
  } else if (terminal === 'human_reject') {
    overall = 'rejected_by_human';
  } else if (entry.paymentStatus === 'failed') {
    overall = 'failed';
  } else if (entry.receipt?.status === 'pending') {
    overall = 'pending';
  } else if (policy?.status === 'needs_approval' && !human) {
    overall = 'awaiting_approval';
  } else if (entry.paymentStatus === 'paid' && entry.receipt?.status === 'succeeded') {
    overall = 'paid';
  }

  return {
    stages: [intentStage, policyStage, approvalStage, paymentStage, receiptStage],
    overall,
    overallLabel: overallLabel(overall),
  };
}

export type PipelineStepState =
  | 'done'
  | 'current'
  | 'upcoming'
  | 'skipped'
  | 'error'
  | 'pending';

export type PipelineStepView = {
  step: PipelineStep;
  state: PipelineStepState;
  label: string;
};

const PIPELINE_ORDER: PipelineStep[] = [
  'task',
  'quote',
  'policy',
  'decision',
  'approval',
  'payment',
  'receipt',
];

const PIPELINE_LABELS: Record<PipelineStep, string> = {
  task: 'Task',
  quote: 'Quote',
  policy: 'Policy',
  decision: 'Decision',
  approval: 'Approval',
  payment: 'Payment',
  receipt: 'Receipt',
};

function activeStepIndex(step: PipelineStep, result: PaymentResult | null): number {
  if (result?.receipt) return PIPELINE_ORDER.indexOf('receipt');
  if (result?.status === 'paid' || result?.status === 'failed') {
    return PIPELINE_ORDER.indexOf('payment');
  }
  if (result?.status === 'needs_approval' && step === 'approval') {
    return PIPELINE_ORDER.indexOf('approval');
  }
  if (result) return PIPELINE_ORDER.indexOf('decision');
  if (step === 'policy') return PIPELINE_ORDER.indexOf('policy');
  if (step === 'quote') return PIPELINE_ORDER.indexOf('quote');
  return PIPELINE_ORDER.indexOf('task');
}

export function derivePipelineSteps(
  step: PipelineStep,
  result: PaymentResult | null,
): PipelineStepView[] {
  const currentIdx = activeStepIndex(step, result);
  const approvalSkipped =
    result != null &&
    result.status !== 'needs_approval' &&
    result.status !== 'rejected' &&
    reasonCode(result.decision) !== ReasonCode.RejectedByHuman;

  const decisionError =
    result?.status === 'rejected' || result?.status === 'failed';

  return PIPELINE_ORDER.map((s, i) => {
    let state: PipelineStepState = 'upcoming';
    if (s === 'approval' && approvalSkipped && i <= currentIdx) {
      state = 'skipped';
    } else if (i < currentIdx) {
      state = 'done';
    } else if (i === currentIdx) {
      state = 'current';
    }

    if (s === 'decision' && decisionError && i <= currentIdx) {
      state = 'error';
    }
    if (s === 'payment' && result?.status === 'failed' && i <= currentIdx) {
      state = 'error';
    }
    if (s === 'receipt' && result?.receipt?.status === 'pending' && i === currentIdx) {
      state = 'pending';
    }
    if (s === 'approval' && result?.status === 'needs_approval' && i === currentIdx) {
      state = 'current';
    }
    if (
      s === 'approval' &&
      result &&
      reasonCode(result.decision) === ReasonCode.RejectedByHuman
    ) {
      state = 'error';
    }

    return { step: s, state, label: PIPELINE_LABELS[s] };
  });
}

export function stepperIcon(state: PipelineStepState): string {
  switch (state) {
    case 'done':
      return '✓';
    case 'skipped':
      return '–';
    case 'error':
      return '✕';
    case 'pending':
      return '…';
    case 'current':
      return '●';
    default:
      return String(PIPELINE_ORDER.indexOf('task') + 1);
  }
}

export function stepperStateText(state: PipelineStepState): string {
  switch (state) {
    case 'done':
      return 'completed';
    case 'skipped':
      return 'skipped';
    case 'error':
      return 'failed or rejected';
    case 'pending':
      return 'pending';
    case 'current':
      return 'current step';
    default:
      return 'upcoming';
  }
}

export function compactStageIcon(state: FlowStageState): string {
  switch (state) {
    case 'done':
      return '✓';
    case 'skipped':
      return '–';
    case 'rejected':
    case 'failed':
      return '✕';
    case 'pending':
    case 'waiting':
      return '…';
    case 'current':
      return '●';
    default:
      return '○';
  }
}

export function formatPendingElapsed(sinceIso: string, nowMs: number): string {
  const start = new Date(sinceIso).getTime();
  const sec = Math.max(0, Math.floor((nowMs - start) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `Pending for ${m}m ${s}s`;
  return `Pending for ${s}s`;
}
