import { PaymentError, type Receipt } from '@agent-pay/core';

/**
 * Background follow-up for receipts the rail reported as `pending` (e.g. a PayPal payout batch that is still
 * PENDING/PROCESSING). Each watched intent is re-checked with `refresh` (POST /intents/:id/refresh semantics)
 * every `intervalMs` until the receipt settles or `timeoutMs` passes, so the ledger ends with the final rail
 * state even when no client polls (the web UI only refreshes on click). Concurrent refreshes from a client are
 * safe: the ledger settles a pending receipt once (compare-and-set) and the loser gets `receipt_not_pending`.
 */
export interface ReceiptPollerOptions {
  /** Delay between checks, in ms. Must be > 0. */
  intervalMs: number;
  /** Stop watching an intent this long after it was first watched, in ms. */
  timeoutMs: number;
  /** One status check; resolves with the receipt after the check (still `pending` or settled). */
  refresh: (intentId: string) => Promise<{ receipt?: Receipt }>;
  /** Called for transient check errors (retried until the timeout). */
  onError?: (intentId: string, err: unknown) => void;
  now?: () => number;
}

/** Refresh errors that mean "stop watching": settled elsewhere, gone, or the rail cannot report status. */
const TERMINAL_CODES = new Set(['receipt_not_pending', 'intent_not_found', 'no_receipt', 'status_unsupported']);

export interface ReceiptPoller {
  /** Start watching an intent (no-op if it is already watched or the poller is stopped). */
  watch(intentId: string): void;
  /** Intent ids currently watched. */
  watching(): string[];
  /** Cancel every timer. Idempotent. */
  stop(): void;
}

export function createReceiptPoller(options: ReceiptPollerOptions): ReceiptPoller {
  if (!(options.intervalMs > 0)) throw new RangeError('intervalMs must be > 0');
  if (!(options.timeoutMs > 0)) throw new RangeError('timeoutMs must be > 0');
  const now = options.now ?? (() => Date.now());
  const timers = new Map<string, NodeJS.Timeout | undefined>();
  let stopped = false;

  const schedule = (intentId: string, deadline: number) => {
    const timer = setTimeout(() => void tick(intentId, deadline), options.intervalMs);
    timer.unref();
    timers.set(intentId, timer);
  };

  const tick = async (intentId: string, deadline: number) => {
    if (stopped || !timers.has(intentId)) return;
    timers.set(intentId, undefined);
    try {
      const result = await options.refresh(intentId);
      if (result.receipt?.status !== 'pending') {
        timers.delete(intentId);
        return;
      }
    } catch (err) {
      if (err instanceof PaymentError && TERMINAL_CODES.has(err.code)) {
        timers.delete(intentId);
        return;
      }
      options.onError?.(intentId, err);
    }
    if (stopped || now() >= deadline) {
      timers.delete(intentId);
      return;
    }
    schedule(intentId, deadline);
  };

  return {
    watch(intentId) {
      if (stopped || timers.has(intentId)) return;
      schedule(intentId, now() + options.timeoutMs);
    },
    watching: () => [...timers.keys()],
    stop() {
      stopped = true;
      for (const timer of timers.values()) if (timer) clearTimeout(timer);
      timers.clear();
    },
  };
}
