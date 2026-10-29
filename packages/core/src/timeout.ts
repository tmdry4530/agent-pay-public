/**
 * Timeouts core applies around adapter calls (F5). Browser-safe (no node: imports).
 *
 * Defaults:
 * - DEFAULT_PAY_TIMEOUT_MS (60 s) for adapter.pay. A pay call can make several rail
 *   requests (the NEAR RPC client and PayPal client apply their own per-request
 *   timeouts, 30 s for NEAR); on timeout the outcome is unknown and the payment is
 *   handled like F3 (pending + needsManualResolve, limit held, never re-sent).
 * - DEFAULT_STATUS_TIMEOUT_MS (45 s) for adapter.status: longer than the NEAR RPC's own
 *   30 s request timeout so the adapter's error surfaces first. On timeout reconcile
 *   records an error for that entry and continues; refreshIntent throws status_check_failed.
 * Override with `payTimeoutMs` / `statusTimeoutMs` (positive number; Infinity disables).
 * A timed-out call is not cancelled; its late result is ignored and never stored.
 */
export const DEFAULT_PAY_TIMEOUT_MS = 60_000;
export const DEFAULT_STATUS_TIMEOUT_MS = 45_000;

export class AdapterTimeoutError extends Error {
  override name = 'AdapterTimeoutError';
  readonly operation: string;
  readonly timeoutMs: number;
  constructor(operation: string, timeoutMs: number) {
    super(`adapter.${operation} did not settle within ${timeoutMs}ms`);
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/** Throws TypeError unless `ms` is undefined or a positive number (Infinity allowed). */
export function checkTimeout(name: string, ms: number | undefined): void {
  if (ms === undefined) return;
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms <= 0) {
    throw new TypeError(`invalid_options: ${name} must be a positive number of milliseconds, got ${String(ms)}`);
  }
}

/** Resolves/rejects like `promise`, or rejects with AdapterTimeoutError after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  if (ms === Number.POSITIVE_INFINITY) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AdapterTimeoutError(operation, ms)), ms);
  });
  promise.catch(() => undefined); // a late rejection after the timeout must not be unhandled
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
