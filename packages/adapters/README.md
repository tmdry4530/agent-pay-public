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
