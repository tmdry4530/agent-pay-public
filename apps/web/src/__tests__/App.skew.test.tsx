import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../App';
import { ClientProvider } from '../data/ClientContext';
import type { AgentPayClient, LedgerSnapshot } from '../data/agentPayClient';
import { STUCK_SUBMITTING_MS } from '../data/compat';
import { createHttpClient } from '../data/httpClient';
import { createInMemoryClient } from '../data/inMemoryClient';
import type { LedgerEntry } from '@agent-pay/core';
import { ReasonCode } from '@agent-pay/core/policy.ts';

const SUBMIT_ANCHOR = '2026-03-01T12:00:00.000Z';
const SUBMIT_ANCHOR_MS = Date.parse(SUBMIT_ANCHOR);

const basePolicy = {
  agentId: 'demo-agent',
  perTxMax: 500,
  dailyMax: 2000,
  allowedPayees: ['openai-api'],
  requireApprovalAbove: 50,
  currency: 'USD',
};

function submittingLedgerEntry(): LedgerEntry {
  return {
    intent: {
      id: 'pi-skew-test',
      createdAt: '2026-03-01T11:00:00.000Z',
      agentId: 'demo-agent',
      payee: 'openai-api',
      amount: 12,
      currency: 'USD',
      purpose: 'skew test',
    },
    recordedAt: '2026-03-01T11:30:00.000Z',
    updatedAt: SUBMIT_ANCHOR,
    decisions: [
      {
        status: 'approved',
        reason: `${ReasonCode.WithinPolicy}: ok`,
        at: '2026-03-01T11:45:00.000Z',
      },
    ],
    paymentStatus: 'submitting',
    submission: { rail: 'mock', at: SUBMIT_ANCHOR },
  };
}

function ledgerSnapshot(): LedgerSnapshot {
  return {
    entries: [submittingLedgerEntry()],
    today: { day: '2026-03-01', totals: { 'demo-agent': 0 } },
  };
}

function apiFetch(dateOffsetMs: number, localNowMs: () => number): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const receiveMs = localNowMs();
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.set('Date', new Date(receiveMs + dateOffsetMs).toUTCString());

    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true, rail: 'mock' }), { status: 200, headers });
    }
    if (url.endsWith('/policy')) {
      return new Response(JSON.stringify(basePolicy), { status: 200, headers });
    }
    if (url.endsWith('/ledger')) {
      return new Response(JSON.stringify(ledgerSnapshot()), { status: 200, headers });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers });
  }) as typeof fetch;
}

function renderHttpSkewApp(clockMs: number, dateOffsetMs: number) {
  const clockFn = () => new Date(clockMs);
  const localNowMs = () => clockMs;
  const client = createHttpClient({
    baseUrl: 'http://127.0.0.1:8787',
    fetch: apiFetch(dateOffsetMs, localNowMs),
    now: localNowMs,
  });
  return render(
    <ClientProvider client={client}>
      <App clock={clockFn} />
    </ClientProvider>,
  );
}

describe('App server clock skew for stuck submitting', () => {
  it('does not show stuck when server is behind local (offset from Date header)', async () => {
    const localMs = SUBMIT_ANCHOR_MS + 70_000;
    renderHttpSkewApp(localMs, -90_000);
    await waitFor(() => {
      expect(screen.getByTestId('intent-flows')).toHaveTextContent('Submitting payment');
    });
    expect(screen.queryByTestId('stuck-submitting')).not.toBeInTheDocument();
    expect(screen.getByTestId('intent-flows')).not.toHaveTextContent('Stuck — needs check');
  });

  it('shows stuck when server is ahead of local', async () => {
    renderHttpSkewApp(SUBMIT_ANCHOR_MS, 90_000);
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByTestId('intent-flows')).toHaveTextContent('Stuck — needs check');
    });
    await user.click(screen.getByTestId('btn-open-resolve'));
    expect(screen.getByTestId('stuck-submitting')).toHaveTextContent('Stuck — needs check');
  });

  it('treats missing serverClockOffsetMs as zero offset', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let nowMs = SUBMIT_ANCHOR_MS;
      const clockFn = () => new Date(nowMs);
      const inner = createInMemoryClient({ payOutcome: 'hang', now: clockFn });
      const client: AgentPayClient = {
        ...inner,
        kind: 'mock',
      };
      render(
        <ClientProvider client={client}>
          <App clock={clockFn} />
        </ClientProvider>,
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync });
      await user.click(screen.getByTestId('scenario-approved'));
      await user.click(screen.getByTestId('btn-quote'));
      void user.click(screen.getByTestId('btn-policy'));
      await vi.advanceTimersByTimeAsync(500);
      await waitFor(() => {
        expect(screen.getByTestId('intent-flows')).toHaveTextContent('Submitting payment');
      });

      nowMs += STUCK_SUBMITTING_MS + 1_000;
      await vi.advanceTimersByTimeAsync(1_500);
      await waitFor(() => {
        expect(screen.getByTestId('stuck-submitting')).toBeInTheDocument();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('http client offset -90000 matches manual expectation for stuck threshold', async () => {
    const localMs = SUBMIT_ANCHOR_MS + 70_000;
    const client = createHttpClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetch: apiFetch(-90_000, () => localMs),
      now: () => localMs,
    });
    await client.getLedger();
    expect(client.serverClockOffsetMs?.()).toBe(-90_000);
  });
});
