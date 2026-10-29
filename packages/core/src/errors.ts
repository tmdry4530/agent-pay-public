// Browser-safe (no node: imports): the orchestrator, which the web demo bundles, imports from here.

/**
 * Machine-readable LedgerError codes (the message starts with "<code>: ").
 * - not_found: no entry with that intent id.
 * - duplicate_intent: recordIntent for an id that is already recorded.
 * - precondition_failed: the entry is not in the state the operation requires, e.g. a
 *   lost compare-and-set race (ifStatus / settleReceipt on a non-pending receipt) or an
 *   invalid lifecycle transition. Nothing was written; re-read and decide.
 * - invalid_input: a bad argument (unparseable date, receipt for another intent).
 * - ledger_corrupt: the ledger file is unparseable or fails schema validation (message names
 *   the file and the first bad field). Nothing was written; needs an operator to restore
 *   or repair the file, retrying will not help.
 * - ledger_missing: the ledger file existed (this process read or wrote it) and has since
 *   disappeared. Nothing was recreated, so limits and history are not silently reset;
 *   an operator must restore the file (or restart the process to start a fresh ledger
 *   deliberately). Retrying will not help.
 * - lock_timeout: another live process held the ledger's lock file for longer than
 *   LedgerOptions.lockTimeoutMs. Nothing was written; transient, safe to retry.
 */
export type LedgerErrorCode =
  | 'not_found'
  | 'duplicate_intent'
  | 'precondition_failed'
  | 'invalid_input'
  | 'lock_timeout'
  | 'ledger_corrupt'
  | 'ledger_missing';

export class LedgerError extends Error {
  override name = 'LedgerError';
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
