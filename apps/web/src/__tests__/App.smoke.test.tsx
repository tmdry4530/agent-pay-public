import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { ClientProvider } from '../data/ClientContext';

function renderApp() {
  return render(
    <ClientProvider>
      <App />
    </ClientProvider>,
  );
}

describe('App smoke', () => {
  it('renders and completes approved scenario through receipt', async () => {
    const user = userEvent.setup();
    renderApp();

    expect(screen.getByRole('heading', { name: /agent-pay/i })).toBeInTheDocument();

    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await user.click(screen.getByTestId('btn-pay'));

    expect(await screen.findByTestId('receipt')).toHaveTextContent(/MOCK-TX-/);
  });

  it('accumulates spend and ledger across scenarios until reset', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await user.click(screen.getByTestId('btn-pay'));
    await screen.findByTestId('receipt');

    await user.click(screen.getByTestId('scenario-needs-approval'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await user.click(screen.getByTestId('btn-approve'));
    await user.click(screen.getByTestId('btn-pay'));
    await screen.findByTestId('receipt');

    const gauge = screen.getByTestId('gauge');
    expect(within(gauge).getByText(/\$87\.00/)).toBeInTheDocument();

    const ledger = screen.getByTestId('ledger');
    expect(within(ledger).getAllByText('intent_created')).toHaveLength(2);
    expect(within(ledger).getAllByText('payment_settled')).toHaveLength(2);

    await user.click(screen.getByTestId('btn-reset'));

    expect(within(gauge).getByText(/Spent today/i).textContent).toMatch(
      /\$0\.00/,
    );
  });
});
