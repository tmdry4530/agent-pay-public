import { randomUUID } from 'node:crypto';
import {
  createNearAdapter,
  createNearRpcClient,
  createPayPalAdapter,
  nearConfigFromEnv,
  payPalConfigFromEnv,
} from '@agent-pay/adapters';
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
 * PayPal sandbox (packages/adapters, 개발팀3). Credentials come only from the
 * environment (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, optional PAYPAL_BASE_URL);
 * missing ones fail at startup. No network call happens until the first pay().
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

export const nearFactory: AdapterFactory = (ctx) => {
  let config;
  try {
    config = nearConfigFromEnv({ ...ctx.env });
  } catch (err) {
    throw new AdapterConfigError(`adapter_config: ${err instanceof Error ? err.message : String(err)} (RAIL=near)`);
  }
  let client;
  try {
    client = createNearRpcClient({
      rpcUrl: config.rpcUrl,
      accountId: config.accountId,
      privateKey: config.privateKey,
    });
  } catch (err) {
    throw new AdapterConfigError(`adapter_config: ${err instanceof Error ? err.message : String(err)} (RAIL=near)`);
  }
  return createNearAdapter({ client, networkId: config.networkId, now: ctx.now });
};

/**
 * Rail -> factory. `undefined` means the rail is known but not wired yet.
 * 개발팀3: wire a rail by replacing its `undefined` with a factory, e.g.
 *   near: nearFactory (createNearAdapter + nearConfigFromEnv from @agent-pay/adapters),
 */
export const adapterRegistry: Record<Rail, AdapterFactory | undefined> = {
  mock: (ctx) => createMockAdapter(ctx),
  paypal: paypalFactory,
  near: nearFactory,
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
