import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../App';
import { ApiError } from '../data/apiError';
import { ClientProvider } from '../data/ClientContext';
import type { AgentPayClient } from '../data/agentPayClient';
import { createInMemoryClient } from '../data/inMemoryClient';

function renderApp(client = createInMemoryClient()) {
  return render(
    <ClientProvider client={client}>
      <App />
    </ClientProvider>,
  );
}

async function tabUntilTestId(user: ReturnType<typeof userEvent.setup>, testId: string, max = 40) {
  for (let i = 0; i < max; i += 1) {
    if (document.activeElement?.getAttribute('data-testid') === testId) return;
    await user.tab();
  }
  throw new Error(`Could not tab to [data-testid="${testId}"]`);
}

describe('App keyboard accessibility', () => {
  it('exposes aria-pressed on scenario cards', async () => {
    const user = userEvent.setup();
    renderApp();

    const approved = screen.getByTestId('scenario-approved');
    expect(approved).toHaveAttribute('aria-pressed', 'false');

    await user.click(approved);
    expect(approved).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('scenario-rejected')).toHaveAttribute('aria-pressed', 'false');
  });

  it('tab order reaches scenarios, rail toggle, and Get quote in DOM order', async () => {
    const user = userEvent.setup();
    renderApp();

    const orderedTestIds = [
      'scenario-approved',
      'scenario-rejected',
      'scenario-needs-approval',
      'btn-reset',
      'rail-mock',
      'rail-paypal',
      'rail-near',
      'btn-quote',
    ];

    // Select a scenario with the keyboard first (Get quote is disabled until then).
    await tabUntilTestId(user, 'scenario-approved');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('scenario-approved')).toHaveAttribute('aria-pressed', 'true');
    (document.activeElement as HTMLElement | null)?.blur();

    let lastIndex = -1;
    for (const testId of orderedTestIds) {
      await tabUntilTestId(user, testId);
      const index = orderedTestIds.indexOf(testId);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
      expect(document.activeElement).toHaveAttribute('data-testid', testId);
    }
  });

  it('error banner uses role=alert', async () => {
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

    renderApp(client);
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));

    const banner = await screen.findByTestId('error-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('btn-retry')).toBeEnabled();
  });
});
