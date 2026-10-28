# @agent-pay/adapters

Payment rail adapters for agent-pay: in-memory mock payments and PayPal sandbox checkout (create + capture + refund).

Types (`PaymentIntent`, `Receipt`, `PaymentAdapter`, etc.) come from `@agent-pay/core`.

## Adapters

| Module | Rail | Purpose |
|--------|------|---------|
| `createMockAdapter` | `mock` | Deterministic, idempotent fake payments for local demos and tests. |
| `createPayPalAdapter` | `paypal` | PayPal REST Orders v2: OAuth, create order, capture, refund captures. |

Shared validation lives in `validateIntent` (`AdapterValidationError` on invalid intents).

## Receipt status

| Status | Meaning |
|--------|---------|
| `succeeded` | Payment captured successfully (mock pay or PayPal `COMPLETED`). |
| `pending` | Payment or refund still processing (PayPal `PENDING`). |
| `failed` | Declined or API/network failure; **does not throw** from `pay()`. |
| `refunded` | Refund completed (mock or PayPal refund `COMPLETED`). |

Contract (from core): every receipt has `intentId === intent.id` and `rail === adapter.rail`. Invalid intents still throw `AdapterValidationError`. Refund misuse (wrong rail, non-`succeeded` receipt) throws.

## PayPal `onError`

Optional `PayPalConfig.onError(error, { intentId, op })` is invoked when a PayPal API or network error is turned into a **failed** receipt (`op` is `token`, `create`, `capture`, or `refund`). Use it for structured logging; never log client secrets.

## Mock decline

`createMockAdapter({ shouldDecline: (intent) => boolean })` returns a failed receipt (deterministic `externalId`) instead of throwing.

## Environment variables (PayPal)

| Variable | Required | Description |
|----------|----------|-------------|
| `PAYPAL_CLIENT_ID` | Yes | Sandbox REST app client ID |
| `PAYPAL_CLIENT_SECRET` | Yes | Sandbox REST app secret |
| `PAYPAL_BASE_URL` | No | API base (default `https://api-m.sandbox.paypal.com`) |

Use `payPalConfigFromEnv()` to build config from `process.env`. Never log credentials.

## Tests

From the monorepo root (Node 24 native TypeScript execution; root provides `typescript` and `@types/node`):

```bash
PATH=<node24>/bin:$PATH npm test -w @agent-pay/adapters
PATH=<node24>/bin:$PATH npm run typecheck -w @agent-pay/adapters
```

Integration test `test/paypal.integration.test.ts` runs only when `PAYPAL_CLIENT_ID` is set (uses real `fetch` against sandbox).

## Assumptions

- Orders v2 normally requires buyer approval (approve link / payer action) before capture; an agent paying unattended needs a vaulted payment source or a different product (e.g. Payouts) — out of scope; the adapter does create+capture and resolves 422 `ORDER_NOT_APPROVED` as a **failed** receipt (details via `onError` / `PayPalApiError`).
- 2-decimal formatting is wrong for zero-decimal currencies (JPY, HUF, TWD); we only target USD for the demo.
- `PayPal-Request-Id` derived per (intent id, operation) because the docs require uniqueness per call type and max 38 chars.
- Token refresh 60 s before `expires_in`.
- `Receipt.externalId` for a payment = PayPal capture id when known; on failed pay it may be capture id, order id, or empty string.
- Failed PayPal `pay()` and refund API errors resolve with `status: 'failed'` rather than throwing.

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

`Receipt.meta` is `{ amountYocto, receiverId, network }`. Pending receipts also set `unknownOutcome` to `'true'`. `intentId` is `intent.id` and `rail` is `'near'`.

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
| `NEAR_RPC_URL` | No | Default `https://rpc.testnet.near.org` or `https://rpc.mainnet.near.org` |

`nearConfigFromEnv()` reads these. `NEAR_RECEIVER_ID` is only used by the optional integration test.

### Assumptions

- [assumption] JSON-RPC errors are HTTP 200 bodies shaped as `{ error: { code, message, data: { name: 'HANDLER_ERROR', cause: { name } } } }`. `name` / `cause` placed directly on `error`, and a string `error.data` (for example `"UNKNOWN_TRANSACTION"`), are accepted as the same cause name.
- [assumption] `cause.name === 'INVALID_TRANSACTION'` together with `HANDLER_ERROR` means the tx was not executed (`InvalidNonce`, `NotEnoughBalance`, `InvalidSignature`, …) → `rejected` with the precomputed tx hash. `TIMEOUT_ERROR`, thrown `fetch`, abort, and HTTP 5xx after `send_tx` → `unknown` with that hash (the tx may still execute). HTTP 4xx on `send_tx` → `rejected`. Any access-key query failure happens before broadcast → `rejected` **without** a tx hash.
- [assumption] `send_tx` params are `{ signed_tx_base64, wait_until }` and `tx` params are `{ tx_hash, sender_account_id, wait_until }` (object form, not the legacy positional array). `wait_until` strings are `NONE`, `INCLUDED`, `EXECUTED_OPTIMISTIC`, `INCLUDED_FINAL`, `EXECUTED`, `FINAL`. Send defaults to `EXECUTED_OPTIMISTIC`. Status calls always use `EXECUTED_OPTIMISTIC` because `NONE` does not include `SuccessValue` / `Failure`.
- [assumption] `result.status.SuccessValue !== undefined` (including `""`) is a successful execution. `result.status.Failure` is a final on-chain failure. The failure object is not copied onto the receipt.
- [assumption] Access-key `nonce` is a safe integer or a decimal string. The next tx uses `nonce + 1`. `block_hash` is base58 of 32 bytes. Default RPC timeout is 30 seconds.
- [assumption] A 64-byte secret's public half must match the ed25519 key derived from its seed. The public key placed in the transaction is that 32-byte key. Signature scheme is standard Ed25519 over the sha256 hash (what nearcore signs), via `node:crypto` and the PKCS#8 prefix `302e020100300506032b657004220420`.
- Named accounts outside `.testnet` / `.near`, and implicit accounts that are not 64 lowercase hex chars, are refused even if they are syntactically valid NEAR ids (`alice` is a valid id and still not an accepted payee).
