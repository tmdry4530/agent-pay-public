/** What the agent wants to pay for. Becomes the body of POST /intents (plus agentId). */
export interface Quote {
  payee: string;
  /** Major units of `currency`. */
  amount: number;
  currency: string;
  purpose: string;
}

export interface PlannerContext {
  agentId: string;
  /** Currency the quote should be in. Defaults to USD. */
  currency?: string;
}

/**
 * Turns a free-text task into a Quote.
 *
 * LLM hook: implement this interface (e.g. `class LlmPlanner implements Planner`) by prompting a model
 * for `{ payee, amount, currency, purpose }`, validating the JSON, and throwing PlannerError on bad output.
 * Then pass it as `runAgent({ planner })` or add a branch in `createPlanner`. Nothing here calls an LLM.
 */
export interface Planner {
  readonly name: string;
  plan(task: string, ctx: PlannerContext): Promise<Quote>;
}

export class PlannerError extends Error {
  override name = 'PlannerError';
}

/** `llm` is reserved for a future LLM-backed planner. */
export type PlannerKind = 'rule' | 'llm';

type Unit = 'token' | 'hour' | 'deploy';

export interface PriceRule {
  payee: string;
  /** Matched case-insensitively as whole words. First matching rule wins. */
  keywords: readonly string[];
  unit: Unit;
  /** USD per unit: per 1M tokens, per hour, or per deploy. */
  price: number;
}

/** Keyword/price table. Order matters: specific vendors first, generic "tokens" last. */
export const PRICE_TABLE: readonly PriceRule[] = [
  { payee: 'anthropic-api', keywords: ['claude', 'anthropic'], unit: 'token', price: 10 },
  { payee: 'openai-api', keywords: ['gpt', 'openai', 'chatgpt'], unit: 'token', price: 10 },
  { payee: 'vercel', keywords: ['vercel', 'deploy', 'deploys', 'deployment', 'hosting'], unit: 'deploy', price: 20 },
  { payee: 'near-compute', keywords: ['near', 'gpu', 'gpus', 'compute'], unit: 'hour', price: 5 },
  // Generic inference with no vendor named: default to openai-api.
  { payee: 'openai-api', keywords: ['token', 'tokens', 'inference', 'llm'], unit: 'token', price: 10 },
];

const UNIT_LABEL: Record<Unit, string> = { token: '1M tokens', hour: 'GPU hour', deploy: 'deploy' };
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
const NUM = String.raw`(\d+(?:\.\d+)?)`;

/**
 * Units in the task for a rule's unit. Tokens are counted in millions ("1M tokens" → 1, "500k tokens" → 0.5,
 * "2.5M" → 2.5, "200000 tokens" → 0.2). Hours: "3 hours"/"3h". Deploys: "2 deploys". Defaults to 1.
 */
export function parseQuantity(task: string, unit: Unit): number {
  const t = task.toLowerCase();
  if (unit === 'token') {
    const m = new RegExp(String.raw`${NUM}\s*([kmb])?\s*(?:tokens?)\b`).exec(t) ?? new RegExp(String.raw`${NUM}\s*([kmb])\b`).exec(t);
    if (!m) return 1;
    const n = Number(m[1]) * (m[2] ? SCALE[m[2]]! : 1);
    return n / 1e6;
  }
  const re = unit === 'hour' ? String.raw`${NUM}\s*(?:hours?|hrs?|h)\b` : String.raw`${NUM}\s*(?:deploys?|deployments?)\b`;
  const m = new RegExp(re).exec(t);
  return m ? Number(m[1]) : 1;
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(String.raw`\b${word}\b`, 'i').test(text);
}

/** Deterministic planner: keyword → payee, quantity × price table → amount. No network, no keys. */
export class RuleBasedPlanner implements Planner {
  readonly name = 'rule-based';
  readonly table: readonly PriceRule[];

  constructor(table: readonly PriceRule[] = PRICE_TABLE) {
    this.table = table;
  }

  async plan(task: string, ctx: PlannerContext): Promise<Quote> {
    const trimmed = task.trim();
    if (!trimmed) throw new PlannerError('empty_task: provide a non-empty task description');
    const rule = this.table.find((r) => r.keywords.some((k) => hasWord(trimmed, k)));
    if (!rule) {
      throw new PlannerError(
        `no_match: no price rule for "${trimmed}"; try keywords like gpt/openai, claude/anthropic, vercel/deploy, gpu/near`,
      );
    }
    const qty = parseQuantity(trimmed, rule.unit);
    if (!(qty > 0)) throw new PlannerError(`bad_quantity: could not read a positive quantity from "${trimmed}"`);
    const amount = Math.round(qty * rule.price * 100) / 100;
    if (!(amount > 0)) throw new PlannerError(`bad_quantity: amount rounds to 0 for "${trimmed}"`);
    const currency = ctx.currency ?? 'USD';
    return {
      payee: rule.payee,
      amount,
      currency,
      purpose: `${trimmed} (${qty} x ${UNIT_LABEL[rule.unit]} @ ${rule.price} ${currency})`,
    };
  }
}

/**
 * Planner factory. TODO(llm): return an LLM-backed Planner for kind 'llm' (needs a model client and key;
 * intentionally not wired in this demo).
 */
export function createPlanner(kind: PlannerKind = 'rule'): Planner {
  if (kind === 'rule') return new RuleBasedPlanner();
  throw new PlannerError('not_implemented: llm planner is a TODO; implement Planner and pass it to runAgent');
}
