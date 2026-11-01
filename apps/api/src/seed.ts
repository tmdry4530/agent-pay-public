import type { Policy, Rail } from '@agent-pay/core';
import { isAcceptedPayee, isValidEmail } from '@agent-pay/adapters';
import { DEFAULT_POLICY } from './policy-defaults.ts';
import { AdapterConfigError } from './adapters.ts';

/** Logical planner payee names used in demo scenarios. */
export const DEMO_LOGICAL_PAYEES = ['openai-api', 'anthropic-api', 'vercel', 'near-compute'] as const;

export type DemoLogicalPayee = (typeof DEMO_LOGICAL_PAYEES)[number];

export interface RailSeed {
  rail: Rail;
  policy: Policy;
  currency: string;
  amountScale: number;
  payees: Record<string, string>;
}

const PAYPAL_DEFAULT_PAYEES: Record<string, string> = {
  'openai-api': 'merchant@example.com',
  'anthropic-api': 'anthropic-merchant@example.com',
  vercel: 'vercel-merchant@example.com',
  'near-compute': 'compute-merchant@example.com',
};

const NEAR_DEFAULT_PAYEE = 'demo-merchant.testnet';

function demoPayeesError(detail: string, rail: Rail): AdapterConfigError {
  return new AdapterConfigError(`demo_payees: ${detail} (RAIL=${rail})`);
}

/** Simple demo email check: one `@`, non-empty local and domain with a dot, no spaces. */
export function isDemoPaypalEmail(address: string): boolean {
  if (address.includes(' ')) return false;
  const at = address.indexOf('@');
  if (at <= 0) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local === '' || domain === '') return false;
  if (!domain.includes('.')) return false;
  return isValidEmail(address);
}

function validatePayeeAddress(address: string, rail: Rail, networkId: string): void {
  if (rail === 'paypal') {
    if (!isDemoPaypalEmail(address)) {
      throw demoPayeesError('invalid paypal payee address', rail);
    }
    return;
  }
  if (rail === 'near') {
    if (!isAcceptedPayee(address, networkId as 'testnet' | 'mainnet')) {
      throw demoPayeesError('invalid near payee address for network', rail);
    }
  }
}

/**
 * Parses `name=address` pairs (comma-separated). Whitespace around items is trimmed.
 * Syntax errors throw AdapterConfigError without a RAIL suffix (caller adds context).
 */
export function parseDemoPayees(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return {};
  }
  const out: Record<string, string> = {};
  const seenNames = new Set<string>();
  for (const item of trimmed.split(',')) {
    const piece = item.trim();
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) {
      throw new AdapterConfigError('demo_payees: each item must be name=address');
    }
    const name = piece.slice(0, eq).trim();
    const address = piece.slice(eq + 1).trim();
    if (name === '' || address === '') {
      throw new AdapterConfigError('demo_payees: name and address must be non-empty');
    }
    if (seenNames.has(name)) {
      throw new AdapterConfigError(`demo_payees: duplicate logical payee name "${name}"`);
    }
    seenNames.add(name);
    out[name] = address;
  }
  return out;
}

function dedupeAllowedPayees(payees: Record<string, string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of DEMO_LOGICAL_PAYEES) {
    const addr = payees[name];
    if (addr !== undefined && !seen.has(addr)) {
      seen.add(addr);
      out.push(addr);
    }
  }
  for (const addr of Object.values(payees)) {
    if (!seen.has(addr)) {
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}

function mockSeed(): RailSeed {
  const payees: Record<string, string> = {};
  for (const name of DEMO_LOGICAL_PAYEES) {
    payees[name] = name;
  }
  return {
    rail: 'mock',
    policy: structuredClone(DEFAULT_POLICY),
    currency: 'USD',
    amountScale: 1,
    payees,
  };
}

function parseDemoPayeesForRail(raw: string, rail: Rail): Record<string, string> {
  try {
    return parseDemoPayees(raw);
  } catch (err) {
    if (err instanceof AdapterConfigError) {
      const msg = err.message.startsWith('demo_payees: ')
        ? err.message.slice('demo_payees: '.length)
        : err.message;
      throw demoPayeesError(msg, rail);
    }
    throw err;
  }
}

function paypalSeed(env: Readonly<Record<string, string | undefined>>): RailSeed {
  const rail = 'paypal' as const;
  const raw = env.DEMO_PAYEES?.trim();
  const payees = raw ? parseDemoPayeesForRail(raw, rail) : { ...PAYPAL_DEFAULT_PAYEES };
  if (raw) {
    for (const [name, address] of Object.entries(payees)) {
      if (name === '' || address === '') {
        throw demoPayeesError('name and address must be non-empty', rail);
      }
      validatePayeeAddress(address, rail, 'testnet');
    }
  } else {
    for (const address of Object.values(payees)) {
      validatePayeeAddress(address, rail, 'testnet');
    }
  }
  const policy: Policy = {
    agentId: 'demo-agent',
    perTxMax: 100,
    dailyMax: 200,
    requireApprovalAbove: 50,
    currency: 'USD',
    allowedPayees: dedupeAllowedPayees(payees),
  };
  return { rail, policy, currency: 'USD', amountScale: 1, payees };
}

function nearSeed(env: Readonly<Record<string, string | undefined>>): RailSeed {
  const rail = 'near' as const;
  const networkId = env.NEAR_NETWORK?.trim() || 'testnet';
  if (networkId !== 'testnet' && networkId !== 'mainnet') {
    throw demoPayeesError('NEAR_NETWORK must be testnet or mainnet', rail);
  }
  const raw = env.DEMO_PAYEES?.trim();
  let payees: Record<string, string>;
  if (raw) {
    payees = parseDemoPayeesForRail(raw, rail);
    for (const address of Object.values(payees)) {
      validatePayeeAddress(address, rail, networkId);
    }
  } else {
    payees = {};
    for (const name of DEMO_LOGICAL_PAYEES) {
      payees[name] = NEAR_DEFAULT_PAYEE;
    }
    validatePayeeAddress(NEAR_DEFAULT_PAYEE, rail, networkId);
  }
  const policy: Policy = {
    agentId: 'demo-agent',
    perTxMax: 1,
    dailyMax: 2,
    requireApprovalAbove: 0.5,
    currency: 'NEAR',
    allowedPayees: dedupeAllowedPayees(payees),
  };
  return { rail, policy, currency: 'NEAR', amountScale: 0.01, payees };
}

function baseRailSeed(rail: Rail, env: Readonly<Record<string, string | undefined>>): RailSeed {
  if (rail === 'mock') return mockSeed();
  if (rail === 'paypal') return paypalSeed(env);
  if (rail === 'near') return nearSeed(env);
  throw new AdapterConfigError(`unknown_rail: ${rail}`);
}

/**
 * Live-demo knob: DEMO_APPROVAL_ABOVE lowers the seed policy's `requireApprovalAbove` (in the rail's currency:
 * USD for mock/paypal, NEAR for near) so a small payment stops for human approval on stage. Unset or empty keeps
 * the defaults (50 USD, 0.5 NEAR). Must be a number >= 0 and below the rail's perTxMax.
 */
export function demoApprovalAbove(
  env: Readonly<Record<string, string | undefined>>,
  rail: Rail,
  perTxMax: number,
): number | undefined {
  const raw = env.DEMO_APPROVAL_ABOVE?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value >= perTxMax) {
    throw new AdapterConfigError(
      `invalid_demo_approval_above: DEMO_APPROVAL_ABOVE must be a number >= 0 and below perTxMax ${perTxMax} (RAIL=${rail}), got "${raw}"`,
    );
  }
  return value;
}

export function railSeed(rail: Rail, env: Readonly<Record<string, string | undefined>> = {}): RailSeed {
  const seed = baseRailSeed(rail, env);
  const approvalAbove = demoApprovalAbove(env, rail, seed.policy.perTxMax);
  if (approvalAbove !== undefined) seed.policy = { ...seed.policy, requireApprovalAbove: approvalAbove };
  return seed;
}
