import { PayPalApiError } from './paypal-client.ts';

/**
 * Receipt meta describing why a PayPal call failed, for the ledger (and the web UI, which shows `meta.error`).
 * Only fields from the error object are used: HTTP status, PayPal error `name`, `message`, `debug_id` and a
 * summary of `details` (field/location/issue/description). Request or response headers are never read, and
 * every free-text value goes through {@link redactSecrets} so a token echoed in a message cannot land on disk.
 */
export interface PayPalErrorMeta extends Record<string, string> {}

const MAX_MESSAGE = 300;
const MAX_DETAILS = 600;
const MAX_SUMMARY = 500;
const DEBUG_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;

const REDACTED = '[redacted]';

/**
 * Removes token-like substrings: `Bearer`/`Basic` credentials, `key=value` / `"key": "value"` pairs whose key
 * names a secret (token, secret, password, authorization, …), PayPal access tokens (`A21AA…`), JWTs, NEAR
 * `ed25519:` keys, and any other unbroken run of 32+ token characters. `extraSecrets` (e.g. the configured
 * client id and secret) are removed verbatim.
 */
export function redactSecrets(input: string, extraSecrets: readonly string[] = []): string {
  let out = input;
  for (const secret of extraSecrets) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  out = out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(
      /(["']?\b[\w-]*(?:token|secret|password|passwd|authorization|api[_-]?key|credential)[\w-]*["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bA21A[A-Za-z0-9._-]{8,}/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED)
    .replace(/\bed25519:[1-9A-HJ-NP-Za-km-z]{16,}/g, REDACTED)
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, REDACTED);
  return out;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Builds error meta for a failed PayPal call. `op` names the call that failed (token, payout, status). */
export function paypalErrorMeta(
  error: unknown,
  op: string,
  extraSecrets: readonly string[] = [],
): PayPalErrorMeta {
  const clean = (s: string, max: number) => clip(redactSecrets(s, extraSecrets), max);
  const meta: PayPalErrorMeta = { errorOp: op };
  const parts: string[] = [];

  if (error instanceof PayPalApiError) {
    meta.errorStatus = String(error.status);
    parts.push(`HTTP ${error.status}`);
    if (error.name !== '' && error.name !== 'PayPalApiError' && NAME_RE.test(error.name)) {
      meta.errorName = error.name;
      parts.push(error.name);
    }
    if (error.message !== '') {
      meta.errorMessage = clean(error.message, MAX_MESSAGE);
      parts.push(meta.errorMessage);
    }
    if (error.details && error.details.length > 0) {
      meta.errorDetails = clean(JSON.stringify(error.details), MAX_DETAILS);
      const issues = error.details.map((d) => d.issue).filter((i): i is string => i !== undefined);
      if (issues.length > 0) parts.push(`issues ${clean(issues.join(','), 200)}`);
    }
    if (error.debugId !== undefined && DEBUG_ID_RE.test(error.debugId)) {
      meta.errorDebugId = error.debugId;
      parts.push(`debug_id ${error.debugId}`);
    }
  } else if (error instanceof Error) {
    // Network errors, timeouts, bad JSON: no HTTP status. Keep the JS error class and message (redacted).
    const kind = NAME_RE.test(error.name) ? error.name : 'Error';
    meta.errorType = kind;
    meta.errorMessage = clean(error.message, MAX_MESSAGE);
    parts.push(kind, meta.errorMessage);
  } else if (error !== null && typeof error === 'object') {
    // A parsed PayPal error body passed through as-is (duplicate sender_batch_id without a batch link).
    const r = error as Record<string, unknown>;
    if (typeof r.name === 'string' && NAME_RE.test(r.name)) parts.push(r.name);
    if (typeof r.message === 'string' && r.message !== '') {
      meta.errorMessage = clean(r.message, MAX_MESSAGE);
      parts.push(meta.errorMessage);
    }
    if (typeof r.debug_id === 'string' && DEBUG_ID_RE.test(r.debug_id)) {
      meta.errorDebugId = r.debug_id;
      parts.push(`debug_id ${r.debug_id}`);
    }
  }

  meta.error = clip(`paypal ${op} failed${parts.length > 0 ? `: ${parts.filter((p) => p !== '').join(': ')}` : ''}`, MAX_SUMMARY);
  return meta;
}
