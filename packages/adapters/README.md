# @agent-pay/adapters

Payment rail adapters for agent-pay: in-memory mock payments and PayPal sandbox **Payouts v1** (default `paypal` rail), plus an optional PayPal **Orders v2** module for checkout-style create + capture + refund.

Types (`PaymentIntent`, `Receipt`, `PaymentAdapter`, etc.) come from `@agent-pay/core`.

Adapter-only types in `adapter-types.ts` extend receipts with optional string `meta` for rail-specific details (never secrets). Core `Receipt` does not define `meta` yet; the API ledger may omit it when persisting until core adds the field.

## Adapters

| Module | Export | Rail | Purpose |
|--------|--------|------|---------|
| `createMockAdapter` | `mock.ts` | `mock` | Deterministic, idempotent fake payments for local demos and tests. |
| `createPayPalAdapter` | `paypal.ts` | `paypal` | PayPal Payouts v1: OAuth, create payout batch to an email payee, optional `status()` refresh. |
| `createPayPalOrdersAdapter` | `paypal-orders.ts` | `paypal-orders` | PayPal Orders v2: OAuth, create order, capture, refund captures (**not** a core `PaymentAdapter`; rail widened in `adapter-types.ts` as `AdapterRail`. Not usable with core `runPayment` until core's `Rail` includes `paypal-orders`). |

Shared PayPal HTTP plumbing (OAuth token cache, errors, `formatAmount`, env config) lives in `paypal-client.ts`.

Shared validation lives in `validateIntent` (`AdapterValidationError` on invalid intents). Payouts additionally require `payee` to pass `isValidEmail`.

## PayPal Payouts flow

1. `validateIntent(intent)` and email check on `intent.payee`.
2. OAuth2 client credentials (`POST /v1/oauth2/token`), token cached until 60 s before expiry.
3. `POST /v1/payments/payouts` with `sender_batch_header.sender_batch_id = intent.id` (idempotency key for 30 days).
4. Receipt: `externalId` = `payout_batch_id`, `status` from `mapPayoutStatus`, optional `meta` (see below).
5. Optional `status(receipt)` → `GET /v1/payments/payouts/{payout_batch_id}` when `externalId` is non-empty.

There is **no** `refund()` on the payouts adapter (PayPal Payouts refunds/cancels unclaimed items are out of scope).

## Payout status mapping (`mapPayoutStatus`)

When `items[0].transaction_status` is present, it **wins** over batch status:

| Item `transaction_status` | Receipt `status` |
|---------------------------|------------------|
| `SUCCESS` | `succeeded` |
| `PENDING`, `UNCLAIMED`, `ONHOLD` | `pending` |
| `REFUNDED` | `refunded` |
| `FAILED`, `RETURNED`, `BLOCKED`, `REVERSED`, other | `failed` |

If no item status, batch `batch_status` is used:

| Batch `batch_status` | Receipt `status` |
|----------------------|------------------|
| `SUCCESS` | `succeeded` |
| `PENDING`, `PROCESSING` | `pending` |
| `DENIED`, `CANCELED`, other | `failed` |

**Assumption:** `ONHOLD` → `pending`, `REFUNDED` → `refunded` (item-level).

## Outcome rules (payouts `pay`)

| Situation | Receipt |
|-----------|---------|
| Token endpoint failure (any) | `failed`, `externalId: ''` |
| `POST /payouts` **4xx** (except handled duplicate — see idempotency) | `failed`, `externalId: ''` |
| `POST /payouts` **5xx**, any thrown error on POST (network, timeout, abort, other), or **2xx** with unparseable body / missing `payout_batch_id` | `pending`, `externalId: ''`, `meta.unknownOutcome: 'true'`, `meta.needsManualResolve: 'true'`, optional `meta.errorName` from PayPal error name when known |
| Duplicate `sender_batch_id` with HATEOAS link to existing batch | `GET` batch; on success return that receipt (with `meta.duplicateSenderBatchId` / `meta.errorName` from duplicate error); on GET error/non-2xx/network throw/non-JSON body → `pending`, `externalId: batch id`, `meta.unknownOutcome: 'true'` (no `needsManualResolve`; `status` can poll the batch id) |
| Duplicate error **without** batch link | `pending`, `externalId: ''`, `meta.unknownOutcome: 'true'`, `meta.duplicateSenderBatchId: 'true'`, `meta.needsManualResolve: 'true'`, `meta.errorName` when PayPal names the error |
| **2xx** batch body with **2+ items** (POST 201 or duplicate-path GET) | `pending`, `externalId: batch id`, `meta.needsManualResolve: 'true'`, `meta.errorName: 'receipt_mismatch'`, `meta.itemCount`, `meta.batchStatus` (+ first-item fields when present). Does **not** throw — failing pay would free the daily limit and risk double-pay. |

Every converted failure or unknown outcome invokes `onError(error, { intentId, op })` with `op` in `token` | `payout` | `status`. Never log secrets.

## `status(receipt)` (payouts)

- Wrong `rail` → throws.
- `externalId === ''` → returns input unchanged (no batch id to query; caller may retry `pay(intent)` — idempotent via `sender_batch_id`).
- Otherwise refreshes from PayPal; batch with **2+ items** → throws `receipt_mismatch: …`, `onError` with `op: 'status'` (core wraps as `status_check_failed`; nothing stored).
- On other errors returns input unchanged and calls `onError` with `op: 'status'`.

## Receipt `meta` (payouts)

String keys only (never secrets):

| Key | When set |
|-----|----------|
| `batchStatus` | Batch status from PayPal |
| `payoutItemId` | First item `payout_item_id` when present |
| `transactionStatus` | First item `transaction_status` when present |
| `unknownOutcome` | `'true'` when pay ended pending due to uncertain outcome (5xx, POST fetch throw, bad 2xx body, duplicate without resolvable batch, or duplicate GET failure with batch id) |
| `needsManualResolve` | `'true'` when outcome is uncertain and operator must settle (planned `POST /intents/:id/resolve`): pay() with `unknownOutcome` and empty `externalId`, or multi-item batch on pay with batch id |
| `errorName` | PayPal error `name` when known (`PayPalApiError` with a specific name, or duplicate-guess from parsed 4xx body); `'receipt_mismatch'` when batch has 2+ items; omitted for non-PayPal errors (e.g. network `TypeError`) |
| `itemCount` | String count of batch `items[]` when `errorName` is `receipt_mismatch` |
| `duplicateSenderBatchId` | `'true'` on duplicate `sender_batch_id` errors (with or without batch link); signals idempotency collision |

## Idempotency

`sender_batch_id` = `intent.id`. PayPal rejects reuse within 30 days and may return an error with a link to the original batch. The adapter follows that link and returns the existing batch receipt instead of creating a duplicate.

**Assumption:** duplicate errors look like `USER_BUSINESS_ERROR` / messages or details mentioning `sender_batch_id`, `SENDER_BATCH_ID_ALREADY_USED`, or `DUPLICATE`, plus a `links[].href` matching `/v1/payments/payouts/{batch_id}`.

## PayPal Orders module (`paypal-orders`)

Uses adapter rail **`paypal-orders`** (widened on the adapter side via `AdapterRail`; core `Rail` remains `mock` | `paypal` | `near`). This module is intentionally **not** registered in the API adapter registry and is not a core `PaymentAdapter`. Receipts use `rail: 'paypal-orders'`. Refund rejects receipts whose rail is not `paypal-orders`.

Same OAuth plumbing as Payouts but Orders v2 semantics: `externalId` is capture id when known. Unknown outcomes on create/capture (5xx/network) resolve as **`pending`** (with order id on capture when known); 4xx → **`failed`**. `onError` ops: `create`, `capture`, `refund`, `token`.

## Receipt status (general)

| Status | Meaning |
|--------|---------|
| `succeeded` | Payment completed on the rail. |
| `pending` | Still processing or unknown outcome after pay. |
| `failed` | Declined or definite rejection; **`pay()` does not throw**. |
| `refunded` | Refund completed (mock, Orders refund, or payout item `REFUNDED`). |

Contract (from core): every receipt has `intentId === intent.id` and `rail === adapter.rail`. Invalid intents throw `AdapterValidationError`.

NEAR adapters may attach `meta` (`amountYocto`, `receiverId`, `network`, …) on receipts via the adapter-side `AdapterReceipt` type. Core `Receipt` has no `meta` field yet; the ledger may omit it until core adds it.

## Mock decline

`createMockAdapter({ shouldDecline: (intent) => boolean })` returns a failed receipt (deterministic `externalId`) instead of throwing.

## Environment variables (PayPal)

| Variable | Required | Description |
|----------|----------|-------------|
| `PAYPAL_CLIENT_ID` | Yes | Sandbox REST app client ID |
| `PAYPAL_CLIENT_SECRET` | Yes | Sandbox REST app secret |
| `PAYPAL_BASE_URL` | No | API base (default `https://api-m.sandbox.paypal.com`) |
| `PAYPAL_PAYOUT_RECEIVER` | Integration only | Sandbox personal account email for payout integration test |

Use `payPalConfigFromEnv()` to build config from `process.env`. Never log credentials.

## Tests

From the monorepo root (Node 24 native TypeScript execution; root provides `typescript` and `@types/node`):

```bash
PATH=<node24>/bin:$PATH npm test -w @agent-pay/adapters
PATH=<node24>/bin:$PATH npm run typecheck -w @agent-pay/adapters
```

- `test/paypal.test.ts` — Payouts unit tests (mocked `fetch`).
- `test/paypal-orders.test.ts` — Orders v2 unit tests.
- `test/paypal.integration.test.ts` — real sandbox payout when `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_PAYOUT_RECEIVER` are set.
- `test/paypal-orders.integration.test.ts` — real Orders sandbox when `PAYPAL_CLIENT_ID` is set.

## Assumptions

- Payee for payouts must match `isValidEmail`: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` and length ≤ 254.
- `formatAmount` uses two decimal places — wrong for zero-decimal currencies (JPY, HUF, TWD); demo targets USD.
- Duplicate payout error shape and link pattern as documented above (PayPal may change error JSON).
- Token refresh 60 s before `expires_in`.
- Optional `timeoutMs` on `PayPalConfig` applies `AbortSignal.timeout` per HTTP request.

## NEAR (`createNearAdapter`)

Native NEAR **transfer** (one `Transfer` action). Rail is `near`, currency is `NEAR` (case-insensitive). Default network is **testnet**. The adapter does **not** implement `refund`: a payer cannot reverse a signed transfer.

`pay()` does not call `validateIntent` (that helper requires a 3-letter ISO currency). It checks non-empty `id`, `agentId`, and `purpose`, a present `createdAt`, currency `NEAR`, a positive amount that `parseNearToYocto` can convert, an accepted payee, and that the payee is not the signer (`client.accountId`). Misuse throws `AdapterValidationError` before any RPC call. A declined or uncertain chain outcome resolves with a receipt; it does not throw.

Amounts convert to yoctoNEAR (`1 NEAR = 10^24`) with integer digit strings and `BigInt` only, so values such as `0.1` do not pick up binary float error. `Number#toString` exponent form (`1e-7`) is expanded in decimal text. More than 24 fractional digits is rejected.

Signing uses an injectable `NearClient`. `createNearRpcClient` is a zero-dependency JSON-RPC client (`node:crypto` ed25519, hand-rolled base58, `fetch`). It loads the access-key nonce (`view_access_key`, finality `final`), signs nonce+1, and computes the tx hash **before** `send_tx`. The hash is `base58(sha256(borsh(Transaction)))`. The ed25519 signature covers that 32-byte hash. The private key is never written into errors or receipts.

### Payees

`isAcceptedPayee` requires `isValidNearAccountId` (nearcore length 2..64 and the official account-id regex) and either:

- a named account ending in `.testnet` when `networkId` is `testnet`, or `.near` when `networkId` is `mainnet`, or
- an implicit account: 64 lowercase hex characters (accepted on both networks).

Examples: `alice.testnet` is payable on testnet; `alice.near` is not. `Alice.testnet`, `alice..testnet`, `-alice.testnet`, `a`, and `alice` are rejected.

### Outcome mapping

`Receipt.meta` is `{ amountYocto, receiverId, network }`. Pending unknown-outcome receipts set `unknownOutcome` to `'true'`; `needsManualResolve` is `'true'` only when `externalId` is empty (nothing to poll). `intentId` is `intent.id` and `rail` is `'near'`.

| `sendTransfer` result | Receipt status | `externalId` |
|-----------------------|----------------|--------------|
| `final` + success | `succeeded` | tx hash |
| `final` + failure | `failed` | tx hash |
| `rejected` (not executed) | `failed` | tx hash, or `''` if nothing was broadcast |
| `unknown` (may have executed) | `pending` | tx hash, or `''` |
| client throws | `pending` (`onError`, op `send`) | `''` |

| `status(receipt)` | Result |
|-------------------|--------|
| `receipt.rail !== 'near'` | throws |
| `externalId === ''` | same receipt |
| `final` success / failure | `succeeded` / `failed` (same intentId, rail, externalId, meta) |
| `notFound` (`UNKNOWN_TRANSACTION`) | unchanged, stays `pending` if it was pending. The tx may not have propagated yet. A transfer that stays unknown needs a **manual check**. |
| `unknown` or `txStatus` throws | unchanged, `onError` with op `status` |

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEAR_ACCOUNT_ID` | Yes | Signer account id |
| `NEAR_PRIVATE_KEY` | Yes | `ed25519:` + base58 secret (64-byte seed\|\|pubkey, or 32-byte seed). Never log it. |
| `NEAR_NETWORK` | No | `testnet` (default) or `mainnet` |
| `NEAR_RPC_URL` | No | Testnet default `https://test.rpc.fastnear.com` (FASTNEAR's public, free, no-API-key testnet endpoint on NEAR's [RPC providers](https://docs.near.org/api/rpc/providers) page); mainnet default `https://rpc.mainnet.near.org` |

`nearConfigFromEnv()` reads these. `NEAR_RECEIVER_ID` is only used by the optional integration test.

### Assumptions

- [assumption] JSON-RPC errors are HTTP 200 bodies shaped as `{ error: { code, message, data: { name: 'HANDLER_ERROR', cause: { name } } } }`. `name` / `cause` placed directly on `error`, and a string `error.data` (for example `"UNKNOWN_TRANSACTION"`), are accepted as the same cause name.
- [assumption] `cause.name === 'INVALID_TRANSACTION'` together with `HANDLER_ERROR` means the tx was not executed (`InvalidNonce`, `NotEnoughBalance`, `InvalidSignature`, …) → `rejected` with the precomputed tx hash. `TIMEOUT_ERROR`, thrown `fetch`, abort, and HTTP 5xx after `send_tx` → `unknown` with that hash (the tx may still execute). HTTP 4xx on `send_tx` → `rejected`. Any access-key query failure happens before broadcast → `rejected` **without** a tx hash.
- [assumption] `send_tx` params are `{ signed_tx_base64, wait_until }` and `tx` params are `{ tx_hash, sender_account_id, wait_until }` (object form, not the legacy positional array). `wait_until` strings are `NONE`, `INCLUDED`, `EXECUTED_OPTIMISTIC`, `INCLUDED_FINAL`, `EXECUTED`, `FINAL`. Send and status both default to `FINAL` (NEAR docs recommend waiting for finality before treating a submission as settled).
- [assumption] `SuccessValue` or `Failure` in `result.status` only maps to `final` when `result.final_execution_status === 'FINAL'`. Otherwise the outcome stays `unknown` (`pending` on pay, unchanged receipt on status) with error `transaction not final`. A non-final `Failure` is not marked failed so a daily-limit slot is not freed prematurely. The failure object is not copied onto the receipt.
- [assumption] Access-key `nonce` is a safe integer or a decimal string. The next tx uses `nonce + 1`. `block_hash` is base58 of 32 bytes. Default RPC timeout is 30 seconds.
- [assumption] A 64-byte secret's public half must match the ed25519 key derived from its seed. The public key placed in the transaction is that 32-byte key. Signature scheme is standard Ed25519 over the sha256 hash (what nearcore signs), via `node:crypto` and the PKCS#8 prefix `302e020100300506032b657004220420`.
- Named accounts outside `.testnet` / `.near`, and implicit accounts that are not 64 lowercase hex chars, are refused even if they are syntactically valid NEAR ids (`alice` is a valid id and still not an accepted payee).
