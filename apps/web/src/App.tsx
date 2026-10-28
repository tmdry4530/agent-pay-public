import { useCallback, useMemo, useReducer, useState } from 'react';
import { useAgentPayClient } from './data/useAgentPayClient';
import {
  DEMO_SCENARIOS,
  type DemoScenario,
  type PaymentIntent,
  type PipelineStep,
  type Rail,
  type Receipt,
  type Decision,
} from './types';
import './App.css';

const STEP_ORDER: PipelineStep[] = [
  'task',
  'quote',
  'policy',
  'decision',
  'approval',
  'payment',
  'receipt',
];

const STEP_LABELS: Record<PipelineStep, string> = {
  task: 'Task',
  quote: 'Quote',
  policy: 'Policy',
  decision: 'Decision',
  approval: 'Approval',
  payment: 'Payment',
  receipt: 'Receipt',
};

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function receiptRailLabel(rail: Rail): string {
  const labels: Record<Rail, string> = {
    mock: 'Mock',
    paypal: 'PayPal (mock)',
    near: 'NEAR (mock)',
  };
  return labels[rail];
}

function activeStepIndex(
  step: PipelineStep,
  decision: Decision | null,
  receipt: Receipt | null,
  humanDenied: boolean,
): number {
  if (receipt) return STEP_ORDER.indexOf('receipt');
  if (step === 'payment') return STEP_ORDER.indexOf('payment');
  if (humanDenied) return STEP_ORDER.indexOf('approval');
  if (decision?.status === 'needs_approval' && step === 'approval') {
    return STEP_ORDER.indexOf('approval');
  }
  if (decision) return STEP_ORDER.indexOf('decision');
  if (step === 'policy') return STEP_ORDER.indexOf('policy');
  if (step === 'quote') return STEP_ORDER.indexOf('quote');
  return STEP_ORDER.indexOf('task');
}

export default function App() {
  const client = useAgentPayClient();
  const [scenario, setScenario] = useState<DemoScenario | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [rail, setRail] = useState<Rail>('mock');
  const [step, setStep] = useState<PipelineStep>('task');
  const [error, setError] = useState<string | null>(null);
  const [, bumpLedgerView] = useReducer((n: number) => n + 1, 0);

  const spend = client.getSpend();
  const policy = client.getPolicy();
  const ledger = client.getLedger();
  const humanOutcome = intent
    ? client.getHumanOutcome(intent.id)
    : undefined;

  const refresh = useCallback(() => bumpLedgerView(), []);

  const clearPerRunUi = useCallback(() => {
    setIntent(null);
    setDecision(null);
    setReceipt(null);
    setStep('task');
    setError(null);
  }, []);

  const resetUi = useCallback(() => {
    client.reset();
    setScenario(null);
    clearPerRunUi();
    refresh();
  }, [client, clearPerRunUi, refresh]);

  const selectScenario = (s: DemoScenario) => {
    setScenario(s);
    clearPerRunUi();
  };

  const handleQuote = () => {
    if (!scenario) return;
    setError(null);
    const created = client.createIntent(scenario.task);
    setIntent(created);
    setDecision(null);
    setReceipt(null);
    setStep('quote');
    refresh();
  };

  const handlePolicy = () => {
    if (!intent) return;
    setError(null);
    const d = client.evaluate(intent.id);
    setDecision(d);
    if (d.status === 'needs_approval') {
      setStep('approval');
    } else if (d.status === 'approved') {
      setStep('payment');
    } else {
      setStep('decision');
    }
    refresh();
  };

  const handleApprove = () => {
    if (!intent) return;
    try {
      client.approve(intent.id);
      setError(null);
      setStep('payment');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approval failed');
    }
  };

  const handleDeny = () => {
    if (!intent) return;
    try {
      client.deny(intent.id);
      setError(null);
      setStep('approval');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deny failed');
    }
  };

  const handlePay = async () => {
    if (!intent) return;
    setError(null);
    try {
      const r = await client.pay(intent.id, rail);
      setReceipt(r);
      setStep('receipt');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed');
    }
  };

  const canPay =
    decision?.status === 'approved' ||
    (decision?.status === 'needs_approval' && humanOutcome === 'approved');

  const payBlocked =
    decision?.status === 'rejected' ||
    humanOutcome === 'denied' ||
    (decision?.status === 'needs_approval' && humanOutcome !== 'approved');

  const currentIdx = activeStepIndex(
    step,
    decision,
    receipt,
    humanOutcome === 'denied',
  );

  const railLabel = useMemo(() => {
    const labels: Record<Rail, string> = {
      mock: 'Mock',
      paypal: 'PayPal',
      near: 'NEAR',
    };
    return labels[rail];
  }, [rail]);

  const runAuto = async () => {
    const sc = scenario ?? DEMO_SCENARIOS[0];
    setError(null);
    setScenario(sc);
    clearPerRunUi();
    const created = client.createIntent(sc.task);
    setIntent(created);
    const d = client.evaluate(created.id);
    setDecision(d);
    if (d.status === 'needs_approval') {
      client.approve(created.id);
    }
    if (d.status !== 'rejected') {
      const r = await client.pay(created.id, rail);
      setReceipt(r);
      setStep('receipt');
    } else {
      setStep('decision');
    }
    refresh();
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header__brand">
          <span className="logo-mark" aria-hidden>
            AP
          </span>
          <div>
            <h1>agent-pay</h1>
            <p className="tagline">AI agents pay within spending policy</p>
          </div>
        </div>
        <span className="mock-badge" title="Demo mode">
          MOCK — no real funds
        </span>
      </header>

      <main className="layout">
        <section className="panel scenarios">
          <h2>Demo scenarios</h2>
          <p className="hint">Pick a task, then walk the payment pipeline.</p>
          <div className="scenario-grid">
            {DEMO_SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`scenario-card${scenario?.id === s.id ? ' is-selected' : ''}`}
                data-testid={s.testId}
                onClick={() => selectScenario(s)}
              >
                <strong>{s.label}</strong>
                <span>{s.task.payee}</span>
                <span className="amount">
                  {formatMoney(s.task.amount, policy.currency)}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="btn-reset"
            onClick={resetUi}
          >
            Reset demo
          </button>
        </section>

        <section className="panel flow">
          <h2>Payment pipeline</h2>
          <ol className="stepper" aria-label="Pipeline steps">
            {STEP_ORDER.map((s, i) => (
              <li
                key={s}
                className={`stepper__step${i <= currentIdx ? ' is-active' : ''}${i === currentIdx ? ' is-current' : ''}`}
              >
                <span className="stepper__dot">{i + 1}</span>
                <span>{STEP_LABELS[s]}</span>
              </li>
            ))}
          </ol>

          {scenario && (
            <div className="task-banner">
              <span className="label">Agent task</span>
              <p>{scenario.task.purpose}</p>
            </div>
          )}

          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="btn-quote"
              disabled={!scenario || !!intent}
              onClick={handleQuote}
            >
              Get quote
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="btn-policy"
              disabled={!intent || !!decision}
              onClick={handlePolicy}
            >
              Run policy check
            </button>
            {decision?.status === 'needs_approval' &&
              humanOutcome !== 'approved' &&
              humanOutcome !== 'denied' && (
                <>
                  <button
                    type="button"
                    className="btn btn-success"
                    data-testid="btn-approve"
                    onClick={handleApprove}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-testid="btn-deny"
                    onClick={handleDeny}
                  >
                    Deny
                  </button>
                </>
              )}
            <button
              type="button"
              className="btn btn-primary"
              data-testid="btn-pay"
              disabled={!intent || !canPay || !!receipt || payBlocked}
              onClick={() => void handlePay()}
            >
              Pay with {railLabel}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void runAuto()}>
              Auto-run
            </button>
          </div>

          {error && <p className="error">{error}</p>}

          {intent && (
            <div className="quote-card">
              <h3>PaymentIntent</h3>
              <dl>
                <div>
                  <dt>ID</dt>
                  <dd>{intent.id}</dd>
                </div>
                <div>
                  <dt>Payee</dt>
                  <dd>{intent.payee}</dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd>{formatMoney(intent.amount, intent.currency)}</dd>
                </div>
              </dl>
            </div>
          )}

          {decision && (
            <div
              className={`decision-card status-${decision.status}`}
              data-testid="decision"
            >
              <h3>Decision</h3>
              <p className="decision-status">{decision.status.replace('_', ' ')}</p>
              <p>{decision.reason}</p>
              {humanOutcome === 'denied' && (
                <p className="terminal">Human denied — flow stopped.</p>
              )}
            </div>
          )}

          <div className="rail-toggle" role="group" aria-label="Payment rail">
            {(['mock', 'paypal', 'near'] as const).map((r) => (
              <button
                key={r}
                type="button"
                className={`rail-btn${rail === r ? ' is-active' : ''}`}
                data-testid={`rail-${r}`}
                onClick={() => setRail(r)}
              >
                {r === 'mock' ? 'Mock' : r === 'paypal' ? 'PayPal' : 'NEAR'}
              </button>
            ))}
          </div>

          {receipt && (
            <article className="receipt-card" data-testid="receipt">
              <span className="mock-badge mock-badge--inline">MOCK — no real funds</span>
              <h3>Receipt</h3>
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{receipt.status}</dd>
                </div>
                <div>
                  <dt>Rail</dt>
                  <dd>{receiptRailLabel(receipt.rail)}</dd>
                </div>
                <div>
                  <dt>External ID</dt>
                  <dd className="mono">{receipt.externalId}</dd>
                </div>
                <div>
                  <dt>Settled at</dt>
                  <dd>{formatTime(receipt.at)}</dd>
                </div>
              </dl>
            </article>
          )}
        </section>

        <aside className="sidebar">
          <div className="panel gauge-panel" data-testid="gauge">
            <h2>Spending limit</h2>
            <p className="cap-note">
              Per-tx cap {formatMoney(spend.perTxCap, spend.currency)}
            </p>
            <div className="gauge">
              <div
                className="gauge__fill"
                style={{
                  width: `${Math.min(100, (spend.spentToday / spend.dailyLimit) * 100)}%`,
                }}
              />
            </div>
            <p className="gauge__labels">
              <span>
                Spent today {formatMoney(spend.spentToday, spend.currency)}
              </span>
              <span>
                Daily limit {formatMoney(spend.dailyLimit, spend.currency)}
              </span>
            </p>
          </div>

          <div className="panel ledger-panel" data-testid="ledger">
            <h2>Ledger</h2>
            {ledger.length === 0 ? (
              <p className="hint">Events appear as you progress.</p>
            ) : (
              <ul className="ledger-list">
                {[...ledger].reverse().map((ev) => (
                  <li key={ev.id}>
                    <span className="ledger-type">{ev.type}</span>
                    <span className="ledger-time">{formatTime(ev.at)}</span>
                    {ev.amount != null && (
                      <span className="ledger-amount">
                        {formatMoney(ev.amount, ev.currency ?? 'USD')}
                      </span>
                    )}
                    {ev.rail && <span className="ledger-rail">{ev.rail}</span>}
                    {ev.externalId && (
                      <span className="mono ledger-ext">{ev.externalId}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
