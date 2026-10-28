import { createHash } from 'node:crypto';
import type { PaymentAdapter, PaymentIntent, Receipt, ReceiptStatus } from '@agent-pay/core';
import { validateIntent } from './validate.ts';

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

export class PayPalApiError extends Error {
  readonly status: number;
  readonly code: PayPalErrorCode;
  readonly issue?: string;
  readonly debugId?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      status: number;
      code: PayPalErrorCode;
      name?: string;
      issue?: string;
      debugId?: string;
      retryable: boolean;
    },
  ) {
    super(message);
    this.name = opts.name ?? 'PayPalApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.issue = opts.issue;
    this.debugId = opts.debugId;
    this.retryable = opts.retryable;
  }
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (error: unknown, context: { intentId: string; op: 'token' | 'create' | 'capture' | 'refund' }) => void;
}

const DEFAULT_BASE_URL = 'https://api-m.sandbox.paypal.com';

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

function truncate127(value: string): string {
  return value.length <= 127 ? value : value.slice(0, 127);
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
  details?: Array<{ issue?: string; description?: string }>;
  error?: string;
  error_description?: string;
}

async function parsePayPalError(response: Response): Promise<PayPalApiError> {
  const status = response.status;
  const code = codeFromStatus(status);
  let body: PayPalErrorBody | null = null;
  const text = await response.text();
  try {
    body = JSON.parse(text) as PayPalErrorBody;
  } catch {
    return new PayPalApiError(`PayPal API error (${status})`, {
      status,
      code,
      retryable: isRetryableCode(code),
    });
  }

  if (body.error) {
    const message = body.error_description ?? body.error ?? `PayPal OAuth error (${status})`;
    return new PayPalApiError(message, {
      status,
      code,
      name: body.error,
      retryable: isRetryableCode(code),
    });
  }

  const message = body.message ?? `PayPal API error (${status})`;
  const issue = body.details?.[0]?.issue;
  return new PayPalApiError(message, {
    status,
    code,
    name: body.name,
    issue,
    debugId: body.debug_id,
    retryable: isRetryableCode(code),
  });
}

function mapCaptureStatus(status: string): ReceiptStatus {
  switch (status) {
    case 'COMPLETED':
      return 'succeeded';
    case 'PENDING':
      return 'pending';
    case 'DECLINED':
    case 'FAILED':
      return 'failed';
    default:
      return 'failed';
  }
}

function mapRefundStatus(status: string): ReceiptStatus {
  switch (status) {
    case 'COMPLETED':
      return 'refunded';
    case 'PENDING':
      return 'pending';
    case 'FAILED':
    case 'CANCELLED':
      return 'failed';
    default:
      return 'failed';
  }
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export function createPayPalAdapter(config: PayPalConfig): PaymentAdapter {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  const nowMs = config.now ?? (() => Date.now());
  const onError = config.onError;

  let tokenCache: TokenCache | null = null;

  function invalidateToken(): void {
    tokenCache = null;
  }

  async function fetchAccessToken(): Promise<string> {
    const now = nowMs();
    if (tokenCache && now < tokenCache.expiresAt) {
      return tokenCache.accessToken;
    }

    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await fetchFn(`${baseUrl}/v1/oauth2/token`, {
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

    const response = await fetchFn(`${baseUrl}${path}`, { ...requestInit, headers });

    if (response.status === 401 && retryOn401) {
      invalidateToken();
      const newToken = await fetchAccessToken();
      headers.set('Authorization', `Bearer ${newToken}`);
      return fetchFn(`${baseUrl}${path}`, { ...requestInit, headers });
    }

    return response;
  }

  return {
    rail: 'paypal',

    async pay(intent: PaymentIntent): Promise<Receipt> {
      validateIntent(intent);

      const at = new Date(nowMs()).toISOString();
      let orderId = '';

      const fail = (
        error: unknown,
        op: 'token' | 'create' | 'capture',
        externalId: string,
      ): Receipt => {
        onError?.(error, { intentId: intent.id, op });
        return {
          intentId: intent.id,
          rail: 'paypal',
          externalId,
          status: 'failed',
          at,
        };
      };

      try {
        await fetchAccessToken();
      } catch (error) {
        return fail(error, 'token', '');
      }

      let createResponse: Response;
      try {
        createResponse = await apiCall('/v2/checkout/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            'PayPal-Request-Id': requestId(intent.id, 'create'),
          },
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [
              {
                reference_id: intent.id,
                description: truncate127(intent.purpose),
                custom_id: truncate127(intent.agentId),
                amount: {
                  currency_code: intent.currency,
                  value: formatAmount(intent.amount),
                },
              },
            ],
          }),
        });
      } catch (error) {
        return fail(error, 'create', '');
      }

      if (!createResponse.ok) {
        return fail(await parsePayPalError(createResponse), 'create', '');
      }

      let order: { id: string; status: string };
      try {
        order = (await createResponse.json()) as { id: string; status: string };
      } catch (error) {
        return fail(error, 'create', '');
      }
      orderId = order.id;

      let captureResponse: Response;
      try {
        captureResponse = await apiCall(`/v2/checkout/orders/${orderId}/capture`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            'PayPal-Request-Id': requestId(intent.id, 'capture'),
          },
          body: '{}',
        });
      } catch (error) {
        return fail(error, 'capture', orderId);
      }

      if (!captureResponse.ok) {
        return fail(await parsePayPalError(captureResponse), 'capture', orderId);
      }

      let captureBody: {
        id: string;
        status: string;
        purchase_units?: Array<{
          payments?: {
            captures?: Array<{ id: string; status: string }>;
          };
        }>;
      };
      try {
        captureBody = (await captureResponse.json()) as typeof captureBody;
      } catch (error) {
        return fail(error, 'capture', orderId);
      }

      const capture = captureBody.purchase_units?.[0]?.payments?.captures?.[0];
      if (!capture?.id) {
        const err = new PayPalApiError('PayPal capture response missing capture id', {
          status: captureResponse.status,
          code: 'UNKNOWN',
          retryable: false,
        });
        return fail(err, 'capture', orderId);
      }

      return {
        intentId: intent.id,
        rail: 'paypal',
        externalId: capture.id,
        status: mapCaptureStatus(capture.status),
        at,
      };
    },

    async refund(receipt: Receipt): Promise<Receipt> {
      if (receipt.rail !== 'paypal') {
        throw new Error('Cannot refund a receipt from another rail');
      }
      if (receipt.status !== 'succeeded') {
        throw new Error('Only succeeded receipts can be refunded');
      }

      const at = new Date(nowMs()).toISOString();

      let refundResponse: Response;
      try {
        refundResponse = await apiCall(`/v2/payments/captures/${receipt.externalId}/refund`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            'PayPal-Request-Id': requestId(receipt.intentId, 'refund'),
          },
          body: '{}',
        });
      } catch (error) {
        onError?.(error, { intentId: receipt.intentId, op: 'refund' });
        return {
          intentId: receipt.intentId,
          rail: 'paypal',
          externalId: receipt.externalId,
          status: 'failed',
          at,
        };
      }

      if (!refundResponse.ok) {
        onError?.(await parsePayPalError(refundResponse), {
          intentId: receipt.intentId,
          op: 'refund',
        });
        return {
          intentId: receipt.intentId,
          rail: 'paypal',
          externalId: receipt.externalId,
          status: 'failed',
          at,
        };
      }

      let refundBody: { id: string; status: string };
      try {
        refundBody = (await refundResponse.json()) as { id: string; status: string };
      } catch (error) {
        onError?.(error, { intentId: receipt.intentId, op: 'refund' });
        return {
          intentId: receipt.intentId,
          rail: 'paypal',
          externalId: receipt.externalId,
          status: 'failed',
          at,
        };
      }

      return {
        intentId: receipt.intentId,
        rail: 'paypal',
        externalId: refundBody.id,
        status: mapRefundStatus(refundBody.status),
        at,
      };
    },
  };
}
