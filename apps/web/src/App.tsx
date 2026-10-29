import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReasonCode, reasonCode } from '@agent-pay/core/policy.ts';
import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import { apiErrorCode } from './data/apiError';
import type { IntentDraft } from './data/agentPayClient';
import { entriesToTimeline, humanOutcomeText } from './data/ledgerTimeline';
import { useAgentPayClient } from './data/useAgentPayClient';
import { describeError, type DescribedError } from './data/describeError';
import { derivePipelineSteps } from './data/intentFlow';
import { expectedRailFromSearch, railMismatchMessage } from './data/railQuery';
import { ApiStatusBanner } from './components/ApiStatusBanner';
import { ErrorBanner } from './components/ErrorBanner';
import { IntentFlows } from './components/IntentFlows';
import { PendingTimer } from './components/PendingTimer';
import { PipelineStepper } from './components/PipelineStepper';
import { RailMismatchBanner } from './components/RailMismatchBanner';
import { ActionButton, GaugeSkeleton, LedgerSkeleton } from './components/Skeleton';
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

type RetryAction = 'policy' | 'approve' | 'refresh';

export default function App() {
  const client = useAgentPayClient();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [ledgerSnap, setLedgerSnap] = useState<LedgerSnapshot | null>(null);
  const [scenario, setScenario] = useState<DemoScenario | null>(null);
  const [draft, setDraft] = useState<IntentDraft | null>(null);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [rail, setRail] = useState<Rail>(
    () => expectedRailFromSearch(window.location.search) ?? 'mock',
  );
  const [step, setStep] = useState<PipelineStep>('task');
  const [actionError, setActionError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverRail, setServerRail] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [refreshHidden, setRefreshHidden] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [apiConnected, setApiConnected] = useState(true);
  const stepperRef = useRef<HTMLOListElement>(null);
  const retryActionRef = useRef<RetryAction | null>(null);

  const apiBase = import.meta.env.VITE_API_BASE?.trim() ?? '';
  const expectedRail = useMemo(
    () => expectedRailFromSearch(window.location.search),
    [],
  );

  const refreshLedger = useCallback(async () => {
    const snap = await client.getLedger();
    setLedgerSnap(snap);
  }, [client]);

  const refreshPolicy = useCallback(async () => {
    setPolicy(await client.getPolicy());
  }, [client]);

  const loadConnectionData = useCallback(async () => {
    if (client.kind !== 'http') {
      setApiConnected(true);
      setInitialLoading(true);
      try {
        const [p, l] = await Promise.all([client.getPolicy(), client.getLedger()]);
        setPolicy(p);
        setLedgerSnap(l);
      } catch {
        /* mock should not fail */
      } finally {
        setInitialLoading(false);
      }
      return;
    }

    setInitialLoading(true);
    try {
      const healthP = client.getHealth?.();
      const [p, l, health] = await Promise.all([
        client.getPolicy(),
        client.getLedger(),
        healthP ?? Promise.resolve({ ok: true, rail: 'mock' }),
      ]);
      setPolicy(p);
      setLedgerSnap(l);
      setServerRail(health.rail);
      setApiConnected(true);
      setActionError(null);
    } catch {
      setApiConnected(false);
      setPolicy(null);
      setLedgerSnap(null);
      setServerRail(null);
    } finally {
      setInitialLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadConnectionData();
  }, [loadConnectionData]);

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

  const pipelineSteps = useMemo(() => derivePipelineSteps(step, result), [step, result]);

  const currentIdx = pipelineSteps.findIndex((s) => s.state === 'current');
  const currentStepView = pipelineSteps[currentIdx >= 0 ? currentIdx : 0]!;
  const mobileExtra =
    currentStepView.state === 'skipped'
      ? ' (skipped)'
      : currentStepView.state === 'error'
        ? ' (rejected/failed)'
        : currentStepView.state === 'pending'
          ? ' (pending)'
          : '';
  const mobileLabel = `Step ${(currentIdx >= 0 ? currentIdx : 0) + 1} of ${pipelineSteps.length} · ${currentStepView.label}${mobileExtra}`;

  useEffect(() => {
    const el = stepperRef.current?.querySelector('.stepper__step.is-current');
    if (el && 'scrollIntoView' in el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [currentStepView.step]);

  const clearRun = useCallback(() => {
    setDraft(null);
    setIntent(null);
    setResult(null);
    setStep('task');
    setActionError(null);
    setRefreshNote(null);
    setRefreshHidden(false);
  }, []);

  const selectScenario = (s: DemoScenario) => {
    setScenario(s);
    clearRun();
  };

  const handleQuote = async () => {
    if (!scenario || !policy) return;
    setActionError(null);
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
    setActionError(null);
    setRefreshNote(null);
    setRefreshHidden(false);
    retryActionRef.current = 'policy';
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
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!intent) return;
    setBusy(true);
    setActionError(null);
    setRefreshNote(null);
    setRefreshHidden(false);
    retryActionRef.current = 'approve';
    try {
      const out = await client.approve(intent.id, DEFAULT_APPROVER);
      setResult(out);
      setStep(out.receipt ? 'receipt' : 'decision');
      await refreshLedger();
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeny = async () => {
    if (!intent) return;
    setBusy(true);
    setActionError(null);
    try {
      const out = await client.reject(intent.id, { approver: DEFAULT_APPROVER });
      setResult(out);
      setStep('decision');
      await refreshLedger();
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!client.reset) return;
    setBusy(true);
    setActionError(null);
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
    setActionError(null);
    setRefreshNote(null);
    retryActionRef.current = 'refresh';
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
        setActionError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRetryAction = () => {
    const kind = retryActionRef.current;
    if (kind === 'policy') void handlePolicyPay();
    else if (kind === 'approve') void handleApprove();
    else if (kind === 'refresh') void handleRefreshStatus();
  };

  const decision = result?.decision ?? null;
  const humanOutcome =
    decision && humanOutcomeText(decision.reason, DEFAULT_APPROVER);
  const reasonParts = decision ? splitReason(decision.reason) : null;
  const canReset = client.kind === 'mock' && client.reset !== undefined;

  const headerBadge =
    client.kind === 'http'
      ? `API: ${apiBase}`
      : 'MOCK — no real funds';

  const quoteIntent = draft
    ? {
        ...draft,
        id: draft.id ?? '—',
        createdAt: draft.createdAt ?? '—',
      }
    : null;

  const pipelineDisabled = !apiConnected || busy;
  const railMismatch =
    client.kind === 'http' &&
    expectedRail &&
    serverRail !== null &&
    serverRail !== expectedRail;
  const railMismatchMsg =
    railMismatch && expectedRail
      ? railMismatchMessage(apiBase, serverRail!, expectedRail)
      : null;

  const receiptRailMismatch =
    client.kind === 'http' &&
    serverRail &&
    result?.receipt &&
    result.receipt.rail !== serverRail;

  const showRailBanner =
    railMismatchMsg ||
    (receiptRailMismatch
      ? railMismatchMessage(apiBase, serverRail!, result!.receipt!.rail as Rail)
      : null);

  const payBlocked = pipelineDisabled || !!showRailBanner;

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
                aria-pressed={scenario?.id === s.id}
                disabled={busy || !apiConnected}
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
            <ActionButton
              className="btn-ghost"
              data-testid="btn-reset"
              disabled={busy}
              busy={busy}
              onClick={() => void handleReset()}
            >
              Reset demo
            </ActionButton>
          )}
        </section>

        <section className="panel flow">
          <h2>Payment pipeline</h2>

          {client.kind === 'http' && !apiConnected && (
            <ApiStatusBanner
              baseUrl={apiBase}
              busy={busy}
              onRetry={() => void loadConnectionData()}
            />
          )}

          {showRailBanner && (
            <RailMismatchBanner
              message={showRailBanner}
              busy={busy}
              onRecheck={() => void loadConnectionData()}
            />
          )}

          <PipelineStepper steps={pipelineSteps} stepperRef={stepperRef} mobileLabel={mobileLabel} />

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
                  aria-pressed={isActive}
                  disabled={payBlocked || !!result || isHttp}
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
            <ActionButton
              className="btn-primary"
              data-testid="btn-quote"
              disabled={!scenario || !!draft || payBlocked}
              busy={busy}
              onClick={() => void handleQuote()}
            >
              Get quote
            </ActionButton>
            <ActionButton
              className="btn-primary"
              data-testid="btn-policy"
              disabled={!draft || !!result || payBlocked}
              busy={busy}
              onClick={() => void handlePolicyPay()}
            >
              Run policy check &amp; pay
            </ActionButton>
            {result?.status === 'needs_approval' &&
              reasonCode(result.decision) !== ReasonCode.ApprovedByHuman &&
              reasonCode(result.decision) !== ReasonCode.RejectedByHuman && (
                <>
                  <ActionButton
                    className="btn-success"
                    data-testid="btn-approve"
                    disabled={payBlocked}
                    busy={busy}
                    onClick={() => void handleApprove()}
                  >
                    Approve
                  </ActionButton>
                  <ActionButton
                    className="btn-danger"
                    data-testid="btn-deny"
                    disabled={payBlocked}
                    busy={busy}
                    onClick={() => void handleDeny()}
                  >
                    Deny
                  </ActionButton>
                </>
              )}
          </div>

          {actionError && (
            <ErrorBanner
              error={actionError}
              onRetry={actionError.retryable ? handleRetryAction : undefined}
              onDismiss={() => setActionError(null)}
            />
          )}

          {quoteIntent && (
            <div className="quote-card">
              <h3>PaymentIntent (draft)</h3>
              <dl>
                <div>
                  <dt>ID</dt>
                  <dd className="mono wrap-anywhere">{quoteIntent.id}</dd>
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
                  aria-live="polite"
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
                  <dd className="mono wrap-anywhere">{result.receipt.externalId}</dd>
                </div>
                <div>
                  <dt>At</dt>
                  <dd>{formatTime(result.receipt.at)}</dd>
                </div>
              </dl>
              {result.receipt.status === 'pending' && (
                <PendingTimer sinceIso={result.receipt.at} />
              )}
              {result.receipt.status === 'pending' && !refreshHidden && (
                <ActionButton
                  className="btn-ghost btn-refresh"
                  data-testid="btn-refresh"
                  disabled={payBlocked}
                  busy={busy}
                  onClick={() => void handleRefreshStatus()}
                >
                  Refresh status
                </ActionButton>
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
            {initialLoading ? (
              <GaugeSkeleton testId="gauge-loading" label="gauge" />
            ) : !apiConnected ? (
              <p className="hint unavailable">Spending data unavailable — API not connected.</p>
            ) : (
              <>
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
              </>
            )}
          </div>

          <div className="panel ledger-panel" data-testid="ledger">
            <h2>Ledger</h2>
            {initialLoading ? (
              <LedgerSkeleton testId="ledger-loading" label="ledger" />
            ) : !apiConnected ? (
              <p className="hint unavailable">Ledger unavailable — API not connected.</p>
            ) : timeline.length === 0 ? (
              <>
                <p className="hint">Events appear as you progress.</p>
                <p className="hint">Choose a demo scenario to start the pipeline.</p>
              </>
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
                    {ev.detail && (
                      <span className="ledger-detail wrap-anywhere">{ev.detail}</span>
                    )}
                    {ev.actor && (
                      <span className="ledger-actor" data-testid="ledger-actor">
                        by {ev.actor}
                      </span>
                    )}
                    {ev.kind === 'resolution' && ev.previousExternalId !== undefined && (
                      <span className="ledger-resolution wrap-anywhere" data-testid="ledger-resolution">
                        {ev.actor} · {ev.detail} · {formatTime(ev.at)} · previous:{' '}
                        {ev.previousExternalId}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!initialLoading && apiConnected && (
            <IntentFlows entries={ledgerSnap?.entries ?? []} />
          )}
        </aside>
      </main>
    </div>
  );
}
