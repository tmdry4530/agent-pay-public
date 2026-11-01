import { PRICE_TABLE, PlannerError, RuleBasedPlanner, type Planner, type PlannerContext, type PlanTrace, type Quote } from './planner.ts';

/** OpenAI Chat Completions endpoint. https://platform.openai.com/docs/api-reference/chat/create */
export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
/** Default model when OPENAI_MODEL is unset. Override with OPENAI_MODEL. */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
/** OpenRouter Chat Completions endpoint (OpenAI-compatible). https://openrouter.ai/docs/api_reference/overview */
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
/**
 * Default model when OPENROUTER_MODEL is unset. Checked on https://openrouter.ai/openai/gpt-4o-mini
 * (listed, no deprecation date) on 2026-11-01. Override with OPENROUTER_MODEL.
 */
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
export const DEFAULT_LLM_TIMEOUT_MS = 15_000;
/** @deprecated kept for compatibility; same value as DEFAULT_LLM_TIMEOUT_MS. */
export const DEFAULT_OPENROUTER_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;

/** One OpenAI-compatible Chat Completions provider. Both providers share the same request/response shape. */
export interface LlmProviderConfig {
  /** Planner name and `trace.provider`, e.g. `openai`. */
  readonly name: string;
  readonly url: string;
  readonly defaultModel: string;
  /** Env var the key comes from; only used in the missing-key fallback reason. */
  readonly keyEnv: string;
  /** Env var the model override comes from. */
  readonly modelEnv: string;
  /** Extra non-secret request headers. */
  readonly headers?: Readonly<Record<string, string>>;
}

export const OPENAI_PROVIDER: LlmProviderConfig = {
  name: 'openai',
  url: OPENAI_CHAT_URL,
  defaultModel: DEFAULT_OPENAI_MODEL,
  keyEnv: 'OPENAI_API_KEY',
  modelEnv: 'OPENAI_MODEL',
};

export const OPENROUTER_PROVIDER: LlmProviderConfig = {
  name: 'openrouter',
  url: OPENROUTER_CHAT_URL,
  defaultModel: DEFAULT_OPENROUTER_MODEL,
  keyEnv: 'OPENROUTER_API_KEY',
  modelEnv: 'OPENROUTER_MODEL',
  headers: { 'X-Title': 'agent-pay' },
};

/** Preference order for `createPlanner('llm')`: the first provider whose key env var is non-empty wins. */
export const LLM_PROVIDERS: readonly LlmProviderConfig[] = [OPENAI_PROVIDER, OPENROUTER_PROVIDER];

/** Fallback reason when `createPlanner('llm')` finds no LLM key. */
export const NO_LLM_KEY_REASON = 'missing_api_key: neither OPENAI_API_KEY nor OPENROUTER_API_KEY is set';

export interface LlmPlannerOptions {
  /** API key for the provider. Read from the provider's key env var by `createPlanner('llm')`; never logged. */
  apiKey?: string;
  /** Defaults to the provider's default model. */
  model?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 15000 ms. */
  timeoutMs?: number;
  /** Used when the key is missing or the LLM call fails or returns invalid output. Default RuleBasedPlanner. */
  fallback?: Planner;
  /** Overrides the provider URL (tests). */
  url?: string;
}

/** @deprecated alias of LlmPlannerOptions. */
export type OpenRouterPlannerOptions = LlmPlannerOptions;

const MAX_PURPOSE = 200;
const MAX_REASON = 200;
const PAYEE_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

/** Thrown inside the planner to pick a fallback reason; never escapes `plan()`. */
class LlmFailure extends Error {}

/**
 * Removes the configured key, any `sk-…` key (OpenAI `sk-…`/`sk-proj-…`, OpenRouter `sk-or-…`) and Bearer /
 * Authorization values from text that may be shown or stored.
 */
export function redactLlmSecrets(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/("?authorization"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]');
}

/** @deprecated alias of redactLlmSecrets. */
export const redactOpenRouterSecrets = redactLlmSecrets;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function systemPrompt(currency: string): string {
  const payees = [...new Set(PRICE_TABLE.map((r) => r.payee))];
  const prices = PRICE_TABLE.slice(0, 4)
    .map((r) => `${r.payee}: ${r.price} ${currency} per ${r.unit === 'token' ? '1M tokens' : r.unit}`)
    .join('; ');
  return [
    'You turn an AI agent task into one payment proposal for a policy-guarded payment API.',
    'You only propose; a separate policy engine decides whether it is paid, rejected or needs human approval.',
    `Known payees: ${payees.join(', ')}. Reference prices: ${prices}.`,
    `Reply with only a JSON object: {"payee": string, "amount": number, "currency": "${currency}", "purpose": string}.`,
    'amount is in major units with at most 2 decimals. purpose is a short description of what is bought.',
  ].join(' ');
}

function stripFences(text: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return m ? m[1]! : text.trim();
}

/** Validates the model's proposal. Throws LlmFailure with a short reason on anything off-schema. */
export function parseLlmQuote(content: unknown, currency: string): Omit<Quote, 'trace'> {
  if (typeof content !== 'string' || content.trim() === '') throw new LlmFailure('invalid_output: empty content');
  let data: unknown;
  try {
    data = JSON.parse(stripFences(content));
  } catch {
    throw new LlmFailure('invalid_json: model content is not JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new LlmFailure('invalid_output: not an object');
  const o = data as Record<string, unknown>;
  const payee = typeof o.payee === 'string' ? o.payee.trim() : '';
  if (!PAYEE_RE.test(payee)) throw new LlmFailure('invalid_output: payee');
  if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0) {
    throw new LlmFailure('invalid_output: amount must be a positive number');
  }
  if (Math.round(o.amount * 100) / 100 !== o.amount) throw new LlmFailure('invalid_output: amount has more than 2 decimals');
  if (typeof o.currency !== 'string' || o.currency.trim().toUpperCase() !== currency.toUpperCase()) {
    throw new LlmFailure(`invalid_output: currency must be ${currency}`);
  }
  const purpose = typeof o.purpose === 'string' ? o.purpose.trim() : '';
  if (purpose === '') throw new LlmFailure('invalid_output: purpose');
  return { payee, amount: o.amount, currency, purpose: clip(purpose, MAX_PURPOSE) };
}

/**
 * LLM planner on an OpenAI-compatible Chat Completions API (plain fetch, no SDK). The model only proposes a
 * Quote; the API's policy engine still decides. On a missing key, HTTP/network error, timeout or invalid output
 * it falls back to the rule-based planner (never to another provider) and records why in
 * `quote.trace.fallback` (never the key).
 *
 * With `provider` undefined it is the "no key configured" planner: it always plans by the rules and records
 * that no LLM key was set.
 */
export class LlmPlanner implements Planner {
  readonly name: string;
  readonly provider: LlmProviderConfig | undefined;
  readonly model: string | undefined;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #fallback: Planner;
  readonly #url: string | undefined;

  constructor(provider: LlmProviderConfig | undefined, options: LlmPlannerOptions = {}) {
    this.provider = provider;
    this.name = provider?.name ?? 'llm';
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.model = provider ? options.model?.trim() || provider.defaultModel : undefined;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.#fallback = options.fallback ?? new RuleBasedPlanner();
    this.#url = options.url ?? provider?.url;
  }

  async plan(task: string, ctx: PlannerContext): Promise<Quote> {
    const trimmed = task.trim();
    if (!trimmed) throw new PlannerError('empty_task: provide a non-empty task description');
    const currency = ctx.currency ?? 'USD';
    if (!this.provider) return this.#fallBack(trimmed, ctx, NO_LLM_KEY_REASON);
    if (!this.#apiKey) return this.#fallBack(trimmed, ctx, `missing_api_key: ${this.provider.keyEnv} is not set`);
    try {
      const quote = await this.#ask(this.provider, trimmed, currency, this.#apiKey);
      const trace: PlanTrace = { planner: this.name, provider: this.provider.name, model: this.model };
      return { ...quote, purpose: clip(`${quote.purpose} (${this.provider.name} ${this.model})`, MAX_PURPOSE + 60), trace };
    } catch (err) {
      const reason = err instanceof LlmFailure ? err.message : `error: ${err instanceof Error ? err.name : 'unknown'}`;
      return this.#fallBack(trimmed, ctx, clip(redactLlmSecrets(reason, this.#apiKey), MAX_REASON));
    }
  }

  async #fallBack(task: string, ctx: PlannerContext, reason: string): Promise<Quote> {
    const quote = await this.#fallback.plan(task, ctx);
    const trace: PlanTrace = { planner: this.#fallback.name, fallback: { from: this.name, reason } };
    if (this.provider) {
      trace.provider = this.provider.name;
      trace.model = this.model;
    }
    return { ...quote, trace };
  }

  async #ask(provider: LlmProviderConfig, task: string, currency: string, apiKey: string): Promise<Omit<Quote, 'trace'>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(this.#url ?? provider.url, {
        method: 'POST',
        headers: {
          ...provider.headers,
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: 300,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt(currency) },
            { role: 'user', content: task },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new LlmFailure(`timeout: no response within ${this.#timeoutMs} ms`);
      throw new LlmFailure(`network_error: ${err instanceof Error ? err.name : 'unknown'}`);
    }
    try {
      if (!res.ok) {
        let detail = '';
        try {
          const body = (await res.json()) as { error?: { message?: unknown } };
          if (typeof body?.error?.message === 'string') detail = `: ${body.error.message}`;
        } catch {
          // non-JSON error body: status is enough
        }
        throw new LlmFailure(`http_${res.status}${clip(detail, 120)}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (controller.signal.aborted) throw new LlmFailure(`timeout: no response within ${this.#timeoutMs} ms`);
        throw new LlmFailure('invalid_json: response body is not JSON');
      }
      const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
      return parseLlmQuote(content, currency);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** LLM planner on OpenAI Chat Completions (OPENAI_API_KEY, OPENAI_MODEL). */
export class OpenAIPlanner extends LlmPlanner {
  constructor(options: LlmPlannerOptions = {}) {
    super(OPENAI_PROVIDER, options);
  }
}

/** LLM planner on OpenRouter Chat Completions (OPENROUTER_API_KEY, OPENROUTER_MODEL). */
export class OpenRouterPlanner extends LlmPlanner {
  constructor(options: LlmPlannerOptions = {}) {
    super(OPENROUTER_PROVIDER, options);
  }
}

/**
 * Picks the LLM planner from the environment: OPENAI_API_KEY → OpenAI, else OPENROUTER_API_KEY → OpenRouter,
 * else a planner that plans by the rules without sending any request. Blank values count as unset.
 */
export function createLlmPlannerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: Omit<LlmPlannerOptions, 'apiKey' | 'model'> = {},
): LlmPlanner {
  for (const provider of LLM_PROVIDERS) {
    const apiKey = env[provider.keyEnv]?.trim();
    if (apiKey) return new LlmPlanner(provider, { ...options, apiKey, model: env[provider.modelEnv] });
  }
  return new LlmPlanner(undefined, options);
}
