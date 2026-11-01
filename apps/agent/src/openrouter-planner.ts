import { PRICE_TABLE, PlannerError, RuleBasedPlanner, type Planner, type PlannerContext, type PlanTrace, type Quote } from './planner.ts';

/** OpenRouter Chat Completions endpoint (OpenAI-compatible). https://openrouter.ai/docs/api_reference/overview */
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
/**
 * Default model when OPENROUTER_MODEL is unset. Checked on https://openrouter.ai/openai/gpt-4o-mini
 * (listed, no deprecation date) on 2026-11-01. Override with OPENROUTER_MODEL.
 */
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 15_000;

const MAX_PURPOSE = 200;
const MAX_REASON = 200;
const PAYEE_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

export interface OpenRouterPlannerOptions {
  /** OpenRouter API key. Read from OPENROUTER_API_KEY by `createPlanner('llm')`; never logged. */
  apiKey?: string;
  /** Defaults to DEFAULT_OPENROUTER_MODEL. */
  model?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 15000 ms. */
  timeoutMs?: number;
  /** Used when the key is missing or the LLM call fails or returns invalid output. Default RuleBasedPlanner. */
  fallback?: Planner;
  /** Defaults to OPENROUTER_CHAT_URL. */
  url?: string;
}

/** Thrown inside the planner to pick a fallback reason; never escapes `plan()`. */
class LlmFailure extends Error {}

/** Removes the configured key, any `sk-or-…` key, and Bearer credentials from text that may be shown or stored. */
export function redactOpenRouterSecrets(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out
    .replace(/\bsk-or-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/("?authorization"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]');
}

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
 * LLM planner on OpenRouter Chat Completions (plain fetch, no SDK). The model only proposes a Quote; the
 * API's policy engine still decides. On a missing key, HTTP/network error, timeout or invalid output it falls
 * back to the rule-based planner and records why in `quote.trace.fallback` (never the key).
 */
export class OpenRouterPlanner implements Planner {
  readonly name = 'openrouter';
  readonly model: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #fallback: Planner;
  readonly #url: string;

  constructor(options: OpenRouterPlannerOptions = {}) {
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.model = options.model?.trim() || DEFAULT_OPENROUTER_MODEL;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_OPENROUTER_TIMEOUT_MS;
    this.#fallback = options.fallback ?? new RuleBasedPlanner();
    this.#url = options.url ?? OPENROUTER_CHAT_URL;
  }

  async plan(task: string, ctx: PlannerContext): Promise<Quote> {
    const trimmed = task.trim();
    if (!trimmed) throw new PlannerError('empty_task: provide a non-empty task description');
    const currency = ctx.currency ?? 'USD';
    if (!this.#apiKey) return this.#fallBack(trimmed, ctx, 'missing_api_key: OPENROUTER_API_KEY is not set');
    try {
      const quote = await this.#ask(trimmed, currency, this.#apiKey);
      const trace: PlanTrace = { planner: this.name, model: this.model };
      return { ...quote, purpose: clip(`${quote.purpose} (openrouter ${this.model})`, MAX_PURPOSE + 60), trace };
    } catch (err) {
      const reason = err instanceof LlmFailure ? err.message : `error: ${err instanceof Error ? err.name : 'unknown'}`;
      return this.#fallBack(trimmed, ctx, clip(redactOpenRouterSecrets(reason, this.#apiKey), MAX_REASON));
    }
  }

  async #fallBack(task: string, ctx: PlannerContext, reason: string): Promise<Quote> {
    const quote = await this.#fallback.plan(task, ctx);
    return { ...quote, trace: { planner: this.#fallback.name, model: this.model, fallback: { from: this.name, reason } } };
  }

  async #ask(task: string, currency: string, apiKey: string): Promise<Omit<Quote, 'trace'>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'agent-pay',
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
