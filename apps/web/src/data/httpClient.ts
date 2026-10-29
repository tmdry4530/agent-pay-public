import type { PaymentIntent, PaymentResult, Policy, Rail, ReceiptResolution } from '@agent-pay/core';
import { ApiError } from './apiError';
import type { AgentPayClient, IntentDraft, LedgerSnapshot } from './agentPayClient';
import type { ResolveRequest } from './compat';
import { computeClockOffsetMs } from './serverClock';

export type HttpClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Local epoch ms when a response is received (default `Date.now`). */
  now?: () => number;
};

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function readError(res: Response): Promise<{ message: string; code?: string; detail?: string }> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    if (typeof body.error === 'string' && body.error.length > 0) {
      if (
        typeof body.message === 'string' &&
        body.message.length > 0 &&
        !body.error.includes(':')
      ) {
        const code = body.error;
        const detail = body.message;
        return { message: `${code}: ${detail}`, code, detail };
      }
      return { message: body.error };
    }
  } catch {
    /* ignore */
  }
  const fallback = res.statusText || `HTTP ${res.status}`;
  return { message: fallback };
}

/**
 * HTTP client for the agent-pay demo API.
 * The `rail` argument on submitIntent is ignored — the server uses a single configured adapter.
 */
export function createHttpClient(options: HttpClientOptions): AgentPayClient {
  const base = trimBase(options.baseUrl);
  const fetchFn = options.fetch ?? fetch;
  const nowFn = options.now ?? Date.now;
  let clockOffsetMs = 0;

  function captureClockOffset(res: Response): void {
    // Tolerate minimal fetch stubs without headers (treated as a missing header).
    const header = typeof res.headers?.get === 'function' ? res.headers.get('Date') : null;
    const offset = computeClockOffsetMs(header, nowFn());
    if (offset !== undefined) {
      clockOffsetMs = offset;
    }
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
    } catch (e) {
      if (e instanceof TypeError) {
        throw new ApiError(
          0,
          `network_error: cannot reach API at ${base} (${e.message})`,
        );
      }
      throw e;
    }
    captureClockOffset(res);
    if (!res.ok) {
      const errBody = await readError(res);
      throw new ApiError(
        res.status,
        errBody.message,
        errBody.code !== undefined ? { code: errBody.code, detail: errBody.detail } : undefined,
      );
    }
    return (await res.json()) as T;
  }

  return {
    kind: 'http',

    getPolicy(): Promise<Policy> {
      return request<Policy>('/policy');
    },

    async submitIntent(draft: IntentDraft, _rail: Rail) {
      void _rail;
      const body: Record<string, unknown> = {
        agentId: draft.agentId,
        payee: draft.payee,
        amount: draft.amount,
        currency: draft.currency,
        purpose: draft.purpose,
      };
      if (draft.id !== undefined) body.id = draft.id;
      if (draft.createdAt !== undefined) body.createdAt = draft.createdAt;
      return request<PaymentResult & { intent: PaymentIntent }>('/intents', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    approve(intentId: string, approver?: string): Promise<PaymentResult> {
      const body = approver === undefined ? {} : { approver };
      return request<PaymentResult>(
        `/intents/${encodeURIComponent(intentId)}/approve`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    reject(intentId: string, opts = {}): Promise<PaymentResult> {
      const body: Record<string, string> = {};
      if (opts.approver !== undefined) body.approver = opts.approver;
      if (opts.note !== undefined) body.note = opts.note;
      return request<PaymentResult>(
        `/intents/${encodeURIComponent(intentId)}/reject`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    refresh(intentId: string): Promise<PaymentResult & { changed: boolean }> {
      return request<PaymentResult & { changed: boolean }>(
        `/intents/${encodeURIComponent(intentId)}/refresh`,
        { method: 'POST', body: '{}' },
      );
    },

    resolve(
      intentId: string,
      req: ResolveRequest,
    ): Promise<PaymentResult & { changed: true; resolution: ReceiptResolution }> {
      const body: Record<string, string> = {
        status: req.status,
        note: req.note,
        resolvedBy: req.resolvedBy,
      };
      if (req.externalId !== undefined) body.externalId = req.externalId;
      return request<PaymentResult & { changed: true; resolution: ReceiptResolution }>(
        `/intents/${encodeURIComponent(intentId)}/resolve`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    getLedger(): Promise<LedgerSnapshot> {
      return request<LedgerSnapshot>('/ledger');
    },

    getHealth(): Promise<{ ok: boolean; rail: string }> {
      return request<{ ok: boolean; rail: string }>('/health');
    },

    serverClockOffsetMs(): number {
      return clockOffsetMs;
    },
  };
}
