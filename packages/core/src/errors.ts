// Browser-safe (no node: imports): the orchestrator, which the web demo bundles, imports from here.

/**
 * Machine-readable LedgerError codes (the message starts with "<code>: ").
 * - not_found: no entry with that intent id.
 * - duplicate_intent: recordIntent for an id that is already recorded.
 * - precondition_failed: the entry is not in the state the operation requires, e.g. a
 *   lost compare-and-set race (ifStatus / settleReceipt on a non-pending receipt) or an
 *   invalid lifecycle transition. Nothing was written; re-read and decide.
 * - invalid_input: a bad argument (unparseable date, receipt for another intent).
 */
export type LedgerErrorCode = 'not_found' | 'duplicate_intent' | 'precondition_failed' | 'invalid_input';

export class LedgerError extends Error {
  override name = 'LedgerError';
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
