import { render, screen } from '@testing-library/react';
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
});
