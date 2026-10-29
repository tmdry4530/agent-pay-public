import type { LedgerEntry, PaymentResult } from '@agent-pay/core';

export interface CreateIntentBody {
  agentId: string;
  payee: string;
  amount: number;
  currency: string;
  purpose: string;
  /** Client-chosen intent id; resending the same id + content replays instead of paying again (F14). */
  id?: string;
  /** ISO 8601; default: the server clock. If set, send the same value on every retry. */
  createdAt?: string;
}

export type IntentPaymentResponse = PaymentResult & { intent: { id: string; createdAt: string; agentId: string } };

export interface LedgerResponse {
  entries: LedgerEntry[];
  today: { day: string; totals: Record<string, number> };
}

export class ApiClientError extends Error {
  override name = 'ApiClientError';
  readonly status?: number;
  /**
   * The request may or may not have reached the server and a resend of the same idempotent
   * request is safe and may succeed: timeouts, dropped connections and HTTP 5xx. False for
   * 4xx and for connection refused / DNS failures (the API is down).
   */
  readonly retryable: boolean;
  constructor(message: string, status?: number, retryable = status !== undefined && status >= 500) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/** Per-request timeout so a hung API cannot stall the agent forever. */
export const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Timeout for POST /intents, which can include the rail payment: longer than core's
 * DEFAULT_PAY_TIMEOUT_MS (60 s) so the server answers first in the normal case.
 */
export const SUBMIT_TIMEOUT_MS = 70_000;

const NOT_REACHED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

function fetchFailed(err: unknown): ApiClientError {
  const detail = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const notReached = typeof cause?.code === 'string' && NOT_REACHED.has(cause.code);
  return new ApiClientError(`fetch_failed: ${detail}`, undefined, !notReached);
}

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

function apiErrorMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
    const error = (body as { error: string }).error;
    const message = 'message' in body ? (body as { message: unknown }).message : undefined;
    if (typeof message === 'string' && message.length > 0) return `${error}: ${message}`;
    return error;
  }
  return `HTTP ${status}`;
}

async function assertOk(res: Response): Promise<unknown> {
  const body = await readJson(res);
  if (!res.ok) throw new ApiClientError(apiErrorMessage(body, res.status), res.status);
  return body;
}

export async function postIntent(
  apiUrl: string,
  body: CreateIntentBody,
  timeoutMs: number = SUBMIT_TIMEOUT_MS,
): Promise<IntentPaymentResponse> {
  let res: Response;
  try {
    res = await fetch(`${trimBase(apiUrl)}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw fetchFailed(err);
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

export interface HealthResponse {
  ok?: boolean;
  /** Rail the server was started with (RAIL). Absent on servers that predate it. */
  rail?: string;
}

/** Short timeout for the startup health check so a down or hung API fails fast. */
export const HEALTH_TIMEOUT_MS = 5_000;

/** GET /health. Throws ApiClientError `api_unreachable` (network/timeout) or `health_check_failed` (non-2xx). */
export async function getHealth(apiUrl: string, timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<HealthResponse> {
  const url = `${trimBase(apiUrl)}/health`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    const detail = err instanceof Error ? `${err.message}${cause}` : String(err);
    throw new ApiClientError(`api_unreachable: GET ${url} failed (${detail}); is the API running?`);
  }
  let body: unknown;
  try {
    body = await assertOk(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiClientError(`health_check_failed: GET ${url} -> HTTP ${res.status} (${detail})`, res.status);
  }
  return body !== null && typeof body === 'object' ? (body as HealthResponse) : {};
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
