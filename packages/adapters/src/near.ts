import type { PaymentIntent, Receipt, ReceiptStatus } from '@agent-pay/core';
import type { AdapterReceipt, StatusCapableAdapter } from './adapter-types.ts';
import type { NearNetworkId } from './near-account.ts';
import type { NearClient, NearStatusResult } from './near-rpc.ts';
import { isAcceptedPayee } from './near-account.ts';
import { parseNearToYocto } from './near-units.ts';
import { AdapterValidationError } from './validate.ts';

export interface NearAdapterOptions {
  client: NearClient;
  /** Defaults to testnet. Named payees must use that network's suffix. */
  networkId?: NearNetworkId;
  now?: () => Date;
  onError?: (error: unknown, context: { intentId: string; op: 'send' | 'status' }) => void;
}

/**
 * Native NEAR transfer adapter. There is no `refund`: a signed transfer cannot
 * be reversed by the payer. `validateIntent` is not used because it requires a
 * 3-letter ISO currency and NEAR is not one.
 */
export function createNearAdapter(opts: NearAdapterOptions): StatusCapableAdapter {
  const client = opts.client;
  const networkId = opts.networkId ?? 'testnet';
  const now = opts.now ?? (() => new Date());
  const onError = opts.onError;

  return {
    rail: 'near',

    async pay(intent: PaymentIntent): Promise<AdapterReceipt> {
      const amountYocto = validateNearPay(intent, networkId, client.accountId);
      const meta: Record<string, string> = {
        amountYocto,
        receiverId: intent.payee,
        network: networkId,
      };
      try {
        const result = await client.sendTransfer({
          receiverId: intent.payee,
          amountYocto,
        });
        if (result.kind === 'final') {
          if (!result.success) {
            onError?.(result.failure, { intentId: intent.id, op: 'send' });
          }
          return receipt(intent.id, result.success ? 'succeeded' : 'failed', result.txHash, meta, now());
        }
        if (result.kind === 'rejected') {
          onError?.(result.error, { intentId: intent.id, op: 'send' });
          return receipt(intent.id, 'failed', result.txHash ?? '', meta, now());
        }
        onError?.(result.error, { intentId: intent.id, op: 'send' });
        return receipt(intent.id, 'pending', result.txHash ?? '', { ...meta, unknownOutcome: 'true' }, now());
      } catch (error) {
        onError?.(error, { intentId: intent.id, op: 'send' });
        return receipt(intent.id, 'pending', '', { ...meta, unknownOutcome: 'true' }, now());
      }
    },

    async status(receiptIn: Receipt): Promise<AdapterReceipt> {
      if (receiptIn.rail !== 'near') {
        throw new Error('Cannot query status for a receipt from another rail');
      }
      if (receiptIn.externalId === '') {
        return receiptIn;
      }
      let result: NearStatusResult;
      try {
        result = await client.txStatus(receiptIn.externalId);
      } catch (error) {
        onError?.(error, { intentId: receiptIn.intentId, op: 'status' });
        return receiptIn;
      }
      if (result.kind === 'unknown') {
        onError?.(result.error, { intentId: receiptIn.intentId, op: 'status' });
        return receiptIn;
      }
      // notFound: the tx may not have propagated yet. Leave pending for a later
      // check. A transfer that stays unknown needs a manual lookup.
      if (result.kind === 'notFound') {
        return receiptIn;
      }
      const prior = receiptIn as AdapterReceipt;
      const updated: AdapterReceipt = {
        intentId: receiptIn.intentId,
        rail: 'near',
        externalId: receiptIn.externalId,
        status: result.success ? 'succeeded' : 'failed',
        at: now().toISOString(),
      };
      if (prior.meta) {
        updated.meta = { ...prior.meta };
      }
      return updated;
    },
  };
}

function receipt(
  intentId: string,
  status: ReceiptStatus,
  externalId: string,
  meta: Record<string, string>,
  at: Date,
): AdapterReceipt {
  return {
    intentId,
    rail: 'near',
    externalId,
    status,
    at: at.toISOString(),
    meta,
  };
}

function validateNearPay(intent: PaymentIntent, networkId: NearNetworkId, signerId: string): string {
  requireNonEmpty(intent.id, 'id');
  requireNonEmpty(intent.agentId, 'agentId');
  requireNonEmpty(intent.purpose, 'purpose');
  if (intent.createdAt === undefined || intent.createdAt === null || intent.createdAt === '') {
    throw new AdapterValidationError('createdAt', 'createdAt is required');
  }
  if (typeof intent.currency !== 'string' || intent.currency.toUpperCase() !== 'NEAR') {
    throw new AdapterValidationError('currency', 'currency must be NEAR');
  }
  let amountYocto: string;
  try {
    amountYocto = parseNearToYocto(intent.amount);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'amount must be greater than 0';
    throw new AdapterValidationError('amount', message);
  }
  requireNonEmpty(intent.payee, 'payee');
  if (!isAcceptedPayee(intent.payee, networkId)) {
    throw new AdapterValidationError('payee', 'payee is not an accepted NEAR account for this network');
  }
  if (intent.payee === signerId) {
    throw new AdapterValidationError('payee', 'payee must not equal the signer account');
  }
  return amountYocto;
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdapterValidationError(field, `${field} is required`);
  }
}
