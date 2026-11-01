import { createHash } from 'node:crypto';

export type PayPalErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'NOT_AUTHORIZED'
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE_ENTITY'
  | 'RATE_LIMITED'
  | 'PAYPAL_SERVER_ERROR'
  | 'UNKNOWN';

/** One entry of a PayPal error body's `details` array (the `value` field is never kept: it can echo input). */
export interface PayPalErrorDetail {
  field?: string;
  location?: string;
  issue?: string;
  description?: string;
}

export class PayPalApiError extends Error {
  readonly status: number;
  readonly code: PayPalErrorCode;
  readonly issue?: string;
  readonly debugId?: string;
  readonly details?: PayPalErrorDetail[];
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      status: number;
      code: PayPalErrorCode;
      name?: string;
      issue?: string;
      debugId?: string;
      details?: PayPalErrorDetail[];
      retryable: boolean;
    },
  ) {
    super(message);
    this.name = opts.name ?? 'PayPalApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.issue = opts.issue;
    this.debugId = opts.debugId;
    if (opts.details !== undefined && opts.details.length > 0) this.details = opts.details;
    this.retryable = opts.retryable;
  }
}

export type PayPalOp =
  | 'token'
  | 'payout'
  | 'status'
  | 'create'
  | 'capture'
  | 'refund';

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Applied to each HTTP request via AbortSignal.timeout when set. */
  timeoutMs?: number;
  onError?: (error: unknown, context: { intentId: string; op: PayPalOp }) => void;
}

export const DEFAULT_PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com';

export function payPalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || clientId.trim() === '') {
    throw new Error('PAYPAL_CLIENT_ID environment variable is required');
  }
  if (!clientSecret || clientSecret.trim() === '') {
    throw new Error('PAYPAL_CLIENT_SECRET environment variable is required');
  }
  const config: PayPalConfig = { clientId, clientSecret };
  if (env.PAYPAL_BASE_URL && env.PAYPAL_BASE_URL.trim() !== '') {
    config.baseUrl = env.PAYPAL_BASE_URL;
  }
  return config;
}

export function formatAmount(amount: number): string {
  const cents = Math.round((amount + Number.EPSILON) * 100);
  return (cents / 100).toFixed(2);
}

export function requestId(intentId: string, op: string): string {
  const direct = `${intentId}-${op}`;
  if (direct.length <= 38) {
    return direct;
  }
  const prefix = `pp-${op}-`;
  const maxHashLen = 38 - prefix.length;
  const hash = createHash('sha256').update(intentId).digest('hex').slice(0, maxHashLen);
  return prefix + hash;
}

function codeFromStatus(status: number): PayPalErrorCode {
  if (status === 400) return 'INVALID_REQUEST';
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'NOT_AUTHORIZED';
  if (status === 404) return 'RESOURCE_NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'UNPROCESSABLE_ENTITY';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PAYPAL_SERVER_ERROR';
  return 'UNKNOWN';
}

function isRetryableCode(code: PayPalErrorCode): boolean {
  return code === 'RATE_LIMITED' || code === 'PAYPAL_SERVER_ERROR';
}

interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: Array<{ field?: unknown; location?: unknown; issue?: unknown; description?: unknown }>;
  error?: string;
  error_description?: string;
  links?: Array<{ href?: string; rel?: string }>;
}

function detailString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseDetails(raw: unknown): PayPalErrorDetail[] {
  if (!Array.isArray(raw)) return [];
  const out: PayPalErrorDetail[] = [];
  for (const d of raw.slice(0, 10)) {
    if (d === null || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    const detail: PayPalErrorDetail = {};
    const field = detailString(r.field);
    const location = detailString(r.location);
    const issue = detailString(r.issue);
    const description = detailString(r.description);
    if (field) detail.field = field;
    if (location) detail.location = location;
    if (issue) detail.issue = issue;
    if (description) detail.description = description;
    if (Object.keys(detail).length > 0) out.push(detail);
  }
  return out;
}

export async function parsePayPalError(response: Response): Promise<PayPalApiError> {
  const status = response.status;
  const code = codeFromStatus(status);
  // PayPal also sends the debug id as a response header (useful when the body is not JSON).
  const headerDebugId = response.headers.get('paypal-debug-id') ?? undefined;
  let body: PayPalErrorBody | null = null;
  const text = await response.text();
  try {
    body = JSON.parse(text) as PayPalErrorBody;
  } catch {
    body = null;
  }
  if (body === null || typeof body !== 'object') {
    return new PayPalApiError(`PayPal API error (${status})`, {
      status,
      code,
      debugId: headerDebugId,
      retryable: isRetryableCode(code),
    });
  }

  if (body.error) {
    const message = body.error_description ?? body.error ?? `PayPal OAuth error (${status})`;
    return new PayPalApiError(message, {
      status,
      code,
      name: body.error,
      debugId: body.debug_id ?? headerDebugId,
      retryable: isRetryableCode(code),
    });
  }

  const message = body.message ?? `PayPal API error (${status})`;
  const details = parseDetails(body.details);
  return new PayPalApiError(message, {
    status,
    code,
    name: body.name,
    issue: details[0]?.issue,
    debugId: body.debug_id ?? headerDebugId,
    details,
    retryable: isRetryableCode(code),
  });
}

export function isFetchUnknownOutcome(error: unknown): boolean {
  if (error instanceof PayPalApiError) {
    return error.status >= 500;
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  if (error !== null && typeof error === 'object' && 'name' in error) {
    const name = (error as { name: string }).name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      return true;
    }
  }
  return false;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export interface PayPalHttp {
  baseUrl: string;
  nowMs: () => number;
  onError: PayPalConfig['onError'];
  fetchAccessToken: () => Promise<string>;
  apiCall: (path: string, init: RequestInit & { retryOn401?: boolean }) => Promise<Response>;
  fetchWithTimeout: (url: string, init?: RequestInit) => Promise<Response>;
}

export function createPayPalHttp(config: PayPalConfig): PayPalHttp {
  const baseUrl = (config.baseUrl ?? DEFAULT_PAYPAL_BASE_URL).replace(/\/$/, '');
  const fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  const nowMs = config.now ?? (() => Date.now());
  const onError = config.onError;
  const timeoutMs = config.timeoutMs;

  let tokenCache: TokenCache | null = null;

  function invalidateToken(): void {
    tokenCache = null;
  }

  function requestSignal(existing?: AbortSignal | null): AbortSignal | undefined {
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return existing ?? undefined;
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (existing) {
      return AbortSignal.any([existing, timeoutSignal]);
    }
    return timeoutSignal;
  }

  async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const signal = requestSignal(init?.signal);
    return fetchFn(url, signal ? { ...init, signal } : init);
  }

  async function fetchAccessToken(): Promise<string> {
    const now = nowMs();
    if (tokenCache && now < tokenCache.expiresAt) {
      return tokenCache.accessToken;
    }

    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await fetchWithTimeout(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw await parsePayPalError(response);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    tokenCache = {
      accessToken: data.access_token,
      expiresAt: now + (data.expires_in - 60) * 1000,
    };
    return tokenCache.accessToken;
  }

  async function apiCall(
    path: string,
    init: RequestInit & { retryOn401?: boolean },
  ): Promise<Response> {
    const { retryOn401: retryFlag, ...requestInit } = init;
    const retryOn401 = retryFlag !== false;
    const token = await fetchAccessToken();
    const headers = new Headers(requestInit.headers);
    headers.set('Authorization', `Bearer ${token}`);

    const response = await fetchWithTimeout(`${baseUrl}${path}`, { ...requestInit, headers });

    if (response.status === 401 && retryOn401) {
      invalidateToken();
      const newToken = await fetchAccessToken();
      headers.set('Authorization', `Bearer ${newToken}`);
      return fetchWithTimeout(`${baseUrl}${path}`, { ...requestInit, headers });
    }

    return response;
  }

  return {
    baseUrl,
    nowMs,
    onError,
    fetchAccessToken,
    apiCall,
    fetchWithTimeout,
  };
}

export function truncate127(value: string): string {
  return value.length <= 127 ? value : value.slice(0, 127);
}
