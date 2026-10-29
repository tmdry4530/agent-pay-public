import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../App';
import { ClientProvider } from '../data/ClientContext';
import { ApiError } from '../data/apiError';
import type { AgentPayClient } from '../data/agentPayClient';
import { createInMemoryClient } from '../data/inMemoryClient';

const clock = () => new Date('2026-03-01T12:00:05.000Z');

function renderWith(client: AgentPayClient) {
  return render(
    <ClientProvider client={client}>
      <App clock={clock} />
    </ClientProvider>,
  );
}

async function runNeedsApprovalFlow(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('scenario-needs-approval'));
  await user.click(screen.getByTestId('btn-quote'));
  await user.click(screen.getByTestId('btn-policy'));
}

describe('App 409 conflict handling', () => {
  it('precondition_failed on approve shows conflict-banner, reloads ledger, no retry', async () => {
    const inner = createInMemoryClient({
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const getLedger = vi.fn(inner.getLedger.bind(inner));
    const detail = 'policy changed since quote <script>';
    const client: AgentPayClient = {
      ...inner,
      getLedger,
      async approve(intentId, approver) {
        await inner.approve(intentId, approver);
        throw new ApiError(409, `precondition_failed: ${detail}`, {
          code: 'precondition_failed',
          detail,
        });
      },
    };

    renderWith(client);
    const user = userEvent.setup();
    await runNeedsApprovalFlow(user);
    const callsBefore = getLedger.mock.calls.length;
    await user.click(screen.getByTestId('btn-approve'));

    const banner = await screen.findByTestId('conflict-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveAttribute('data-code', 'precondition_failed');
    expect(banner).toHaveTextContent('Conflict');
    expect(banner).toHaveTextContent(detail);
    expect(banner.querySelector('script')).toBeNull();
    expect(screen.queryByTestId('btn-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('race-banner')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(getLedger.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('known race code on approve still shows race-banner', async () => {
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
    await runNeedsApprovalFlow(user);
    await user.click(screen.getByTestId('btn-approve'));

    const banner = await screen.findByTestId('race-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent('Already processed');
    expect(screen.queryByTestId('conflict-banner')).not.toBeInTheDocument();
  });
});
