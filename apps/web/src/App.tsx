import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReasonCode, reasonCode } from '@agent-pay/core/policy.ts';
import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import { ApiError, apiErrorCode } from './data/apiError';
import {
  dailyTotalForAgent,
  displayRunStatus,
  failureInfo,
  isAlreadyProcessed,
  isStuckSubmitting,
  isSubmitting,
  manualResolveBannerText,
  needsManualResolve,
  needsResolve,
  normalizeTotals,
  reasonInfo,
  showReasonLabelForDecision,
  STUCK_LABEL,
  type ResolveRequest,
} from './data/compat';
import type { IntentDraft } from './data/agentPayClient';
import { entriesToTimeline, humanOutcomeText } from './data/ledgerTimeline';
import { useAgentPayClient } from './data/useAgentPayClient';
import { describeError, type DescribedError, type DescribeErrorContext } from './data/describeError';
import { derivePipelineSteps } from './data/intentFlow';
import { serverNow } from './data/serverClock';
import { paymentResultFromLedgerEntry } from './data/ledgerResult';
import { detectRailMismatch, expectedRailFromSearch, railMismatchMessage } from './data/railQuery';
import { ApiStatusBanner } from './components/ApiStatusBanner';
import { ErrorBanner } from './components/ErrorBanner';
import { ResolveForm } from './components/ResolveForm';
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
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
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

function stepFromResult(out: PaymentResult): PipelineStep {
  if (out.status === 'needs_approval') return 'approval';
  if (out.receipt) return 'receipt';
  return 'decision';
}

function paymentErrorCode(err: unknown): string | undefined {
  if (err instanceof PaymentError) return err.code;
  return apiErrorCode(err);
}

type RetryAction = 'policy' | 'approve' | 'refresh';

export type AppProps = {
  clock?: () => Date;
};

const systemClock = (): Date => new Date();

export default function App({ clock = systemClock }: AppProps) {
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
  const [payInFlight, setPayInFlight] = useState(false);
  const [serverRail, setServerRail] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [refreshHidden, setRefreshHidden] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [apiConnected, setApiConnected] = useState(true);
  const stepperRef = useRef<HTMLOListElement>(null);
  const retryActionRef = useRef<RetryAction | null>(null);
  const resolveHeadingRef = useRef<HTMLHeadingElement>(null);
  const [now, setNow] = useState(() => clock());
  const [resolveTargetId, setResolveTargetId] = useState<string | null>(null);
  const [resolveSuccess, setResolveSuccess] = useState<string | null>(null);

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
  const spentToday = dailyTotalForAgent(ledgerSnap?.today, {
    agentId,
    fallbackCurrency: currency,
    currency,
  });
  const totalsByCurrency = useMemo(() => {
    const map = normalizeTotals(ledgerSnap?.today, { agentId, fallbackCurrency: currency });
    const rows = Object.entries(map).filter(([, amount]) => amount !== 0);
    rows.sort(([a], [b]) => {
      const aKey = a.toUpperCase();
      const bKey = b.toUpperCase();
      const policyCur = currency.toUpperCase();
      if (aKey === policyCur && bKey !== policyCur) return -1;
      if (bKey === policyCur && aKey !== policyCur) return 1;
      return aKey.localeCompare(bKey);
    });
    return rows;
  }, [ledgerSnap?.today, agentId, currency]);
  const showTotalsByCurrency = totalsByCurrency.length > 1;
  const dailyMax = policy?.dailyMax ?? 0;
  const perTxMax = policy?.perTxMax ?? 0;
  const requireApprovalAbove = policy?.requireApprovalAbove ?? 0;

  const serverNowDate = useMemo(
    () => serverNow(now, client.serverClockOffsetMs?.() ?? 0),
    [now, ledgerSnap, client],
  );

  const timeline = useMemo(
    () => entriesToTimeline(ledgerSnap?.entries ?? [], serverNowDate),
    [ledgerSnap, serverNowDate],
  );

  const activeIntentId = intent?.id ?? draft?.id;
  const currentLedgerEntry = useMemo(
    () =>
      activeIntentId
        ? ledgerSnap?.entries.find((e) => e.intent.id === activeIntentId)
        : undefined,
    [ledgerSnap?.entries, activeIntentId],
  );

  const resolveIntentId = resolveTargetId ?? activeIntentId ?? null;
  const resolveEntry = useMemo(
    () =>
      resolveIntentId
        ? ledgerSnap?.entries.find((e) => e.intent.id === resolveIntentId)
        : undefined,
    [ledgerSnap?.entries, resolveIntentId],
  );
  const showResolveForm = Boolean(resolveEntry && needsResolve(resolveEntry, serverNowDate));
  const resolveStuck = Boolean(resolveEntry && isStuckSubmitting(resolveEntry, serverNowDate));

  const ledgerHasSubmitting = useMemo(
    () => (ledgerSnap?.entries ?? []).some((e) => e.paymentStatus === 'submitting'),
    [ledgerSnap?.entries],
  );

  useEffect(() => {
    setNow(clock());
  }, [clock]);

  useEffect(() => {
    if (!ledgerHasSubmitting) return;
    const timer = window.setInterval(() => {
      setNow(clock());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ledgerHasSubmitting, clock]);

  // Move focus to the form only when the operator explicitly opens it (never on auto-appear).
  const [resolveFocusTick, setResolveFocusTick] = useState(0);
  useEffect(() => {
    if (resolveFocusTick > 0) resolveHeadingRef.current?.focus();
  }, [resolveFocusTick]);

  const pipelineSteps = useMemo(
    () =>
      derivePipelineSteps(step, result, {
        payInFlight,
        ledgerSubmitting: currentLedgerEntry ? isSubmitting(currentLedgerEntry) : false,
      }),
    [step, result, payInFlight, currentLedgerEntry],
  );

  const currentIdx = pipelineSteps.findIndex((s) => s.state === 'current' || s.ariaCurrent);
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
    const el = stepperRef.current?.querySelector('.stepper__step.is-current, .stepper__step.is-pending[aria-current="step"]');
    if (el && 'scrollIntoView' in el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [currentStepView.step, payInFlight]);

  useEffect(() => {
    if (!payInFlight) return;
    const timer = window.setInterval(() => {
      void refreshLedger();
    }, 400);
    return () => window.clearInterval(timer);
  }, [payInFlight, refreshLedger]);

  const syncIntentFromLedger = useCallback(
    async (intentId: string) => {
      const snap = await client.getLedger();
      setLedgerSnap(snap);
      const entry = snap.entries.find((e) => e.intent.id === intentId);
      if (!entry) return;
      setIntent(entry.intent);
      const out = paymentResultFromLedgerEntry(entry);
      setResult(out);
      setStep(stepFromResult(out));
    },
    [client],
  );

  const applyActionError = useCallback(
    async (e: unknown, context: DescribeErrorContext = {}, syncIntentId?: string) => {
      const described = describeError(e, context);
      setActionError(described);
      if (described.kind === 'conflict') {
        await refreshLedger();
        if (syncIntentId) {
          await syncIntentFromLedger(syncIntentId);
        }
      } else if (isAlreadyProcessed(e, context) && syncIntentId) {
        await syncIntentFromLedger(syncIntentId);
      }
    },
    [refreshLedger, syncIntentFromLedger],
  );

  const clearRun = useCallback(() => {
    setDraft(null);
    setIntent(null);
    setResult(null);
    setStep('task');
    setActionError(null);
    setRefreshNote(null);
    setRefreshHidden(false);
    setResolveTargetId(null);
    setResolveSuccess(null);
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
    setPayInFlight(true);
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
      await applyActionError(e);
    } finally {
      setPayInFlight(false);
      setBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!intent) return;
    setBusy(true);
    setPayInFlight(true);
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
      await applyActionError(e, { action: 'approve' }, intent.id);
    } finally {
      setPayInFlight(false);
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
      await applyActionError(e, { action: 'reject' }, intent.id);
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
        await applyActionError(e);
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

  const handleOpenResolve = useCallback(
    (intentId: string) => {
      setResolveTargetId(intentId);
      setResolveSuccess(null);
      setResolveFocusTick((t) => t + 1);
      const entry = ledgerSnap?.entries.find((e) => e.intent.id === intentId);
      if (entry) {
        setIntent(entry.intent);
        const out = paymentResultFromLedgerEntry(entry);
        setResult(out);
        setStep(stepFromResult(out));
      }
    },
    [ledgerSnap?.entries],
  );

  const handleResolveSubmit = useCallback(
    async (req: ResolveRequest) => {
      if (!resolveEntry) return;
      const targetId = resolveEntry.intent.id;
      try {
        const out = await client.resolve(targetId, req);
        if (targetId === activeIntentId) {
          setResult(out);
          setStep(out.receipt ? 'receipt' : 'decision');
          setPayInFlight(false);
        }
        await refreshLedger();
        setResolveTargetId(null);
        setResolveSuccess(`Resolved as ${req.status} by ${req.resolvedBy}.`);
      } catch (e) {
        // Any 409 (race, receipt_not_pending, or an unknown conflict) means our view is stale: reload the ledger.
        const code = paymentErrorCode(e);
        if (code === 'receipt_not_pending' || (e instanceof ApiError && e.status === 409)) {
          await refreshLedger();
          if (code === 'receipt_not_pending' && targetId === activeIntentId) {
            await syncIntentFromLedger(targetId);
          }
        }
        throw e;
      }
    },
    [resolveEntry, client, activeIntentId, refreshLedger, syncIntentFromLedger],
  );

  const decision = result?.decision ?? null;
  const humanOutcome =
    decision && humanOutcomeText(decision.reason, DEFAULT_APPROVER);
  const reasonParts = decision ? splitReason(decision.reason) : null;
  const reasonMeta = decision ? reasonInfo(decision.reason) : null;
  const manualResolvePending =
    result?.receipt?.status === 'pending' &&
    (needsManualResolve(result) ||
      (currentLedgerEntry !== undefined && needsManualResolve(currentLedgerEntry)));
  const paymentResolution = currentLedgerEntry?.resolution;
  const paymentOutcomeText = (() => {
    if (!result) return null;
    if (paymentResolution) {
      if (paymentResolution.status === 'failed') {
        return `Payment failed — resolved by ${paymentResolution.resolvedBy}`;
      }
      if (paymentResolution.status === 'succeeded') {
        return `Payment succeeded — resolved by ${paymentResolution.resolvedBy}`;
      }
      return null;
    }
    if (result.status === 'rejected' || result.status === 'needs_approval') return null;
    if (result.status === 'failed') return 'Payment failed';
    if (result.status === 'paid' && !needsManualResolve(result)) return 'Payment succeeded';
    return null;
  })();
  const paymentOutcomeTone =
    paymentOutcomeText == null
      ? null
      : paymentOutcomeText.startsWith('Payment failed')
        ? 'failed'
        : paymentOutcomeText.startsWith('Payment succeeded')
          ? 'succeeded'
          : null;
  const showPaymentFailureDetail =
    result &&
    result.error &&
    (result.status === 'failed' || manualResolvePending) &&
    !paymentResolution;
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
  const railMismatch = detectRailMismatch({
    clientKind: client.kind,
    expected: expectedRail,
    serverRail,
    receiptRail: result?.receipt?.rail ?? null,
  });
  const showRailBanner = railMismatch
    ? railMismatchMessage(apiBase, railMismatch.server, railMismatch.expected)
    : null;

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
              <p className="decision-status">{decision.status.replace('_', ' ')}</p>
              {reasonParts && (
                <>
                  <p className="reason-code">{reasonParts.code}</p>
                  {reasonMeta && showReasonLabelForDecision(reasonMeta.code) && (
                    <p className="reason-label" data-testid="reason-label">
                      {reasonMeta.label}
                    </p>
                  )}
                  {reasonMeta?.explanation && (
                    <p className="reason-explanation hint" data-testid="reason-explanation">
                      {reasonMeta.explanation}
                    </p>
                  )}
                  {reasonParts.detail && <p>{reasonParts.detail}</p>}
                </>
              )}
              {humanOutcome && (
                <p className="human-outcome" data-testid="human-outcome">
                  {humanOutcome}
                </p>
              )}
              {result && (
                <div className="payment-outcome" data-testid="payment-outcome">
                  <p className="payment-outcome__label">
                    {result.status === 'rejected' || result.status === 'needs_approval' ? 'Status' : 'Payment outcome'}
                  </p>
                  <span
                    className={`result-badge status-${result.status}${manualResolvePending ? ' status-needs-check' : ''}`}
                    data-testid="result-status"
                    aria-live="polite"
                  >
                    {displayRunStatus(result, currentLedgerEntry) ?? result.status.replace('_', ' ')}
                  </span>
                  {paymentOutcomeText && (
                    <p
                      className={
                        paymentOutcomeTone
                          ? `payment-outcome__text payment-outcome__text--${paymentOutcomeTone}`
                          : 'payment-outcome__text'
                      }
                      data-testid="payment-outcome-text"
                    >
                      {paymentOutcomeText}
                    </p>
                  )}
                  {paymentResolution?.note && (
                    <p className="payment-outcome__note hint">{paymentResolution.note}</p>
                  )}
                  {showPaymentFailureDetail && (
                    <p className="failure-detail hint" data-testid="payment-failure-detail">
                      {failureInfo(result.error!).label}. {failureInfo(result.error!).explanation}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {result?.receipt && (
            <article className="receipt-card" data-testid="receipt">
              {client.kind === 'mock' && (
                <span className="mock-badge mock-badge--inline">MOCK — no real funds</span>
              )}
              <h3>Receipt</h3>
              {manualResolvePending && (
                <div className="manual-resolve status-banner status-banner--warn" data-testid="manual-resolve" role="status">
                  <p className="status-banner__title">Needs check (pending)</p>
                  <p className="hint">{manualResolveBannerText(result.error)}</p>
                </div>
              )}
              {result.receipt.status === 'pending' && !manualResolvePending && (
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
              {result.receipt.status === 'pending' && !manualResolvePending && (
                <PendingTimer sinceIso={result.receipt.at} />
              )}
              {result.receipt.status === 'pending' && !refreshHidden && !manualResolvePending && (
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
                <p className="refresh-note" data-testid="refresh-note" role="status" aria-live="polite">
                  {refreshNote}
                </p>
              )}
            </article>
          )}

          {resolveSuccess && (
            <p className="resolve-success status-banner" data-testid="resolve-success" role="status">
              {resolveSuccess}
            </p>
          )}

          {showResolveForm && resolveEntry && (
            <div className="resolve-section">
              {resolveStuck && (
                <div
                  className="status-banner status-banner--warn"
                  data-testid="stuck-submitting"
                  role="status"
                >
                  <p className="status-banner__title">{STUCK_LABEL}</p>
                  <p className="hint">
                    No result from the rail after 60 s. The payment may or may not have gone through.
                  </p>
                </div>
              )}
              <ResolveForm
                entry={resolveEntry}
                stuck={resolveStuck}
                headingRef={resolveHeadingRef}
                onResolve={handleResolveSubmit}
              />
            </div>
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
                {showTotalsByCurrency && (
                  <dl className="totals-by-currency" data-testid="totals-by-currency">
                    <dt>Today by currency</dt>
                    {totalsByCurrency.map(([cur, amount]) => (
                      <div key={cur}>
                        <dt>{cur}</dt>
                        <dd>{formatMoney(amount, cur)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {showTotalsByCurrency && (
                  <p className="hint totals-by-currency-note">
                    Daily limits apply to the policy currency only ({currency}).
                  </p>
                )}
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
                    className={ev.warn ? 'ledger-item--warn' : undefined}
                  >
                    <span className="ledger-type">{ev.label}</span>
                    <span className="ledger-time">{formatTime(ev.at)}</span>
                    {ev.detail && ev.kind !== 'resolution' && (
                      <span className="ledger-detail wrap-anywhere">{ev.detail}</span>
                    )}
                    {ev.kind === 'decision' &&
                      ev.detail &&
                      showReasonLabelForDecision(reasonInfo(ev.detail).code) && (
                        <span className="sr-only" data-testid="reason-label">
                          {reasonInfo(ev.detail).label}
                        </span>
                      )}
                    {ev.actor && (
                      <span className="ledger-actor" data-testid="ledger-actor">
                        by {ev.actor}
                        {ev.kind === 'resolution' && ev.detail ? ` · ${ev.detail}` : ''}
                      </span>
                    )}
                    {ev.kind === 'resolution' && ev.previousExternalId !== undefined && ev.previousExternalId !== '' && (
                      <span className="ledger-resolution wrap-anywhere" data-testid="ledger-resolution">
                        previous: {ev.previousExternalId}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!initialLoading && apiConnected && (
            <IntentFlows
              entries={ledgerSnap?.entries ?? []}
              now={serverNowDate}
              onOpenResolve={handleOpenResolve}
            />
          )}
        </aside>
      </main>
    </div>
  );
}
