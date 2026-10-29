import type { PaymentIntent, Receipt, ReceiptStatus } from '@agent-pay/core';
import type { AdapterReceipt, StatusCapableAdapter } from './adapter-types.ts';
import { AdapterValidationError, validateIntent } from './validate.ts';
import {
  createPayPalHttp,
  formatAmount,
  parsePayPalError,
  PayPalApiError,
  type PayPalConfig,
} from './paypal-client.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(s: string): boolean {
  return s.length <= 254 && EMAIL_RE.test(s);
}

export function mapPayoutStatus(batchStatus: string, itemStatus?: string): ReceiptStatus {
  if (itemStatus !== undefined && itemStatus !== '') {
    switch (itemStatus) {
      case 'SUCCESS':
        return 'succeeded';
      case 'PENDING':
      case 'UNCLAIMED':
      case 'ONHOLD':
        return 'pending';
      case 'REFUNDED':
        return 'refunded';
      case 'FAILED':
      case 'RETURNED':
      case 'BLOCKED':
      case 'REVERSED':
        return 'failed';
      default:
        return 'failed';
    }
  }

  switch (batchStatus) {
    case 'SUCCESS':
      return 'succeeded';
    case 'PENDING':
    case 'PROCESSING':
      return 'pending';
    case 'DENIED':
    case 'CANCELED':
      return 'failed';
    default:
      return 'failed';
  }
}

interface PayoutBatchHeader {
  payout_batch_id?: string;
  batch_status?: string;
  sender_batch_header?: { sender_batch_id?: string };
}

interface PayoutItem {
  payout_item_id?: string;
  transaction_status?: string;
}

interface PayoutCreateResponse {
  batch_header?: PayoutBatchHeader;
  items?: PayoutItem[];
  links?: Array<{ href?: string; rel?: string }>;
}

interface PayoutBatchResponse {
  batch_header?: PayoutBatchHeader;
  items?: PayoutItem[];
}

interface PayPalNamedErrorBody extends PayoutCreateResponse {
  name?: string;
  message?: string;
  details?: Array<{ issue?: string; description?: string }>;
}

const PAYOUT_BATCH_LINK_RE = /\/v1\/payments\/payouts\/([^/?#]+)/;

function metaFromPayout(
  batchStatus: string | undefined,
  item: PayoutItem | undefined,
  extra?: Record<string, string>,
): Record<string, string> | undefined {
  const meta: Record<string, string> = { ...extra };
  if (batchStatus !== undefined && batchStatus !== '') {
    meta.batchStatus = batchStatus;
  }
  const payoutItemId = item?.payout_item_id;
  if (payoutItemId !== undefined && payoutItemId !== '') {
    meta.payoutItemId = payoutItemId;
  }
  const transactionStatus = item?.transaction_status;
  if (transactionStatus !== undefined && transactionStatus !== '') {
    meta.transactionStatus = transactionStatus;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function payoutBatchItemCount(body: PayoutCreateResponse | PayoutBatchResponse): number {
  return body.items?.length ?? 0;
}

function receiptMismatchMultiItemError(externalId: string, itemCount: number): Error {
  return new Error(
    `receipt_mismatch: PayPal batch ${externalId} has ${itemCount} items; this adapter sends exactly one`,
  );
}

function receiptFromBatchBody(
  intentId: string,
  body: PayoutCreateResponse | PayoutBatchResponse,
  at: string,
  extraMeta?: Record<string, string>,
): AdapterReceipt {
  const batchHeader = body.batch_header;
  const payoutBatchId = batchHeader?.payout_batch_id ?? '';
  const batchStatus = batchHeader?.batch_status ?? '';
  const item = body.items?.[0];
  return {
    intentId,
    rail: 'paypal',
    externalId: payoutBatchId,
    status: mapPayoutStatus(batchStatus, item?.transaction_status),
    at,
    meta: metaFromPayout(batchStatus, item, extraMeta),
  };
}

function pendingMultiItemMismatchReceipt(
  intentId: string,
  body: PayoutCreateResponse | PayoutBatchResponse,
  at: string,
  extraMeta?: Record<string, string>,
): AdapterReceipt {
  const batchHeader = body.batch_header;
  const payoutBatchId = batchHeader?.payout_batch_id ?? '';
  const batchStatus = batchHeader?.batch_status ?? '';
  const itemCount = payoutBatchItemCount(body);
  const item = body.items?.[0];
  return {
    intentId,
    rail: 'paypal',
    externalId: payoutBatchId,
    status: 'pending',
    at,
    meta: metaFromPayout(batchStatus, item, {
      ...extraMeta,
      needsManualResolve: 'true',
      errorName: 'receipt_mismatch',
      itemCount: String(itemCount),
    }),
  };
}

function isDuplicateSenderBatchError(
  status: number,
  bodyText: string,
  parsed: PayPalNamedErrorBody | null,
): boolean {
  if (status < 400 || status >= 500) {
    return false;
  }
  const haystack = [
    parsed?.name,
    parsed?.message,
    bodyText,
  ]
    .filter(Boolean)
    .join(' ');
  const lower = haystack.toLowerCase();
  if (
    lower.includes('sender_batch_id') ||
    lower.includes('sender_batch_id_already_used') ||
    lower.includes('duplicate')
  ) {
    return true;
  }
  for (const d of parsed?.details ?? []) {
    const issue = d.issue?.toLowerCase() ?? '';
    if (issue.includes('sender_batch') || issue.includes('duplicate')) {
      return true;
    }
  }
  return false;
}

function paypalErrorNameForMeta(error: unknown): string | undefined {
  if (error instanceof PayPalApiError) {
    const n = error.name;
    if (n !== '' && n !== 'PayPalApiError') {
      return n;
    }
  }
  return undefined;
}

function buildPendingUnknownMeta(
  error: unknown,
  extraMeta?: Record<string, string>,
): Record<string, string> {
  const meta: Record<string, string> = {
    unknownOutcome: 'true',
    needsManualResolve: 'true',
    ...extraMeta,
  };
  const fromError = paypalErrorNameForMeta(error);
  if (fromError !== undefined && meta.errorName === undefined) {
    meta.errorName = fromError;
  }
  return meta;
}

function buildPendingUnknownBatchMeta(
  error: unknown,
  extraMeta?: Record<string, string>,
): Record<string, string> {
  const meta: Record<string, string> = {
    unknownOutcome: 'true',
    ...extraMeta,
  };
  const fromError = paypalErrorNameForMeta(error);
  if (fromError !== undefined && meta.errorName === undefined) {
    meta.errorName = fromError;
  }
  return meta;
}

function extractBatchIdFromDuplicateError(
  parsed: PayPalNamedErrorBody | null,
  bodyText: string,
): string | null {
  const links = parsed?.links ?? [];
  for (const link of links) {
    const href = link.href ?? '';
    const match = PAYOUT_BATCH_LINK_RE.exec(href);
    if (match?.[1]) {
      return match[1];
    }
  }
  const match = PAYOUT_BATCH_LINK_RE.exec(bodyText);
  return match?.[1] ?? null;
}

export function createPayPalAdapter(config: PayPalConfig): StatusCapableAdapter {
  const http = createPayPalHttp(config);
  const { nowMs, onError, apiCall } = http;

  async function getPayoutBatch(
    batchId: string,
    intentId: string,
    extraMeta?: Record<string, string>,
  ): Promise<AdapterReceipt> {
    const at = new Date(nowMs()).toISOString();
    const pendingUnknownBatch = (
      error: unknown,
      more?: Record<string, string>,
    ): AdapterReceipt => ({
      intentId,
      rail: 'paypal',
      externalId: batchId,
      status: 'pending',
      at,
      meta: buildPendingUnknownBatchMeta(error, { ...extraMeta, ...more }),
    });
    let response: Response;
    try {
      response = await apiCall(`/v1/payments/payouts/${batchId}`, { method: 'GET' });
    } catch (error) {
      onError?.(error, { intentId, op: 'payout' });
      return pendingUnknownBatch(error);
    }
    if (!response.ok) {
      const err = await parsePayPalError(response);
      onError?.(err, { intentId, op: 'payout' });
      return pendingUnknownBatch(err);
    }
    let body: PayoutBatchResponse;
    try {
      body = (await response.json()) as PayoutBatchResponse;
    } catch (error) {
      onError?.(error, { intentId, op: 'payout' });
      return pendingUnknownBatch(error);
    }
    const itemCount = payoutBatchItemCount(body);
    if (itemCount >= 2) {
      const payoutBatchId = body.batch_header?.payout_batch_id ?? batchId;
      const mismatch = receiptMismatchMultiItemError(payoutBatchId, itemCount);
      // Do not throw: a failed pay receipt frees the daily limit and could double-pay.
      onError?.(mismatch, { intentId, op: 'payout' });
      return pendingMultiItemMismatchReceipt(intentId, body, at, extraMeta);
    }
    return receiptFromBatchBody(intentId, body, at, extraMeta);
  }

  return {
    rail: 'paypal',

    async pay(intent: PaymentIntent): Promise<AdapterReceipt> {
      validateIntent(intent);
      if (!isValidEmail(intent.payee)) {
        throw new AdapterValidationError('payee', 'payee must be a valid email address');
      }

      const at = new Date(nowMs()).toISOString();

      const fail = (error: unknown, op: 'token' | 'payout'): AdapterReceipt => {
        onError?.(error, { intentId: intent.id, op });
        return {
          intentId: intent.id,
          rail: 'paypal',
          externalId: '',
          status: 'failed',
          at,
        };
      };

      // Never record a duplicate-guess as failed: if it was a real duplicate the first payout may have gone out, and failing it frees the daily limit, so the agent could pay twice. An operator settles these via POST /intents/:id/resolve (planned).
      const pendingUnknown = (
        error: unknown,
        extraMeta?: Record<string, string>,
      ): AdapterReceipt => {
        onError?.(error, { intentId: intent.id, op: 'payout' });
        return {
          intentId: intent.id,
          rail: 'paypal',
          externalId: '',
          status: 'pending',
          at,
          meta: buildPendingUnknownMeta(error, extraMeta),
        };
      };

      try {
        await http.fetchAccessToken();
      } catch (error) {
        return fail(error, 'token');
      }

      let payoutResponse: Response;
      try {
        payoutResponse = await apiCall('/v1/payments/payouts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sender_batch_header: {
              sender_batch_id: intent.id,
              email_subject: 'You have a payment',
              email_message: intent.purpose,
            },
            items: [
              {
                recipient_type: 'EMAIL',
                receiver: intent.payee,
                amount: {
                  value: formatAmount(intent.amount),
                  currency: intent.currency,
                },
                note: intent.purpose,
                sender_item_id: intent.id,
              },
            ],
          }),
        });
      } catch (error) {
        return pendingUnknown(error);
      }

      if (payoutResponse.status >= 500) {
        return pendingUnknown(await parsePayPalError(payoutResponse));
      }

      if (!payoutResponse.ok) {
        const bodyText = await payoutResponse.text();
        let parsed: PayPalNamedErrorBody | null = null;
        try {
          parsed = JSON.parse(bodyText) as PayPalNamedErrorBody;
        } catch {
          parsed = null;
        }

        if (isDuplicateSenderBatchError(payoutResponse.status, bodyText, parsed)) {
          const batchId = extractBatchIdFromDuplicateError(parsed, bodyText);
          const duplicateMeta: Record<string, string> = { duplicateSenderBatchId: 'true' };
          const parsedName = parsed?.name;
          if (parsedName !== undefined && parsedName !== '') {
            duplicateMeta.errorName = parsedName;
          }
          if (batchId) {
            return getPayoutBatch(batchId, intent.id, duplicateMeta);
          }
          return pendingUnknown(
            parsed ?? new Error('Duplicate sender_batch_id without batch link'),
            duplicateMeta,
          );
        }

        const err = parsed
          ? await parsePayPalError(
              new Response(bodyText, {
                status: payoutResponse.status,
                headers: payoutResponse.headers,
              }),
            )
          : new Error(`PayPal payout error (${payoutResponse.status})`);
        return fail(err, 'payout');
      }

      let body: PayoutCreateResponse;
      try {
        body = (await payoutResponse.json()) as PayoutCreateResponse;
      } catch (error) {
        return pendingUnknown(error);
      }

      const payoutBatchId = body.batch_header?.payout_batch_id;
      if (payoutBatchId === undefined || payoutBatchId === '') {
        return pendingUnknown(new Error('PayPal payout response missing payout_batch_id'));
      }

      const itemCount = payoutBatchItemCount(body);
      if (itemCount >= 2) {
        const mismatch = receiptMismatchMultiItemError(payoutBatchId, itemCount);
        // Do not throw: a failed pay receipt frees the daily limit and could double-pay.
        onError?.(mismatch, { intentId: intent.id, op: 'payout' });
        return pendingMultiItemMismatchReceipt(intent.id, body, at);
      }

      return receiptFromBatchBody(intent.id, body, at);
    },

    async status(receipt: Receipt): Promise<AdapterReceipt> {
      if (receipt.rail !== 'paypal') {
        throw new Error('Cannot check status for a receipt from another rail');
      }
      if (receipt.externalId === '') {
        return receipt;
      }

      const at = new Date(nowMs()).toISOString();
      let response: Response;
      try {
        response = await apiCall(`/v1/payments/payouts/${receipt.externalId}`, {
          method: 'GET',
        });
      } catch (error) {
        onError?.(error, { intentId: receipt.intentId, op: 'status' });
        return receipt;
      }

      if (!response.ok) {
        onError?.(await parsePayPalError(response), {
          intentId: receipt.intentId,
          op: 'status',
        });
        return receipt;
      }

      let body: PayoutBatchResponse;
      try {
        body = (await response.json()) as PayoutBatchResponse;
      } catch (error) {
        onError?.(error, { intentId: receipt.intentId, op: 'status' });
        return receipt;
      }

      const batchStatus = body.batch_header?.batch_status ?? '';
      const itemCount = payoutBatchItemCount(body);
      if (itemCount >= 2) {
        const mismatch = receiptMismatchMultiItemError(receipt.externalId, itemCount);
        onError?.(mismatch, { intentId: receipt.intentId, op: 'status' });
        throw mismatch;
      }
      const item = body.items?.[0];
      return {
        intentId: receipt.intentId,
        rail: 'paypal',
        externalId: receipt.externalId,
        status: mapPayoutStatus(batchStatus, item?.transaction_status),
        at,
        meta: metaFromPayout(batchStatus, item),
      };
    },
  };
}

export type { PayPalConfig } from './paypal-client.ts';
export {
  payPalConfigFromEnv,
  formatAmount,
  requestId,
  PayPalApiError,
  type PayPalErrorCode,
} from './paypal-client.ts';
