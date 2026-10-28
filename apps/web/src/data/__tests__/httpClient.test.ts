import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../apiError';
import { createHttpClient } from '../httpClient';

describe('createHttpClient', () => {
  it('trims trailing slash on base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agentId: 'demo-agent', perTxMax: 100, dailyMax: 200, allowedPayees: [], requireApprovalAbove: 50 }),
    });
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:8787/', fetch: fetchMock });
    await client.getPolicy();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/policy',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
  });

  it('POST /intents sends only allowed fields and omits rail', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        intentId: 'pi_1',
        status: 'paid',
        decision: { status: 'approved', reason: 'within_policy: ok' },
        intent: {
          id: 'pi_1',
          agentId: 'demo-agent',
          payee: 'openai-api',
          amount: 12,
          currency: 'USD',
          purpose: 'test',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    });
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:8787', fetch: fetchMock });
    await client.submitIntent(
      {
        agentId: 'demo-agent',
        payee: 'openai-api',
        amount: 12,
        currency: 'USD',
        purpose: 'test',
        id: 'pi/custom',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      'mock',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/intents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          agentId: 'demo-agent',
          payee: 'openai-api',
          amount: 12,
          currency: 'USD',
          purpose: 'test',
          id: 'pi/custom',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      }),
    );
  });

  it('encodes intent id in approve and reject paths', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ intentId: 'a/b', status: 'rejected', decision: { status: 'rejected', reason: 'x: y' } }),
    });
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:8787', fetch: fetchMock });
    await client.approve('a/b', 'op');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:8787/intents/a%2Fb/approve');
    await client.reject('a/b', { note: 'nope' });
    expect(fetchMock.mock.calls[1]![0]).toBe('http://127.0.0.1:8787/intents/a%2Fb/reject');
  });

  it('GET /ledger and GET /policy', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entries: [], today: { day: '2026-01-01', totals: {} } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ agentId: 'demo-agent', perTxMax: 1, dailyMax: 2, allowedPayees: [], requireApprovalAbove: 0 }),
      });
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:8787', fetch: fetchMock });
    await client.getLedger();
    await client.getPolicy();
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:8787/ledger');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://127.0.0.1:8787/policy');
  });

  it('wraps fetch TypeError as ApiError status 0', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:8787', fetch: fetchMock });
    await expect(client.getPolicy()).rejects.toEqual(
      new ApiError(0, 'network_error: cannot reach API at http://127.0.0.1:8787 (Failed to fetch)'),
    );
  });

  it('GET /health returns ok and rail', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, rail: 'near' }),
    });
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:8787', fetch: fetchMock });
    await expect(client.getHealth!()).resolves.toEqual({ ok: true, rail: 'near' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/health',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
  });

  it('throws ApiError with body.error on 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'invalid_body: bad field' }),
    });
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:8787', fetch: fetchMock });
    await expect(client.getPolicy()).rejects.toEqual(new ApiError(400, 'invalid_body: bad field'));
  });
});
