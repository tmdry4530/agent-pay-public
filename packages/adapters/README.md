# @agent-pay/adapters

Payment rail adapters for agent-pay: in-memory mock payments and PayPal sandbox **Payouts v1** (default `paypal` rail), plus an optional PayPal **Orders v2** module for checkout-style create + capture + refund.

Types (`PaymentIntent`, `Receipt`, `PaymentAdapter`, etc.) come from `@agent-pay/core`.

Adapter-only types in `adapter-types.ts` extend receipts with optional string `meta` for rail-specific details (never secrets). Core `Receipt` does not define `meta` yet; the API ledger may omit it when persisting until core adds the field.

## Adapters

| Module | Export | Rail | Purpose |
|--------|--------|------|---------|
| `createMockAdapter` | `mock.ts` | `mock` | Deterministic, idempotent fake payments for local demos and tests. |
| `createPayPalAdapter` | `paypal.ts` | `paypal` | PayPal Payouts v1: OAuth, create payout batch to an email payee, optional `status()` refresh. |
| `createPayPalOrdersAdapter` | `paypal-orders.ts` | `paypal` | PayPal Orders v2: OAuth, create order, capture, refund captures (not used by the default demo). |

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
| `POST /payouts` **5xx**, any thrown error on POST (network, timeout, abort, other), or **2xx** with unparseable body / missing `payout_batch_id` | `pending`, `externalId: ''`, `meta.unknownOutcome: 'true'` |
| Duplicate `sender_batch_id` with HATEOAS link to existing batch | `GET` batch; on success return that receipt; on GET error/non-2xx → `pending`, `externalId: batch id`, `meta.unknownOutcome: 'true'` |
| Duplicate error **without** batch link | `pending`, `externalId: ''`, `meta.unknownOutcome: 'true'`, `meta.duplicateSenderBatchId: 'true'` |

Every converted failure or unknown outcome invokes `onError(error, { intentId, op })` with `op` in `token` | `payout` | `status`. Never log secrets.

## `status(receipt)` (payouts)

- Wrong `rail` → throws.
- `externalId === ''` → returns input unchanged (no batch id to query; caller may retry `pay(intent)` — idempotent via `sender_batch_id`).
- Otherwise refreshes from PayPal; on any error returns input unchanged and calls `onError` with `op: 'status'`.

## Receipt `meta` (payouts)

String keys only (never secrets):

| Key | When set |
|-----|----------|
| `batchStatus` | Batch status from PayPal |
| `payoutItemId` | First item `payout_item_id` when present |
| `transactionStatus` | First item `transaction_status` when present |
| `unknownOutcome` | `'true'` when pay ended pending due to uncertain outcome (5xx, POST fetch throw, bad 2xx body, duplicate without resolvable batch) |
| `duplicateSenderBatchId` | `'true'` when duplicate id error had no batch link (manual verification) |

## Idempotency

`sender_batch_id` = `intent.id`. PayPal rejects reuse within 30 days and may return an error with a link to the original batch. The adapter follows that link and returns the existing batch receipt instead of creating a duplicate.

**Assumption:** duplicate errors look like `USER_BUSINESS_ERROR` / messages or details mentioning `sender_batch_id`, `SENDER_BATCH_ID_ALREADY_USED`, or `DUPLICATE`, plus a `links[].href` matching `/v1/payments/payouts/{batch_id}`.

## PayPal Orders module (`paypal-orders`)

Same `rail: 'paypal'` but Orders v2 semantics: `externalId` is capture id when known. Unknown outcomes on create/capture (5xx/network) resolve as **`pending`** (with order id on capture when known); 4xx → **`failed`**. `onError` ops: `create`, `capture`, `refund`, `token`.

## Receipt status (general)

| Status | Meaning |
|--------|---------|
| `succeeded` | Payment completed on the rail. |
| `pending` | Still processing or unknown outcome after pay. |
| `failed` | Declined or definite rejection; **`pay()` does not throw**. |
| `refunded` | Refund completed (mock, Orders refund, or payout item `REFUNDED`). |

Contract (from core): every receipt has `intentId === intent.id` and `rail === adapter.rail`. Invalid intents throw `AdapterValidationError`.

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
