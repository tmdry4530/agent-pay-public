import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { ClientProvider } from '../data/ClientContext';
import { createInMemoryClient } from '../data/inMemoryClient';

function renderWith(client: ReturnType<typeof createInMemoryClient>) {
  return render(
    <ClientProvider client={client}>
      <App clock={() => new Date('2026-03-01T12:00:00.000Z')} />
    </ClientProvider>,
  );
}

function decisionStepperStep(): HTMLElement | null {
  const stepper = screen.getByRole('list', { name: 'Pipeline steps' });
  const label = within(stepper).getByText('Decision');
  return label.closest('.stepper__step');
}

describe('Decision card payment outcome', () => {
  it('separates approved decision from failed resolve outcome', async () => {
    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    renderWith(client);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await screen.findByTestId('resolve-form');

    await user.click(screen.getByTestId('resolve-status-failed'));
    await user.type(screen.getByTestId('resolve-note'), 'no charge on rail');
    await user.type(screen.getByTestId('resolve-by'), 'ops-alice');
    await user.click(screen.getByTestId('btn-resolve-submit'));
    await screen.findByTestId('resolve-success');

    const decision = screen.getByTestId('decision');
    expect(within(decision).getByText(/^approved$/i)).toBeInTheDocument();
    const paymentOutcome = within(decision).getByTestId('payment-outcome');
    expect(within(paymentOutcome).getByTestId('result-status')).toHaveTextContent('failed');
    expect(within(decision).getByTestId('payment-outcome-text')).toHaveTextContent(
      'Payment failed — resolved by ops-alice',
    );
    expect(within(decision).queryByTestId('payment-failure-detail')).not.toBeInTheDocument();

    const decisionStep = decisionStepperStep();
    expect(decisionStep).not.toBeNull();
    expect(decisionStep).toHaveClass('is-done');
    expect(decisionStep).not.toHaveClass('is-error');
  });

  it('shows succeeded resolve outcome text', async () => {
    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    renderWith(client);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await screen.findByTestId('resolve-form');

    await user.click(screen.getByTestId('resolve-status-succeeded'));
    await user.type(screen.getByTestId('resolve-note'), 'confirmed on mock dashboard');
    await user.type(screen.getByTestId('resolve-by'), 'ops-alice');
    await user.type(screen.getByTestId('resolve-external-id'), 'rail-123');
    await user.click(screen.getByTestId('btn-resolve-submit'));
    await screen.findByTestId('resolve-success');

    expect(screen.getByTestId('payment-outcome-text')).toHaveTextContent(
      'Payment succeeded — resolved by ops-alice',
    );
  });

  it('plain paid run shows payment succeeded without resolved by', async () => {
    renderWith(createInMemoryClient({ now: () => new Date('2026-03-01T12:00:00.000Z') }));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await waitFor(() => expect(screen.getByTestId('result-status')).toHaveTextContent('paid'));

    expect(screen.getByTestId('payment-outcome-text')).toHaveTextContent('Payment succeeded');
    expect(screen.getByTestId('payment-outcome-text')).not.toHaveTextContent(/resolved by/i);
  });

  it('plain failed payment keeps approved decision and shows failure detail', async () => {
    const client = createInMemoryClient({
      pendingSettlement: { afterChecks: 1, outcome: 'failed' },
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    renderWith(client);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await screen.findByTestId('receipt');
    await user.click(screen.getByTestId('btn-refresh'));
    await waitFor(() => expect(screen.getByTestId('result-status')).toHaveTextContent('failed'));

    const decision = screen.getByTestId('decision');
    expect(within(decision).getByText(/^approved$/i)).toBeInTheDocument();
    expect(within(decision).getByTestId('payment-outcome-text')).toHaveTextContent('Payment failed');
    expect(within(decision).getByTestId('payment-failure-detail')).toBeInTheDocument();

    const decisionStep = decisionStepperStep();
    expect(decisionStep).toHaveClass('is-done');
    expect(decisionStep).not.toHaveClass('is-error');
  });

  it('policy denied scenario has no payment-outcome-text', async () => {
    renderWith(createInMemoryClient({ now: () => new Date('2026-03-01T12:00:00.000Z') }));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-rejected'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await screen.findByTestId('decision');

    expect(screen.queryByTestId('payment-outcome-text')).not.toBeInTheDocument();
    expect(screen.getByTestId('payment-outcome')).toBeInTheDocument();
    expect(screen.getByTestId('payment-outcome')).toHaveTextContent('Status');
    expect(screen.getByTestId('payment-outcome')).not.toHaveTextContent('Payment outcome');
  });
});
