import type { LedgerEntry, PaymentResult } from '@agent-pay/core';

export interface CreateIntentBody {
  agentId: string;
  payee: string;
  amount: number;
  currency: string;
  purpose: string;
}

export type IntentPaymentResponse = PaymentResult & { intent: { id: string; createdAt: string; agentId: string } };

export interface LedgerResponse {
  entries: LedgerEntry[];
  today: { day: string; totals: Record<string, number> };
}

export class ApiClientError extends Error {
  override name = 'ApiClientError';
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Per-request timeout so a hung API cannot stall the agent forever. */
export const REQUEST_TIMEOUT_MS = 10_000;

function trimBase(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiClientError(`invalid_json: response is not JSON (HTTP ${res.status})`, res.status);
  }
}

async function assertOk(res: Response): Promise<unknown> {
  const body = await readJson(res);
  if (!res.ok) {
    const err =
      body !== null && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    throw new ApiClientError(err, res.status);
  }
  return body;
}

export async function postIntent(apiUrl: string, body: CreateIntentBody): Promise<IntentPaymentResponse> {
  let res: Response;
  try {
    res = await fetch(`${trimBase(apiUrl)}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiClientError(`fetch_failed: ${detail}`);
  }
  return (await assertOk(res)) as IntentPaymentResponse;
}

export async function postApprove(apiUrl: string, intentId: string, approver: string): Promise<PaymentResult> {
  let res: Response;
  try {
    res = await fetch(`${trimBase(apiUrl)}/intents/${encodeURIComponent(intentId)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approver }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiClientError(`fetch_failed: ${detail}`);
  }
  return (await assertOk(res)) as PaymentResult;
}

export async function postRefresh(apiUrl: string, intentId: string): Promise<PaymentResult & { changed: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${trimBase(apiUrl)}/intents/${encodeURIComponent(intentId)}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiClientError(`fetch_failed: ${detail}`);
  }
  return (await assertOk(res)) as PaymentResult & { changed: boolean };
}

export async function getLedger(apiUrl: string): Promise<LedgerResponse> {
  let res: Response;
  try {
    res = await fetch(`${trimBase(apiUrl)}/ledger`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiClientError(`fetch_failed: ${detail}`);
  }
  return (await assertOk(res)) as LedgerResponse;
}

export interface RailInfo {
  rail: string;
  currency: string;
  amountScale: number;
  payees: Record<string, string>;
}

function isRailInfo(body: unknown): body is RailInfo {
  if (body === null || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  if (typeof o.rail !== 'string' || typeof o.currency !== 'string' || typeof o.amountScale !== 'number') {
    return false;
  }
  if (o.payees === null || typeof o.payees !== 'object' || Array.isArray(o.payees)) return false;
  return Object.values(o.payees as Record<string, unknown>).every((v) => typeof v === 'string');
}

/**
 * Best-effort GET /rail for demo payee mapping. Returns undefined on 404, network failure,
 * non-OK HTTP, invalid JSON, or a 200 body that is not a well-formed RailInfo (agent keeps quote defaults).
 */
export async function getRail(apiUrl: string): Promise<RailInfo | undefined> {
  let res: Response;
  try {
    res = await fetch(`${trimBase(apiUrl)}/rail`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return undefined;
  }
  if (res.status === 404) return undefined;
  let body: unknown;
  try {
    body = await readJson(res);
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  return isRailInfo(body) ? body : undefined;
}
