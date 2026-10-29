import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../App';
import { ClientProvider } from '../data/ClientContext';
import { ApiError } from '../data/apiError';
import type { AgentPayClient } from '../data/agentPayClient';
import { createInMemoryClient, DEMO_POLICY } from '../data/inMemoryClient';

function renderWith(client: AgentPayClient) {
  return render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
}

describe('App r2 flows', () => {
  it('shows Submitting payment in Intents then Paid after delayed pay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let id = 0;
      const client = createInMemoryClient({
        payDelayMs: 2000,
        newId: () => `id-${++id}`,
        now: () => new Date('2026-03-01T12:00:00.000Z'),
      });
      renderWith(client);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
      await user.click(screen.getByTestId('scenario-approved'));
      await user.click(screen.getByTestId('btn-quote'));
      const payClick = user.click(screen.getByTestId('btn-policy'));
      await vi.advanceTimersByTimeAsync(500);
      await waitFor(() => {
        expect(screen.getByTestId('intent-flows')).toHaveTextContent('Submitting payment');
      });
      const paymentStep = document.querySelector(
        'ol.stepper .stepper__step.is-pending[aria-current="step"] .stepper__label',
      );
      expect(paymentStep?.textContent).toBe('Payment');
      await vi.advanceTimersByTimeAsync(2000);
      await payClick;
      await waitFor(() => {
        expect(screen.getByTestId('intent-flows')).toHaveTextContent('Paid');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('409 on approve shows Already processed info banner without retry and refreshes UI', async () => {
    const inner = createInMemoryClient({
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const client: AgentPayClient = {
      ...inner,
      async approve(intentId, approver) {
        await inner.approve(intentId, approver);
        throw new ApiError(409, `not_pending: intent ${intentId} was already processed`);
      },
    };

    renderWith(client);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-needs-approval'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await user.click(screen.getByTestId('btn-approve'));

    const banner = await screen.findByTestId('error-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent('Already processed');
    expect(screen.queryByTestId('btn-retry')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('btn-approve')).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId('receipt')).toBeInTheDocument();
  });

  it('invalid_policy decision shows label and explanation', async () => {
    const client = createInMemoryClient({
      invalidPolicy: true,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    renderWith(client);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    const decision = await screen.findByTestId('decision');
    expect(within(decision).getByText('invalid_policy')).toBeInTheDocument();
    expect(within(decision).getByTestId('reason-label')).toHaveTextContent('Invalid policy');
    expect(within(decision).getByTestId('reason-explanation')).toHaveTextContent(/malformed/i);
  });

  it('manual resolve shows warning box without pending slow hint', async () => {
    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payDelayMs: 0,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    renderWith(client);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    expect(await screen.findByTestId('manual-resolve')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-slow-hint')).not.toBeInTheDocument();
    expect(screen.queryByTestId('btn-refresh')).not.toBeInTheDocument();
    expect(screen.getByTestId('intent-flows')).toHaveTextContent('Needs manual resolution');
  });

  it('renders totals-by-currency when multiple currencies have spend', async () => {
    const inner = createInMemoryClient({ now: () => new Date('2026-03-01T12:00:00.000Z') });
    const client: AgentPayClient = {
      ...inner,
      async getLedger() {
        const snap = await inner.getLedger();
        return {
          ...snap,
          today: {
            day: snap.today.day,
            totals: {
              [DEMO_POLICY.agentId]: { USD: 12, EUR: 5 },
            },
          },
        };
      },
    };
    renderWith(client);
    await waitFor(() => expect(screen.getByTestId('totals-by-currency')).toBeInTheDocument());
    const list = screen.getByTestId('totals-by-currency');
    expect(list).toHaveTextContent('USD');
    expect(list).toHaveTextContent('EUR');
  });

  it('does not render totals-by-currency for single currency', async () => {
    renderWith(createInMemoryClient());
    await waitFor(() => expect(screen.getByTestId('gauge')).toBeInTheDocument());
    expect(screen.queryByTestId('totals-by-currency')).not.toBeInTheDocument();
  });
});
