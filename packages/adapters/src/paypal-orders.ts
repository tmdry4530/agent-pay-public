import type { PaymentAdapter, PaymentIntent, Receipt, ReceiptStatus } from '@agent-pay/core';
import { validateIntent } from './validate.ts';
import {
  createPayPalHttp,
  formatAmount,
  parsePayPalError,
  PayPalApiError,
  requestId,
  truncate127,
  type PayPalConfig,
} from './paypal-client.ts';

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

function firstCaptureFromOrderBody(body: {
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{ id: string; status: string }>;
    };
  }>;
}): { id: string; status: string } | undefined {
  for (const unit of body.purchase_units ?? []) {
    const capture = unit.payments?.captures?.[0];
    if (capture?.id) {
      return capture;
    }
  }
  return undefined;
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

export function createPayPalOrdersAdapter(config: PayPalConfig): PaymentAdapter {
  const http = createPayPalHttp(config);
  const { nowMs, onError, apiCall } = http;

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

      const pendingUnknown = (
        error: unknown,
        op: 'create' | 'capture',
        externalId: string,
      ): Receipt => {
        onError?.(error, { intentId: intent.id, op });
        return {
          intentId: intent.id,
          rail: 'paypal',
          externalId,
          status: 'pending',
          at,
        };
      };

      try {
        await http.fetchAccessToken();
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
        return pendingUnknown(error, 'create', '');
      }

      if (!createResponse.ok) {
        const err = await parsePayPalError(createResponse);
        if (createResponse.status >= 500) {
          return pendingUnknown(err, 'create', '');
        }
        return fail(err, 'create', '');
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
        return pendingUnknown(error, 'capture', orderId);
      }

      if (!captureResponse.ok) {
        const err = await parsePayPalError(captureResponse);
        if (captureResponse.status >= 500) {
          return pendingUnknown(err, 'capture', orderId);
        }
        return fail(err, 'capture', orderId);
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

      const capture = firstCaptureFromOrderBody(captureBody);
      if (!capture) {
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
