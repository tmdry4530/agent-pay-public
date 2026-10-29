import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../App';
import { ClientProvider } from '../data/ClientContext';
import { ApiError } from '../data/apiError';
import type { AgentPayClient } from '../data/agentPayClient';
import { createInMemoryClient } from '../data/inMemoryClient';
import { PENDING_SLOW_MS } from '../data/intentFlow';
import type { LedgerSnapshot } from '../types';

function renderWith(client: AgentPayClient) {
  return render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
}

describe('App states', () => {
  it('shows API disconnected banner and recovers on retry', async () => {
    const user = userEvent.setup();
    let connected = false;
    const inner = createInMemoryClient();
    const client: AgentPayClient = {
      kind: 'http',
      getHealth: () =>
        connected
          ? Promise.resolve({ ok: true, rail: 'mock' })
          : Promise.reject(new ApiError(0, 'network_error: down')),
      getPolicy: () =>
        connected ? inner.getPolicy() : Promise.reject(new ApiError(0, 'network_error: down')),
      getLedger: () =>
        connected ? inner.getLedger() : Promise.reject(new ApiError(0, 'network_error: down')),
      submitIntent: (...args) => inner.submitIntent(...args),
      approve: (...args) => inner.approve(...args),
      reject: (...args) => inner.reject(...args),
      refresh: (...args) => inner.refresh(...args),
      resolve: (...args) => inner.resolve(...args),
    };

    renderWith(client);
    expect(await screen.findByTestId('api-status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    connected = true;
    await user.click(screen.getByTestId('btn-retry-connection'));
    await waitFor(() => {
      expect(screen.queryByTestId('api-status')).not.toBeInTheDocument();
    });
  });

  it('shows error banner with retry on 5xx then succeeds', async () => {
    const user = userEvent.setup();
    let fail = true;
    const inner = createInMemoryClient();
    const client: AgentPayClient = {
      ...inner,
      submitIntent: async (draft, rail) => {
        if (fail) {
          fail = false;
          throw new ApiError(500, 'internal: temporary');
        }
        return inner.submitIntent(draft, rail);
      },
    };

    renderWith(client);
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));

    expect(await screen.findByTestId('error-banner')).toHaveTextContent(/500/);
    await user.click(screen.getByTestId('btn-retry'));
    expect(await screen.findByTestId('receipt')).toBeInTheDocument();
  });

  it('shows 4xx code without retry by default', async () => {
    const user = userEvent.setup();
    const inner = createInMemoryClient();
    const client: AgentPayClient = {
      ...inner,
      submitIntent: () => Promise.reject(new ApiError(400, 'payee_not_allowed: nope')),
    };

    renderWith(client);
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));

    const banner = await screen.findByTestId('error-banner');
    expect(banner).toHaveTextContent(/payee_not_allowed/);
    expect(screen.queryByTestId('btn-retry')).not.toBeInTheDocument();
  });

  it('blocks pay when rail query mismatches server rail', async () => {
    const inner = createInMemoryClient();
    const client: AgentPayClient = {
      kind: 'http',
      getHealth: () => Promise.resolve({ ok: true, rail: 'mock' }),
      getPolicy: () => inner.getPolicy(),
      getLedger: () => inner.getLedger(),
      submitIntent: (...a) => inner.submitIntent(...a),
      approve: (...a) => inner.approve(...a),
      reject: (...a) => inner.reject(...a),
      refresh: (...a) => inner.refresh(...a),
      resolve: (...a) => inner.resolve(...a),
    };

    const prev = window.location.href;
    window.history.replaceState({}, '', '/?rail=near');
    renderWith(client);
    expect(await screen.findByTestId('rail-mismatch')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    expect(screen.getByTestId('btn-policy')).toBeDisabled();
    window.history.replaceState({}, '', prev);
  });

  it('follows the server rail without ?rail and never reports a mismatch', async () => {
    const inner = createInMemoryClient();
    const client: AgentPayClient = {
      kind: 'http',
      getHealth: () => Promise.resolve({ ok: true, rail: 'paypal' }),
      getPolicy: () => inner.getPolicy(),
      getLedger: () => inner.getLedger(),
      submitIntent: (...a) => inner.submitIntent(...a),
      approve: (...a) => inner.approve(...a),
      reject: (...a) => inner.reject(...a),
      refresh: (...a) => inner.refresh(...a),
      resolve: (...a) => inner.resolve(...a),
    };
    const prev = window.location.href;
    window.history.replaceState({}, '', '/');
    try {
      renderWith(client);
      const user = userEvent.setup();
      await waitFor(() => expect(screen.getByTestId('rail-paypal')).toHaveAttribute('aria-pressed', 'true'));
      await user.click(screen.getByTestId('scenario-approved'));
      await user.click(screen.getByTestId('btn-quote'));
      expect(screen.getByTestId('btn-policy')).toBeEnabled();
      // The in-memory client pays on the mock rail: receipt rail differs from server rail.
      await user.click(screen.getByTestId('btn-policy'));
      expect(await screen.findByTestId('receipt')).toBeInTheDocument();
      expect(screen.queryByTestId('rail-mismatch')).not.toBeInTheDocument();
    } finally {
      window.history.replaceState({}, '', prev);
    }
  });

  it('shows pending elapsed and slow hint after threshold', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWith(
      createInMemoryClient({ pendingSettlement: { afterChecks: 5 }, now: () => new Date() }),
    );
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    expect(await screen.findByTestId('pending-elapsed')).toBeInTheDocument();

    vi.advanceTimersByTime(PENDING_SLOW_MS + 1000);
    expect(await screen.findByTestId('pending-slow-hint')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('shows loading skeletons while initial client calls are pending', async () => {
    const inner = createInMemoryClient();
    let resolveLedger!: (v: LedgerSnapshot) => void;
    const ledgerPromise = new Promise<LedgerSnapshot>((resolve) => {
      resolveLedger = resolve;
    });
    const client: AgentPayClient = {
      ...inner,
      getLedger: () => ledgerPromise,
    };

    renderWith(client);
    expect(screen.getByTestId('gauge-loading')).toBeInTheDocument();
    expect(screen.getByTestId('ledger-loading')).toBeInTheDocument();
    resolveLedger(await inner.getLedger());
    await waitFor(() => {
      expect(screen.queryByTestId('ledger-loading')).not.toBeInTheDocument();
    });
  });

  it('renders intent flow rows and skipped approval on direct pay', async () => {
    const user = userEvent.setup();
    renderWith(createInMemoryClient());
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await screen.findByTestId('receipt');

    expect(screen.getByTestId('intent-flows')).toBeInTheDocument();
    expect(screen.getAllByTestId('intent-flow').length).toBeGreaterThan(0);
    const skipped = document.querySelector('.stepper__step.is-skipped');
    expect(skipped).toBeTruthy();
  });

  it('selects scenario with keyboard Enter', async () => {
    const user = userEvent.setup();
    renderWith(createInMemoryClient());
    const card = screen.getByTestId('scenario-approved');
    card.focus();
    await user.keyboard('{Enter}');
    expect(card).toHaveAttribute('aria-pressed', 'true');
  });

  it('selects scenario with Space', async () => {
    const user = userEvent.setup();
    renderWith(createInMemoryClient());
    const card = screen.getByTestId('scenario-needs-approval');
    card.focus();
    await user.keyboard(' ');
    expect(card).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('App intents panel empty', () => {
  it('shows empty hint before any run', async () => {
    renderWith(createInMemoryClient());
    await waitFor(() => {
      expect(screen.queryByTestId('ledger-loading')).not.toBeInTheDocument();
    });
    const panel = screen.getByTestId('intent-flows');
    expect(within(panel).getByText(/Complete a scenario/i)).toBeInTheDocument();
  });
});
