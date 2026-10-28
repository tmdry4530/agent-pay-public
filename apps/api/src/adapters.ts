import { randomUUID } from 'node:crypto';
import { createPayPalAdapter, payPalConfigFromEnv } from '@agent-pay/adapters';
import type { PaymentAdapter, PaymentIntent, Rail, Receipt } from '@agent-pay/core';

export const RAILS: readonly Rail[] = ['mock', 'paypal', 'near'];

export interface AdapterContext {
  /** Environment the server was started with (read config like sandbox keys from here). */
  env: Readonly<Record<string, string | undefined>>;
  /** Clock for receipt timestamps. */
  now: () => Date;
}

/** Builds the adapter for one rail. May be async (e.g. to fetch an OAuth token). */
export type AdapterFactory = (ctx: AdapterContext) => PaymentAdapter | Promise<PaymentAdapter>;

export class AdapterConfigError extends Error {
  override name = 'AdapterConfigError';
}

/** Mock rail: every payment succeeds immediately. For demos and tests only. */
export function createMockAdapter(ctx: Pick<AdapterContext, 'now'> = { now: () => new Date() }): PaymentAdapter {
  return {
    rail: 'mock',
    async pay(intent: PaymentIntent): Promise<Receipt> {
      return {
        intentId: intent.id,
        rail: 'mock',
        externalId: `mock_${randomUUID()}`,
        status: 'succeeded',
        at: ctx.now().toISOString(),
      };
    },
    async refund(receipt: Receipt): Promise<Receipt> {
      return { ...receipt, externalId: `mock_refund_${randomUUID()}`, status: 'refunded', at: ctx.now().toISOString() };
    },
  };
}

/**
 * PayPal Payouts adapter (packages/adapters `createPayPalAdapter`). Payee must be
 * an email address. Credentials from PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and
 * optional PAYPAL_BASE_URL; missing required vars fail at factory time. No network
 * until the first pay().
 */
export const paypalFactory: AdapterFactory = (ctx) => {
  let config;
  try {
    config = payPalConfigFromEnv({ ...ctx.env });
  } catch (err) {
    throw new AdapterConfigError(`adapter_config: ${err instanceof Error ? err.message : String(err)} (RAIL=paypal)`);
  }
  return createPayPalAdapter(config);
};

/**
 * Rail -> factory. `undefined` means the rail is known but not wired yet.
 * 개발팀3: wire a rail by replacing its `undefined` with a factory, e.g.
 *   near: (ctx) => createNearTestnetAdapter(nearConfigFromEnv(ctx.env)),
 */
export const adapterRegistry: Record<Rail, AdapterFactory | undefined> = {
  mock: (ctx) => createMockAdapter(ctx),
  paypal: paypalFactory,
  near: undefined,
};

export function parseRail(value: string | undefined): Rail {
  const rail = value === undefined || value === '' ? 'mock' : value;
  if (!(RAILS as readonly string[]).includes(rail)) {
    throw new AdapterConfigError(`unknown_rail: RAIL must be one of ${RAILS.join('|')}, got "${rail}"`);
  }
  return rail as Rail;
}

/** Builds the adapter for `rail`. Throws AdapterConfigError when the rail is not wired. */
export async function createAdapter(
  rail: Rail,
  ctx: AdapterContext,
  registry: Record<Rail, AdapterFactory | undefined> = adapterRegistry,
): Promise<PaymentAdapter> {
  const factory = registry[rail];
  if (!factory) throw new AdapterConfigError(`adapter_not_wired: ${rail} adapter not wired yet (RAIL=${rail})`);
  const adapter = await factory(ctx);
  if (adapter.rail !== rail) {
    throw new AdapterConfigError(`adapter_mismatch: factory for ${rail} returned an adapter for ${adapter.rail}`);
  }
  return adapter;
}
