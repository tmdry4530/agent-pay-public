import { ReasonCode, reasonCode } from '@agent-pay/core/policy.ts';
import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiErrorCode } from './data/apiError';
import type { IntentDraft } from './data/agentPayClient';
import { entriesToTimeline, humanOutcomeText } from './data/ledgerTimeline';
import { useAgentPayClient } from './data/useAgentPayClient';
import {
  DEMO_SCENARIOS,
  type DemoScenario,
  type LedgerSnapshot,
  type PaymentIntent,
  type PipelineStep,
  type Policy,
  type Rail,
  type PaymentResult,
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

const DEFAULT_APPROVER = 'demo-operator';

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

function splitReason(reason: string): { code: string; detail: string } {
  const i = reason.indexOf(':');
  if (i === -1) return { code: reason, detail: '' };
  return { code: reason.slice(0, i), detail: reason.slice(i + 1).trim() };
}

function paymentErrorCode(err: unknown): string | undefined {
  if (err instanceof PaymentError) return err.code;
  return apiErrorCode(err);
}

function activeStepIndex(
  step: PipelineStep,
  result: PaymentResult | null,
): number {
  if (result?.receipt) return STEP_ORDER.indexOf('receipt');
  if (result?.status === 'paid' || result?.status === 'failed') {
    return STEP_ORDER.indexOf('payment');
  }
  if (result?.status === 'needs_approval' && step === 'approval') {
    return STEP_ORDER.indexOf('approval');
  }
  if (result) return STEP_ORDER.indexOf('decision');
  if (step === 'policy') return STEP_ORDER.indexOf('policy');
  if (step === 'quote') return STEP_ORDER.indexOf('quote');
  return STEP_ORDER.indexOf('task');
}

export default function App() {
  const client = useAgentPayClient();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [ledgerSnap, setLedgerSnap] = useState<LedgerSnapshot | null>(null);
  const [scenario, setScenario] = useState<DemoScenario | null>(null);
  const [draft, setDraft] = useState<IntentDraft | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [rail, setRail] = useState<Rail>('mock');
  const [step, setStep] = useState<PipelineStep>('task');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverRail, setServerRail] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [refreshHidden, setRefreshHidden] = useState(false);
  const stepperRef = useRef<HTMLOListElement>(null);

  const refreshLedger = useCallback(async () => {
    const snap = await client.getLedger();
    setLedgerSnap(snap);
  }, [client]);

  const refreshPolicy = useCallback(async () => {
    setPolicy(await client.getPolicy());
  }, [client]);

  useEffect(() => {
    void refreshPolicy();
    void refreshLedger();
  }, [refreshPolicy, refreshLedger]);

  useEffect(() => {
    if (client.kind !== 'http' || client.getHealth === undefined) return;
    const getHealth = client.getHealth;
    void (async () => {
      try {
        const health = await getHealth();
        setServerRail(health.rail);
      } catch (e) {
        setError(
          e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Health check failed',
        );
      }
    })();
  }, [client]);

  const currency = policy?.currency ?? 'USD';
  const agentId = policy?.agentId ?? 'demo-agent';
  const spentToday = ledgerSnap?.today.totals[agentId] ?? 0;
  const dailyMax = policy?.dailyMax ?? 0;
  const perTxMax = policy?.perTxMax ?? 0;
  const requireApprovalAbove = policy?.requireApprovalAbove ?? 0;

  const timeline = useMemo(
    () => entriesToTimeline(ledgerSnap?.entries ?? []),
    [ledgerSnap],
  );

  const currentIdx = activeStepIndex(step, result);

  useEffect(() => {
    const el = stepperRef.current?.querySelector('.stepper__step.is-current');
    if (el && 'scrollIntoView' in el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [currentIdx]);

  const clearRun = useCallback(() => {
    setDraft(null);
    setIntent(null);
    setResult(null);
    setStep('task');
    setError(null);
    setRefreshNote(null);
    setRefreshHidden(false);
  }, []);

  const selectScenario = (s: DemoScenario) => {
    setScenario(s);
    clearRun();
  };

  const handleQuote = async () => {
    if (!scenario || !policy) return;
    setError(null);
    const nextDraft: IntentDraft = {
      agentId: policy.agentId,
      payee: scenario.task.payee,
      amount: scenario.task.amount,
      currency: policy.currency ?? 'USD',
      purpose: scenario.task.purpose,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    setDraft(nextDraft);
    setIntent(null);
    setResult(null);
    setStep('quote');
  };

  const handlePolicyPay = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setRefreshNote(null);
    setRefreshHidden(false);
    try {
      const out = await client.submitIntent(draft, rail);
      setIntent(out.intent);
      setResult(out);
      setStep('decision');
      if (out.status === 'needs_approval') {
        setStep('approval');
      } else if (out.receipt) {
        setStep('receipt');
      }
      await refreshLedger();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!intent) return;
    setBusy(true);
    setError(null);
    setRefreshNote(null);
    setRefreshHidden(false);
    try {
      const out = await client.approve(intent.id, DEFAULT_APPROVER);
      setResult(out);
      setStep(out.receipt ? 'receipt' : 'decision');
      await refreshLedger();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setBusy(false);
    }
  };

  const handleDeny = async () => {
    if (!intent) return;
    setBusy(true);
    setError(null);
    try {
      const out = await client.reject(intent.id, { approver: DEFAULT_APPROVER });
      setResult(out);
      setStep('decision');
      await refreshLedger();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!client.reset) return;
    setBusy(true);
    setError(null);
    try {
      await client.reset();
      setScenario(null);
      clearRun();
      await refreshLedger();
      await refreshPolicy();
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshStatus = async () => {
    if (!intent) return;
    setBusy(true);
    setError(null);
    setRefreshNote(null);
    try {
      const out = await client.refresh(intent.id);
      setResult(out);
      await refreshLedger();
      if (!out.changed) {
        setRefreshNote(`Still pending (checked at ${formatTime(new Date().toISOString())})`);
      }
    } catch (e) {
      const code = paymentErrorCode(e);
      if (code === 'status_unsupported') {
        setRefreshHidden(true);
        setRefreshNote('Status check not supported on this rail');
      } else if (code === 'receipt_not_pending') {
        await refreshLedger();
        setRefreshHidden(true);
        setRefreshNote(null);
      } else {
        setError(
          e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Refresh failed',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const decision = result?.decision ?? null;
  const humanOutcome =
    decision && humanOutcomeText(decision.reason, DEFAULT_APPROVER);
  const reasonParts = decision ? splitReason(decision.reason) : null;
  const canReset = client.kind === 'mock' && client.reset !== undefined;

  const headerBadge =
    client.kind === 'http'
      ? `API: ${import.meta.env.VITE_API_BASE?.trim() ?? ''}`
      : 'MOCK — no real funds';

  const quoteIntent = draft
    ? {
        ...draft,
        id: draft.id ?? '—',
        createdAt: draft.createdAt ?? '—',
      }
    : null;

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
        <span className="mock-badge" title={headerBadge}>
          {headerBadge}
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
                disabled={busy}
                onClick={() => selectScenario(s)}
              >
                <strong>{s.label}</strong>
                <span>{s.task.payee}</span>
                <span className="amount">
                  {formatMoney(s.task.amount, currency)}
                </span>
              </button>
            ))}
          </div>
          {canReset && (
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="btn-reset"
              disabled={busy}
              onClick={() => void handleReset()}
            >
              Reset demo
            </button>
          )}
        </section>

        <section className="panel flow">
          <h2>Payment pipeline</h2>
          <p className="stepper-mobile-label" aria-live="polite">
            Step {currentIdx + 1} of {STEP_ORDER.length} · {STEP_LABELS[STEP_ORDER[currentIdx]!]}
          </p>
          <ol className="stepper" aria-label="Pipeline steps" ref={stepperRef}>
            {STEP_ORDER.map((s, i) => (
              <li
                key={s}
                className={`stepper__step${i <= currentIdx ? ' is-active' : ''}${i === currentIdx ? ' is-current' : ''}`}
              >
                <span className="stepper__dot">{i + 1}</span>
                <span className="stepper__label">{STEP_LABELS[s]}</span>
              </li>
            ))}
          </ol>

          {scenario && (
            <div className="task-banner">
              <span className="label">Agent task</span>
              <p>{scenario.task.purpose}</p>
            </div>
          )}

          <div className="rail-toggle" role="group" aria-label="Payment rail">
            {(['mock', 'paypal', 'near'] as const).map((r) => {
              const isHttp = client.kind === 'http';
              const isActive = isHttp ? serverRail === r : rail === r;
              return (
                <button
                  key={r}
                  type="button"
                  className={`rail-btn${isActive ? ' is-active' : ''}`}
                  data-testid={`rail-${r}`}
                  disabled={busy || !!result || isHttp}
                  onClick={() => setRail(r)}
                >
                  {r === 'mock' ? 'Mock' : r === 'paypal' ? 'PayPal' : 'NEAR'}
                </button>
              );
            })}
          </div>
          {client.kind === 'http' && serverRail !== null && (
            <p className="hint rail-note">
              Rail is selected by the API server: {serverRail}
            </p>
          )}

          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="btn-quote"
              disabled={!scenario || !!draft || busy}
              onClick={() => void handleQuote()}
            >
              Get quote
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="btn-policy"
              disabled={!draft || !!result || busy}
              onClick={() => void handlePolicyPay()}
            >
              Run policy check &amp; pay
            </button>
            {result?.status === 'needs_approval' &&
              reasonCode(result.decision) !== ReasonCode.ApprovedByHuman &&
              reasonCode(result.decision) !== ReasonCode.RejectedByHuman && (
                <>
                  <button
                    type="button"
                    className="btn btn-success"
                    data-testid="btn-approve"
                    disabled={busy}
                    onClick={() => void handleApprove()}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-testid="btn-deny"
                    disabled={busy}
                    onClick={() => void handleDeny()}
                  >
                    Deny
                  </button>
                </>
              )}
          </div>

          {error && <p className="error">{error}</p>}

          {quoteIntent && (
            <div className="quote-card">
              <h3>PaymentIntent (draft)</h3>
              <dl>
                <div>
                  <dt>ID</dt>
                  <dd className="mono">{quoteIntent.id}</dd>
                </div>
                <div>
                  <dt>Payee</dt>
                  <dd>{quoteIntent.payee}</dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd>{formatMoney(quoteIntent.amount, quoteIntent.currency)}</dd>
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
              {result && (
                <span
                  className={`result-badge status-${result.status}`}
                  data-testid="result-status"
                >
                  {result.status.replace('_', ' ')}
                </span>
              )}
              <p className="decision-status">{decision.status.replace('_', ' ')}</p>
              {reasonParts && (
                <>
                  <p className="reason-code">{reasonParts.code}</p>
                  {reasonParts.detail && <p>{reasonParts.detail}</p>}
                </>
              )}
              {humanOutcome && (
                <p className="human-outcome" data-testid="human-outcome">
                  {humanOutcome}
                </p>
              )}
            </div>
          )}

          {result?.receipt && (
            <article className="receipt-card" data-testid="receipt">
              {client.kind === 'mock' && (
                <span className="mock-badge mock-badge--inline">MOCK — no real funds</span>
              )}
              <h3>Receipt</h3>
              {result.receipt.status === 'pending' && (
                <p className="receipt-pending-notice" role="status">
                  PENDING — awaiting rail confirmation
                </p>
              )}
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd
                    className={`receipt-status receipt-status--${result.receipt.status}`}
                    data-testid="receipt-status"
                  >
                    {result.receipt.status}
                  </dd>
                </div>
                <div>
                  <dt>Rail</dt>
                  <dd>{receiptRailLabel(result.receipt.rail)}</dd>
                </div>
                <div>
                  <dt>External ID</dt>
                  <dd className="mono">{result.receipt.externalId}</dd>
                </div>
                <div>
                  <dt>At</dt>
                  <dd>{formatTime(result.receipt.at)}</dd>
                </div>
              </dl>
              {result.receipt.status === 'pending' && !refreshHidden && (
                <button
                  type="button"
                  className="btn btn-ghost btn-refresh"
                  data-testid="btn-refresh"
                  disabled={busy}
                  onClick={() => void handleRefreshStatus()}
                >
                  Refresh status
                </button>
              )}
              {refreshNote && (
                <p className="refresh-note" data-testid="refresh-note">
                  {refreshNote}
                </p>
              )}
            </article>
          )}
        </section>

        <aside className="sidebar">
          <div className="panel gauge-panel" data-testid="gauge">
            <h2>Spending limit</h2>
            <p className="cap-note">
              Per-tx max {formatMoney(perTxMax, currency)} · approval above{' '}
              {formatMoney(requireApprovalAbove, currency)}
            </p>
            <div className="gauge">
              <div
                className="gauge__fill"
                style={{
                  width: `${dailyMax > 0 ? Math.min(100, (spentToday / dailyMax) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="gauge__labels">
              <span>Spent today {formatMoney(spentToday, currency)}</span>
              <span>Daily max {formatMoney(dailyMax, currency)}</span>
            </p>
          </div>

          <div className="panel ledger-panel" data-testid="ledger">
            <h2>Ledger</h2>
            {timeline.length === 0 ? (
              <p className="hint">Events appear as you progress.</p>
            ) : (
              <ul className="ledger-list">
                {timeline.map((ev) => (
                  <li
                    key={ev.id}
                    data-testid="ledger-event"
                    data-kind={ev.kind ?? 'intent'}
                  >
                    <span className="ledger-type">{ev.label}</span>
                    <span className="ledger-time">{formatTime(ev.at)}</span>
                    {ev.detail && <span className="ledger-detail">{ev.detail}</span>}
                    {ev.actor && (
                      <span className="ledger-actor" data-testid="ledger-actor">
                        by {ev.actor}
                      </span>
                    )}
                    {ev.kind === 'resolution' && ev.previousExternalId !== undefined && (
                      <span className="ledger-resolution" data-testid="ledger-resolution">
                        {ev.actor} · {ev.detail} · {formatTime(ev.at)} · previous:{' '}
                        {ev.previousExternalId}
                      </span>
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
