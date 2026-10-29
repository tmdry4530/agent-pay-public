import type { LedgerEntry } from '@agent-pay/core';
import { deriveIntentFlow, compactStageIcon } from '../data/intentFlow';

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

type Props = {
  entries: LedgerEntry[];
};

export function IntentFlows({ entries }: Props) {
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
            const flow = deriveIntentFlow(entry);
            return (
              <li key={entry.intent.id} data-testid="intent-flow">
                <div className="intent-flow__header">
                  <span className="intent-flow__title">
                    {entry.intent.purpose} · {formatMoney(entry.intent.amount, entry.intent.currency)}
                  </span>
                  <span className={`intent-flow__chip overall-${flow.overall}`}>
                    {flow.overallLabel}
                  </span>
                </div>
                <ol className="intent-track" aria-label={`Flow for ${entry.intent.purpose}`}>
                  {flow.stages.map((stage) => (
                    <li
                      key={stage.id}
                      data-stage={stage.id}
                      data-state={stage.state}
                      className={`intent-track__step state-${stage.state}`}
                      title={stage.detail ?? stage.label}
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
