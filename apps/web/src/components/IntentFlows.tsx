import type { DecisionRecord, LedgerEntry } from '@agent-pay/core';
import { ReasonCode, reasonCode } from '@agent-pay/core/policy.ts';
import {
  reasonInfo,
  showReasonLabelForDecision,
  failureInfo,
  manualResolveErrorFromEntry,
  needsResolve,
} from '../data/compat';
import { deriveIntentFlow, compactStageIcon } from '../data/intentFlow';

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

function decisionRecords(entry: LedgerEntry): DecisionRecord[] {
  if (entry.decisions.length > 0) return entry.decisions;
  if (entry.decision) {
    return [{ ...entry.decision, at: entry.updatedAt }];
  }
  return [];
}

function policyReason(entry: LedgerEntry): string | undefined {
  const records = decisionRecords(entry);
  const policy = records.find(
    (r) =>
      reasonCode(r) !== ReasonCode.ApprovedByHuman &&
      reasonCode(r) !== ReasonCode.RejectedByHuman,
  );
  return policy?.reason;
}

function stageTooltip(stage: ReturnType<typeof deriveIntentFlow>['stages'][number], entry: LedgerEntry): string {
  if (stage.id === 'policy') {
    const reason = policyReason(entry);
    if (reason) {
      const info = reasonInfo(reason);
      const parts = [info.label];
      if (info.explanation) parts.push(info.explanation);
      if (info.detail) parts.push(info.detail);
      return parts.join(' — ');
    }
  }
  return stage.detail ?? stage.label;
}

type Props = {
  entries: LedgerEntry[];
  now: Date;
  onOpenResolve: (intentId: string) => void;
};

export function IntentFlows({ entries, now, onOpenResolve }: Props) {
  const sorted = [...entries].sort((a, b) =>
    a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0,
  );

  return (
    <div className="panel intent-flows-panel" data-testid="intent-flows">
      <h2>Intents</h2>
      {sorted.length === 0 ? (
        <p className="hint">Complete a scenario to see intent progress here.</p>
      ) : (
        <ul className="intent-flow-list">
          {sorted.map((entry) => {
            const flow = deriveIntentFlow(entry, now);
            const showResolve = needsResolve(entry, now);
            const policyReasonStr = policyReason(entry);
            const policyInfo = policyReasonStr ? reasonInfo(policyReasonStr) : null;
            const resolveErr = manualResolveErrorFromEntry(entry);
            const failure = flow.overall === 'needs_manual_resolve' ? failureInfo(resolveErr) : null;
            return (
              <li key={entry.intent.id} data-testid="intent-flow">
                <div className="intent-flow__header">
                  <span className="intent-flow__title">
                    {entry.intent.purpose} · {formatMoney(entry.intent.amount, entry.intent.currency)}
                  </span>
                  <span
                    className={`intent-flow__chip overall-${flow.overall}`}
                    title={failure ? `${failure.label}. ${failure.explanation}` : undefined}
                  >
                    {flow.overallLabel}
                    {failure && (
                      <span className="intent-flow__failure-label"> · {failure.label}</span>
                    )}
                    {policyInfo && showReasonLabelForDecision(policyInfo.code) && policyInfo.explanation && (
                      <span className="sr-only"> {policyInfo.explanation}</span>
                    )}
                  </span>
                </div>
                {flow.resolution && (
                  <p className="intent-resolution hint" data-testid="intent-resolution">
                    Resolved {flow.resolution.status} by {flow.resolution.resolvedBy} · {flow.resolution.note}
                  </p>
                )}
                {showResolve && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-resolve-open"
                    data-testid="btn-open-resolve"
                    aria-label={`Resolve ${entry.intent.purpose}`}
                    onClick={() => onOpenResolve(entry.intent.id)}
                  >
                    Resolve…
                  </button>
                )}
                <ol className="intent-track" aria-label={`Flow for ${entry.intent.purpose}`}>
                  {flow.stages.map((stage) => (
                    <li
                      key={stage.id}
                      data-stage={stage.id}
                      data-state={stage.state}
                      className={`intent-track__step state-${stage.state}`}
                      title={stageTooltip(stage, entry)}
                    >
                      <span className="intent-track__icon" aria-hidden>
                        {compactStageIcon(stage.state)}
                      </span>
                      <span className="intent-track__label">{stage.label}</span>
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
