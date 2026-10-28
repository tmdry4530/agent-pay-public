import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { ClientProvider } from '../data/ClientContext';
import { createInMemoryClient } from '../data/inMemoryClient';

function renderApp() {
  return render(
    <ClientProvider client={createInMemoryClient()}>
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

    expect(await screen.findByTestId('receipt')).toHaveTextContent(/mock_/);
  });

  it('needs-approval flow shows human outcome after approve', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByTestId('scenario-needs-approval'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await user.click(screen.getByTestId('btn-approve'));

    expect(await screen.findByTestId('human-outcome')).toHaveTextContent(
      /Approved by human \(demo-operator\)/,
    );
  });

  it('accumulates spend and ledger across scenarios until reset', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await screen.findByTestId('receipt');

    await user.click(screen.getByTestId('scenario-needs-approval'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await user.click(screen.getByTestId('btn-approve'));
    await screen.findByTestId('receipt');

    const gauge = screen.getByTestId('gauge');
    expect(within(gauge).getByText(/\$87\.00/)).toBeInTheDocument();

    const ledger = screen.getByTestId('ledger');
    expect(within(ledger).getAllByText('intent recorded')).toHaveLength(2);

    await user.click(screen.getByTestId('btn-reset'));

    expect(within(gauge).getByText(/Spent today/i).textContent).toMatch(/\$0\.00/);
  });
});
