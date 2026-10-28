import type { PaymentIntent } from '@agent-pay/core';

export class AdapterValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'AdapterValidationError';
    this.field = field;
  }
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdapterValidationError(field, `${field} is required`);
  }
}

export function validateIntent(intent: PaymentIntent): void {
  requireNonEmpty(intent.id, 'id');
  requireNonEmpty(intent.agentId, 'agentId');
  requireNonEmpty(intent.payee, 'payee');

  if (typeof intent.amount !== 'number' || !Number.isFinite(intent.amount) || intent.amount <= 0) {
    throw new AdapterValidationError('amount', 'amount must be a finite number greater than 0');
  }

  if (typeof intent.currency !== 'string' || intent.currency === '') {
    throw new AdapterValidationError('currency', 'currency is required');
  }
  if (!/^[A-Z]{3}$/.test(intent.currency)) {
    throw new AdapterValidationError('currency', 'currency must be a 3-letter uppercase ISO code');
  }

  if (intent.createdAt === undefined || intent.createdAt === null || intent.createdAt === '') {
    throw new AdapterValidationError('createdAt', 'createdAt is required');
  }
}
