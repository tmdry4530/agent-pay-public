import { RAILS, adapterRegistry } from './adapters.ts';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Env vars each rail's adapter requires, mirroring packages/adapters (read-only here):
 * paypal -> payPalConfigFromEnv requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (PAYPAL_BASE_URL is optional).
 * Rails not listed fall back to names carried by the error itself (see missingEnvNames).
 */
export const REQUIRED_ENV: Readonly<Record<string, readonly string[]>> = {
  paypal: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'],
};

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Env names that may hold credentials; their values are scrubbed from any message we print. */
const SECRET_ENV = /^(PAYPAL|NEAR)_|SECRET|TOKEN|PASSWORD|PRIVATE|KEY/;

const isBlank = (value: string | undefined): boolean => value === undefined || value.trim() === '';

/** Names listed on the error (or its cause) as `missing`, `missingEnv` or `names`: an adapter-provided list wins. */
function namesOnError(err: unknown, depth = 0): string[] | undefined {
  if (err === null || typeof err !== 'object' || depth > 3) return undefined;
  for (const field of ['missing', 'missingEnv', 'names']) {
    const value = (err as Record<string, unknown>)[field];
    if (Array.isArray(value)) {
      const names = value.filter((v): v is string => typeof v === 'string' && ENV_NAME.test(v));
      if (names.length > 0) return names;
    }
  }
  return namesOnError((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * Missing required env var NAMES for a failed start. Order of preference: names carried by the error
 * (a future AdapterConfigError with `missing`), the rail's REQUIRED_ENV that are blank, then ENV_LIKE
 * tokens in the message (e.g. "NEAR_ACCOUNT_ID environment variable is required") that are blank.
 */
export function missingEnvNames(err: unknown, env: Env, rail?: string): string[] {
  const fromError = namesOnError(err);
  if (fromError) return [...new Set(fromError)];
  const required = rail !== undefined ? REQUIRED_ENV[rail] : undefined;
  if (required) {
    const blank = required.filter((name) => isBlank(env[name]));
    if (blank.length > 0) return blank;
  }
  const message = err instanceof Error ? err.message : String(err);
  const tokens = message.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/g) ?? [];
  return [...new Set(tokens)].filter((name) => /required|missing/i.test(message) && isBlank(env[name]));
}

/** Replaces values of credential-like env vars with [redacted], in case an error message echoes one. */
export function redactEnvValues(text: string, env: Env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.trim().length < 4 || !SECRET_ENV.test(name)) continue;
    out = out.split(value).join('[redacted]');
  }
  return out;
}

/** Lines printed to stderr when the API cannot start. Names only, never env values, no stack trace. */
export function formatStartupError(err: unknown, env: Env, rail?: string): string[] {
  const message = redactEnvValues(err instanceof Error ? err.message : String(err), env);
  const lines = [`agent-pay api failed to start: ${message}`];
  const missing = missingEnvNames(err, env, rail);
  if (missing.length > 0) {
    lines.push(`missing required env vars${rail ? ` for RAIL=${rail}` : ''}: ${missing.join(', ')}`);
    lines.push('set them in the environment (names are listed in .env.example; values are never printed), or use RAIL=mock');
  } else if (/^adapter_not_wired\b/.test(message)) {
    const wired = RAILS.filter((r) => adapterRegistry[r] !== undefined);
    lines.push(`RAIL=${rail ?? '?'} is not available in this build yet; use ${wired.map((r) => `RAIL=${r}`).join(' or ')}`);
  }
  return lines;
}
