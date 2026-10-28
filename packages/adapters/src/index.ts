export type {
  Currency,
  PaymentAdapter,
  PaymentIntent,
  Rail,
  Receipt,
  ReceiptStatus,
} from '@agent-pay/core';
export { AdapterValidationError, validateIntent } from './validate.ts';
export { createMockAdapter, type MockAdapterOptions } from './mock.ts';
export {
  createPayPalAdapter,
  isValidEmail,
  mapPayoutStatus,
  payPalConfigFromEnv,
  formatAmount,
  requestId,
  PayPalApiError,
  type PayPalConfig,
  type PayPalErrorCode,
} from './paypal.ts';
export { createPayPalOrdersAdapter } from './paypal-orders.ts';
