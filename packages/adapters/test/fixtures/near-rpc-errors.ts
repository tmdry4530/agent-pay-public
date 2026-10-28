/**
 * NEAR JSON-RPC error fixtures for `send_tx` and `tx`.
 *
 * The official docs give these errors as an OpenAPI schema
 * (docs.near.org/api-reference/post-send_tx, post-tx and
 * post-broadcast_tx_commit share the same `ErrorWrapper_for_RpcTransactionError`
 * and `RpcTransactionError` schemas). They do not give a full JSON example
 * response for any error. So each fixture below is the smallest object the
 * documented schema allows: only the documented property names, the documented
 * enum strings, and placeholder values where the schema says `string` or
 * `CryptoHash`. No property outside the schema is added. In particular the
 * legacy `code` / `message` / `data` fields that the older tests use are not in
 * the current docs and are left out here.
 *
 * Envelope: JsonRpcResponse_for_RpcTransactionResponse_and_RpcTransactionError
 * requires `jsonrpc` and `id`, plus `error` (oneOf with `result`). The docs
 * request default for `id` is "dontcare".
 */

/** Placeholder for a `CryptoHash` (base58 string). Not a real transaction. */
export const PLACEHOLDER_HASH = '9FtHUFBQsZ2MG77K3x3MJ9wjX3UT8zE1TczCrhZEcG8U';

function envelope(error: unknown): { jsonrpc: '2.0'; id: 'dontcare'; error: unknown } {
  return { jsonrpc: '2.0', id: 'dontcare', error };
}

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: OpenAPI components.schemas.ErrorWrapper_for_RpcTransactionError
// (name HANDLER_ERROR, cause RpcTransactionError) > RpcTransactionError
// (name TIMEOUT_ERROR; `info` is optional: "`None` when the response comes from
// a node running an older version that omitted the cause").
export const HANDLER_TIMEOUT_NO_INFO = envelope({
  name: 'HANDLER_ERROR',
  cause: { name: 'TIMEOUT_ERROR' },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: RpcTransactionError TIMEOUT_ERROR with info = TimeoutErrorCause
// { cause: NOT_OBSERVED } ("The node never observed the transaction on chain.").
export const HANDLER_TIMEOUT_NOT_OBSERVED = envelope({
  name: 'HANDLER_ERROR',
  cause: { name: 'TIMEOUT_ERROR', info: { cause: 'NOT_OBSERVED' } },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: TimeoutErrorCause { cause: PENDING, status: RpcTransactionResponse }
// ("observed but is still pending the requested finality"). `status` uses the
// RpcTransactionResponse anyOf `{}` branch with its one required field
// `final_execution_status` (TxExecutionStatus enum).
export const HANDLER_TIMEOUT_PENDING = envelope({
  name: 'HANDLER_ERROR',
  cause: {
    name: 'TIMEOUT_ERROR',
    info: { cause: 'PENDING', status: { final_execution_status: 'INCLUDED' } },
  },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: TimeoutErrorCause { cause: DOES_NOT_TRACK_SHARD, shard_id }.
export const HANDLER_TIMEOUT_DOES_NOT_TRACK_SHARD = envelope({
  name: 'HANDLER_ERROR',
  cause: { name: 'TIMEOUT_ERROR', info: { cause: 'DOES_NOT_TRACK_SHARD', shard_id: 0 } },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: TimeoutErrorCause { cause: ERROR, debug_info? }.
export const HANDLER_TIMEOUT_ERROR_CAUSE = envelope({
  name: 'HANDLER_ERROR',
  cause: { name: 'TIMEOUT_ERROR', info: { cause: 'ERROR' } },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: RpcTransactionError INVALID_TRANSACTION, `info: { type: object }`.
// The docs do not define the inner fields of `info`, so it is empty here.
export const HANDLER_INVALID_TRANSACTION = envelope({
  name: 'HANDLER_ERROR',
  cause: { name: 'INVALID_TRANSACTION', info: {} },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: RpcTransactionError DOES_NOT_TRACK_SHARD (name only).
export const HANDLER_DOES_NOT_TRACK_SHARD = envelope({
  name: 'HANDLER_ERROR',
  cause: { name: 'DOES_NOT_TRACK_SHARD' },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: RpcTransactionError REQUEST_ROUTED, info.transaction_hash.
export const HANDLER_REQUEST_ROUTED = envelope({
  name: 'HANDLER_ERROR',
  cause: { name: 'REQUEST_ROUTED', info: { transaction_hash: PLACEHOLDER_HASH } },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: RpcTransactionError UNKNOWN_TRANSACTION, info.requested_transaction_hash.
export const HANDLER_UNKNOWN_TRANSACTION = envelope({
  name: 'HANDLER_ERROR',
  cause: { name: 'UNKNOWN_TRANSACTION', info: { requested_transaction_hash: PLACEHOLDER_HASH } },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: RpcTransactionError INTERNAL_ERROR, info.debug_info (string).
export const HANDLER_INTERNAL_ERROR = envelope({
  name: 'HANDLER_ERROR',
  cause: { name: 'INTERNAL_ERROR', info: { debug_info: 'placeholder' } },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: ErrorWrapper REQUEST_VALIDATION_ERROR > RpcRequestValidationErrorKind
// METHOD_NOT_FOUND, info.method_name.
export const REQUEST_VALIDATION_METHOD_NOT_FOUND = envelope({
  name: 'REQUEST_VALIDATION_ERROR',
  cause: { name: 'METHOD_NOT_FOUND', info: { method_name: 'send_tx' } },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: ErrorWrapper REQUEST_VALIDATION_ERROR > RpcRequestValidationErrorKind
// PARSE_ERROR, info.error_message.
export const REQUEST_VALIDATION_PARSE_ERROR = envelope({
  name: 'REQUEST_VALIDATION_ERROR',
  cause: { name: 'PARSE_ERROR', info: { error_message: 'placeholder' } },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: ErrorWrapper INTERNAL_ERROR > InternalError INTERNAL_ERROR,
// info.error_message.
export const TOP_INTERNAL_ERROR = envelope({
  name: 'INTERNAL_ERROR',
  cause: { name: 'INTERNAL_ERROR', info: { error_message: 'placeholder' } },
});

// Source: https://docs.near.org/api-reference/post-send_tx (also post-tx)
// Section: FinalExecutionStatus oneOf: "NotStarted" | "Started" (strings),
// { Failure: TxExecutionError } | { SuccessValue: string }. Wrapped in the
// `result` branch of the envelope with the required RpcTransactionResponse
// field `final_execution_status`. The remaining FinalExecutionOutcomeView
// fields (transaction, transaction_outcome, receipts_outcome) are required by
// the schema but not read by the adapter; they are left out, so these are
// partial `result` objects. The inner TxExecutionError is not copied.
export function resultWithStatus(status: unknown, finalExecutionStatus: string): unknown {
  return {
    jsonrpc: '2.0',
    id: 'dontcare',
    result: { final_execution_status: finalExecutionStatus, status },
  };
}

// Source: https://docs.near.org/api-reference/post-send_tx
// Section: TxExecutionStatus enum.
export const TX_EXECUTION_STATUS_VALUES = [
  'NONE',
  'INCLUDED',
  'EXECUTED_OPTIMISTIC',
  'INCLUDED_FINAL',
  'EXECUTED',
  'FINAL',
] as const;
