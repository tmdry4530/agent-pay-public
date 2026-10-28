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

/**
 * Env var NAMES each credentialed rail requires (mirrors payPalConfigFromEnv / nearConfigFromEnv in
 * packages/adapters, which throw on the first blank one). Optional ones (PAYPAL_BASE_URL, NEAR_NETWORK,
 * NEAR_RPC_URL) are not listed.
 */
export const RAIL_REQUIRED_ENV: Readonly<Partial<Record<Rail, readonly string[]>>> = {
  paypal: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
  near: ['NEAR_ACCOUNT_ID', 'NEAR_PRIVATE_KEY'],
};

export interface AdapterConfigErrorOptions {
  cause?: unknown;
  /** Names (never values) of required env vars that are blank. Read by startup-error.ts. */
  missing?: readonly string[];
}

export class AdapterConfigError extends Error {
  override name = 'AdapterConfigError';
  /** Names of missing required env vars, when the failure is missing configuration. */
  readonly missing?: readonly string[];
  constructor(message: string, options: AdapterConfigErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    if (options.missing && options.missing.length > 0) this.missing = [...options.missing];
  }
}

/** Required env names for `rail` that are unset or blank in `env`. */
export function missingRequiredEnv(rail: Rail, env: AdapterContext['env']): string[] {
  return (RAIL_REQUIRED_ENV[rail] ?? []).filter((name) => (env[name] ?? '').trim() === '');
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
    throw new AdapterConfigError(`adapter_config: ${err instanceof Error ? err.message : String(err)} (RAIL=paypal)`, {
      missing: missingRequiredEnv('paypal', ctx.env),
    });
  }
  return createPayPalAdapter(config);
};

export const nearFactory: AdapterFactory = (ctx) => {
  let config;
  try {
    config = nearConfigFromEnv({ ...ctx.env });
  } catch (err) {
    throw new AdapterConfigError(`adapter_config: ${err instanceof Error ? err.message : String(err)} (RAIL=near)`, {
      missing: missingRequiredEnv('near', ctx.env),
    });
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

/** Rail -> factory. `undefined` means the rail is known but not wired yet (all three are wired now). */
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
