import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, afterEach } from 'vitest';
import App from '../App';
import { ClientProvider } from '../data/ClientContext';
import { ApiError } from '../data/apiError';
import type { AgentPayClient } from '../data/agentPayClient';
import { RACE_409_CODES, STUCK_SUBMITTING_MS } from '../data/compat';
import { race409Message } from '../data/compat';
import { createInMemoryClient } from '../data/inMemoryClient';

function renderWith(client: AgentPayClient, clock?: () => Date) {
  return render(
    <ClientProvider client={client}>
      <App clock={clock} />
    </ClientProvider>,
  );
}

async function runNeedsCheckScenario(client: AgentPayClient, clock?: () => Date) {
  renderWith(client, clock);
  const user = userEvent.setup();
  await user.click(screen.getByTestId('scenario-approved'));
  await user.click(screen.getByTestId('btn-quote'));
  await user.click(screen.getByTestId('btn-policy'));
  await screen.findByTestId('manual-resolve');
  return user;
}

describe('App r3 resolve and race banners', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('409 race banners per code', () => {
    it.each(RACE_409_CODES)('approve 409 %s shows info banner and refreshes ledger', async (code) => {
      const inner = createInMemoryClient({
        now: () => new Date('2026-03-01T12:00:00.000Z'),
      });
      const getLedgerSpy = vi.spyOn(inner, 'getLedger');
      const { title } = race409Message(code);
      const detail = `server detail for ${code}`;
      const client: AgentPayClient = {
        ...inner,
        async approve(intentId, approver) {
          await inner.approve(intentId, approver);
          throw new ApiError(409, `${code}: ${detail}`, { code, detail });
        },
      };

      renderWith(client);
      const user = userEvent.setup();
      await user.click(screen.getByTestId('scenario-needs-approval'));
      await user.click(screen.getByTestId('btn-quote'));
      await user.click(screen.getByTestId('btn-policy'));
      const callsBefore = getLedgerSpy.mock.calls.length;
      await user.click(screen.getByTestId('btn-approve'));

      const banner = await screen.findByTestId('race-banner');
      expect(banner).toHaveAttribute('role', 'status');
      expect(banner).toHaveAttribute('data-code', code);
      expect(banner).toHaveTextContent(title);
      expect(banner).not.toHaveTextContent(code);
      expect(screen.queryByTestId('btn-retry')).not.toBeInTheDocument();
      await waitFor(() => {
        expect(getLedgerSpy.mock.calls.length).toBeGreaterThan(callsBefore);
      });
    });
  });

  it('resolve form appears only for needs-check entries', async () => {
    const first = renderWith(createInMemoryClient({ now: () => new Date('2026-03-01T12:00:00.000Z') }));
    const user = userEvent.setup();
    await user.click(screen.getByTestId('scenario-approved'));
    await user.click(screen.getByTestId('btn-quote'));
    await user.click(screen.getByTestId('btn-policy'));
    await waitFor(() => expect(screen.getByTestId('result-status')).toHaveTextContent('paid'));
    expect(screen.queryByTestId('resolve-form')).not.toBeInTheDocument();
    first.unmount();

    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      payDelayMs: 0,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    renderWith(client);
    const user2 = userEvent.setup();
    await user2.click(screen.getByTestId('scenario-approved'));
    await user2.click(screen.getByTestId('btn-quote'));
    await user2.click(screen.getByTestId('btn-policy'));
    expect(await screen.findByTestId('resolve-form')).toBeInTheDocument();
  });

  it('validation blocks submit and focuses first invalid field', async () => {
    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const resolveSpy = vi.spyOn(client, 'resolve');
    const user = await runNeedsCheckScenario(client);
    await user.click(screen.getByTestId('btn-resolve-submit'));
    expect(await screen.findByTestId('resolve-error-status')).toBeInTheDocument();
    expect(screen.getByTestId('resolve-error-note')).toHaveTextContent('Note is required for the audit record');
    expect(screen.getByTestId('resolve-note-hint')).toHaveTextContent(/audit record/);
    expect(screen.getByTestId('resolve-note')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByTestId('resolve-note').getAttribute('aria-describedby')).toContain('resolve-note-hint');
    expect(screen.getByTestId('resolve-error-resolvedBy')).toBeInTheDocument();
    expect(screen.getByTestId('resolve-status-succeeded')).toHaveFocus();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('successful resolve updates UI and ledger', async () => {
    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const user = await runNeedsCheckScenario(client);
    await user.click(screen.getByTestId('resolve-status-succeeded'));
    await user.type(screen.getByTestId('resolve-note'), 'confirmed on mock dashboard');
    await user.type(screen.getByTestId('resolve-by'), 'ops-alice');
    await user.type(screen.getByTestId('resolve-external-id'), 'rail-123');
    await user.click(screen.getByTestId('btn-resolve-submit'));

    expect(await screen.findByTestId('resolve-success')).toHaveTextContent(
      'Resolved as succeeded by ops-alice',
    );
    expect(screen.getByTestId('result-status')).toHaveTextContent('paid');
    expect(screen.getByTestId('result-status')).not.toHaveTextContent('Needs check (pending)');
    expect(screen.getByTestId('intent-resolution')).toHaveTextContent('ops-alice');
    expect(screen.getByTestId('intent-resolution')).toHaveTextContent('confirmed on mock dashboard');
    expect(screen.queryByTestId('manual-resolve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resolve-form')).not.toBeInTheDocument();
    const ledger = screen.getByTestId('ledger');
    expect(within(ledger).getByText(/resolved succeeded/i)).toBeInTheDocument();
  });

  it('failed resolve outcome shows failed status', async () => {
    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const user = await runNeedsCheckScenario(client);
    await user.click(screen.getByTestId('resolve-status-failed'));
    await user.type(screen.getByTestId('resolve-note'), 'no charge on rail');
    await user.type(screen.getByTestId('resolve-by'), 'ops-alice');
    await user.click(screen.getByTestId('btn-resolve-submit'));
    await screen.findByTestId('resolve-success');
    expect(screen.getByTestId('result-status')).toHaveTextContent('failed');
  });

  it.each([
    ['', false],
    ['rail-old-1', true],
  ] as const)('resolution timeline previous external id %j shown=%s', async (previous, shown) => {
    const inner = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const client: AgentPayClient = {
      ...inner,
      async getLedger() {
        const ledger = await inner.getLedger();
        return {
          ...ledger,
          entries: ledger.entries.map((e) =>
            e.resolution ? { ...e, resolution: { ...e.resolution, previousExternalId: previous } } : e,
          ),
        };
      },
    };
    const user = await runNeedsCheckScenario(client);
    await user.click(screen.getByTestId('resolve-status-failed'));
    await user.type(screen.getByTestId('resolve-note'), 'no charge on rail');
    await user.type(screen.getByTestId('resolve-by'), 'ops-alice');
    await user.click(screen.getByTestId('btn-resolve-submit'));
    await screen.findByTestId('resolve-success');
    const ledger = screen.getByTestId('ledger');
    await waitFor(() => expect(within(ledger).getByText(/resolved failed/i)).toBeInTheDocument());
    if (shown) {
      expect(within(ledger).getByTestId('ledger-resolution')).toHaveTextContent('previous: rail-old-1');
    } else {
      expect(within(ledger).queryByTestId('ledger-resolution')).not.toBeInTheDocument();
      expect(ledger).not.toHaveTextContent('previous:');
    }
  });

  it('resolve errors show alert and refresh ledger on already resolved', async () => {
    const inner = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const getLedgerSpy = vi.spyOn(inner, 'getLedger');
    const client: AgentPayClient = {
      ...inner,
      async resolve() {
        throw new ApiError(409, 'receipt_not_pending: already resolved', {
          code: 'receipt_not_pending',
        });
      },
    };
    const user = await runNeedsCheckScenario(client);
    await user.click(screen.getByTestId('resolve-status-succeeded'));
    await user.type(screen.getByTestId('resolve-note'), 'keep this note');
    await user.type(screen.getByTestId('resolve-by'), 'ops-alice');
    const callsBefore = getLedgerSpy.mock.calls.length;
    await user.click(screen.getByTestId('btn-resolve-submit'));

    const alert = await screen.findByTestId('resolve-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Already resolved');
    expect(screen.getByTestId('resolve-note')).toHaveValue('keep this note');
    expect(screen.getByTestId('resolve-by')).toHaveValue('ops-alice');
    await waitFor(() => {
      expect(getLedgerSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('resolve 400 invalid_body shows server detail', async () => {
    const inner = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const client: AgentPayClient = {
      ...inner,
      async resolve() {
        throw new ApiError(400, 'invalid_body: note too short', {
          code: 'invalid_body',
          detail: 'note too short',
        });
      },
    };
    const user = await runNeedsCheckScenario(client);
    await user.click(screen.getByTestId('resolve-status-succeeded'));
    await user.type(screen.getByTestId('resolve-note'), 'x');
    await user.type(screen.getByTestId('resolve-by'), 'ops');
    await user.click(screen.getByTestId('btn-resolve-submit'));
    const alert = await screen.findByTestId('resolve-error');
    expect(alert).toHaveTextContent('note too short');
  });

  it('keyboard tab and Enter submits resolve form', async () => {
    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const user = await runNeedsCheckScenario(client);
    await user.click(screen.getByTestId('resolve-status-succeeded'));
    await user.type(screen.getByTestId('resolve-note'), 'ok');
    await user.type(screen.getByTestId('resolve-by'), 'ops-alice');
    await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('resolve-success')).toBeInTheDocument();
  });

  it('stuck submitting shows banner and resolves away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let nowMs = new Date('2026-03-01T12:00:00.000Z').getTime();
      const clockFn = () => new Date(nowMs);
      const client = createInMemoryClient({ payOutcome: 'hang', now: clockFn });
      renderWith(client, clockFn);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
      await user.click(screen.getByTestId('scenario-approved'));
      await user.click(screen.getByTestId('btn-quote'));
      void user.click(screen.getByTestId('btn-policy'));
      await vi.advanceTimersByTimeAsync(500);
      await waitFor(() => {
        expect(screen.getByTestId('intent-flows')).toHaveTextContent('Submitting payment');
      });
      expect(screen.queryByTestId('stuck-submitting')).not.toBeInTheDocument();

      nowMs += STUCK_SUBMITTING_MS + 1000;
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(
        () => {
          expect(screen.getByTestId('stuck-submitting')).toHaveTextContent('Stuck — needs check');
        },
        { timeout: 5000 },
      );
      expect(screen.getByTestId('intent-flows')).toHaveTextContent('Stuck — needs check');
      expect(screen.getByTestId('resolve-form')).toBeInTheDocument();

      await user.click(screen.getByTestId('resolve-status-failed'));
      await user.type(screen.getByTestId('resolve-note'), 'hung pay cleared');
      await user.type(screen.getByTestId('resolve-by'), 'ops-alice');
      await user.click(screen.getByTestId('btn-resolve-submit'));
      await screen.findByTestId('resolve-success');
      expect(screen.queryByTestId('stuck-submitting')).not.toBeInTheDocument();
      expect(screen.getByTestId('result-status')).toHaveTextContent('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('quote card shows selected intent after Resolve…, not a stale scenario draft', async () => {
    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const user = await runNeedsCheckScenario(client);
    const openaiIntentId = (await client.getLedger()).entries[0]!.intent.id;
    await user.click(screen.getByTestId('scenario-needs-approval'));
    await user.click(screen.getByTestId('btn-quote'));

    const quoteCard = screen.getByTestId('quote-card');
    expect(within(quoteCard).getByText('near-compute')).toBeInTheDocument();
    expect(quoteCard).toHaveTextContent('$75.00');

    await user.click(screen.getByTestId('btn-open-resolve'));

    expect(within(quoteCard).getByText('openai-api')).toBeInTheDocument();
    expect(quoteCard).toHaveTextContent('$12.00');
    expect(within(quoteCard).getByText(openaiIntentId)).toBeInTheDocument();
    expect(within(quoteCard).queryByText('near-compute')).not.toBeInTheDocument();
  });

  it('btn-open-resolve opens resolve form for needs-check entry', async () => {
    const client = createInMemoryClient({
      payOutcome: 'timeout',
      payTimeoutMs: 50,
      now: () => new Date('2026-03-01T12:00:00.000Z'),
    });
    const user = await runNeedsCheckScenario(client);
    expect(screen.getByTestId('resolve-form')).toBeInTheDocument();
    const openBtn = screen.getByTestId('btn-open-resolve');
    expect(openBtn).toHaveAttribute('aria-label', expect.stringMatching(/Resolve/));
    await user.click(openBtn);
    expect(screen.getByTestId('resolve-form')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Resolve payment' })).toHaveFocus();
  });
});
