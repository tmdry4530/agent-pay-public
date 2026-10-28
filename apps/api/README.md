# @agent-pay/api

`node:http` server, no runtime deps. `createApp(options)` / `createServer(options)` are exported from
`apps/api/src/index.ts` for tests; `src/main.ts` is the entrypoint (`npm start -w @agent-pay/api`).

## Env vars
| var | default | |
|---|---|---|
| `PORT` | `8787` | `0` = random port |
| `HOST` | `127.0.0.1` | bind address |
| `LEDGER_PATH` | `apps/api/.data/ledger.json` (resolved from the api package, gitignored) | single writer process per file |
| `RAIL` | `mock` | `mock` \| `paypal` (PayPal Payouts v1, sandbox) \| `near` (NEAR testnet native transfer). Missing credentials for a wired rail → exits 1 at startup with `adapter_config: …` plus `missing required env vars for RAIL=<rail>: <names>` (names only, no values, no stack trace) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL?` | | only for `RAIL=paypal` (sandbox, from your shell env; never commit) |
| `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY`, `NEAR_NETWORK?`, `NEAR_RPC_URL?` | | only for `RAIL=near` |
| `DEMO_PAYEES` | | optional for `RAIL=paypal` or `near` only: comma-separated `name=address` pairs (whitespace trimmed). When non-empty, **replaces** the default logical→address map entirely. Invalid syntax or payee for the rail → startup error `demo_payees: … (RAIL=…)`. Ignored for `mock`. |

All names are listed in the root [.env.example](../../.env.example); `node --env-file=.env apps/api/src/main.ts`
loads a filled-in copy. Startup errors are formatted by `src/startup-error.ts`: an error carrying a `missing` /
`missingEnv` / `names` string array is listed as-is; otherwise the rail's known required names (`REQUIRED_ENV`) or
env names quoted in a "… is required" message are checked against the environment. Credential-like env values are
scrubbed from the printed message. Listen errors (e.g. `EADDRINUSE`) also exit 1 without a stack trace.

## Per-rail demo seed

At startup, `railSeed(RAIL, process.env)` selects policy limits, currency, amount scale, and logical payee addresses:

| Rail | Currency | amountScale | Policy highlights | Default payees (logical → address) |
|------|----------|-------------|-------------------|-------------------------------------|
| `mock` | USD | 1 | Same as `DEFAULT_POLICY`; payees are identity (`openai-api` → `openai-api`, …) | identity map |
| `paypal` | USD | 1 | Same USD limits as mock; `allowedPayees` are merchant **emails** | `openai-api` → `merchant@example.com`, … |
| `near` | NEAR | 0.01 | `perTxMax` 1, `dailyMax` 2, `requireApprovalAbove` 0.5 | all four logical names → `demo-merchant.testnet` (must match `NEAR_NETWORK`; mainnet requires `DEMO_PAYEES`) |

`policy.allowedPayees` is the de-duplicated list of rail addresses (insertion order). The agent reads `GET /rail` to map planner logical payees and scale USD quote amounts (e.g. scenario `small` 10 USD → 0.1 NEAR when `amountScale` is 0.01).

## Policy
Kept **in memory** (one policy, one agent), seeded from `railSeed` (mock uses exported `DEFAULT_POLICY` unchanged):
`PUT /policy` replaces it until restart. The ledger is on disk; the policy is not.

## Endpoints
All bodies are JSON. Errors are `{"error": "<code>: <detail>"}`.

| method & path | request | response |
|---|---|---|
| `GET /health` | | `200 {ok: true, rail}` |
| `GET /rail` | | `200 {rail, currency, amountScale, payees}` — demo mapping for agents (defaults: policy currency, scale 1, `{}`) |
| `POST /intents` | `{agentId, payee, amount, currency, purpose, id?, createdAt?}` | `201` (new) / `200` (replay) `PaymentResult & {intent}` = `{intentId, status: paid\|rejected\|needs_approval\|failed, decision, receipt?, error?, replayed?, intent}` |
| `POST /intents/:id/approve` | optional `{approver?}` | `200 PaymentResult` (`paid`, or `rejected` if the re-check fails) |
| `POST /intents/:id/reject` | optional `{approver?, note?}` | `200 PaymentResult` (`rejected`, reason `rejected_by_human: …`) |
| `POST /intents/:id/refresh` | optional empty body | `200 PaymentResult & {changed: boolean}` — polls the adapter's `status()` for a **pending** receipt on this rail; settles the ledger when the rail reports `succeeded` or `failed`. Still `pending` → `changed: false`, no ledger write. |
| `POST /intents/:id/resolve` | `{status: succeeded\|failed\|refunded, note, externalId?, resolvedBy?}` | `200 PaymentResult & {changed: true, resolution}` — operator settles a **pending** receipt by hand; never calls the adapter (see below) |
| `GET /ledger` | | `200 {entries: LedgerEntry[], today: {day: "YYYY-MM-DD" (UTC), totals: {[agentId]: number}}}` |
| `GET /policy` | | `200 Policy` |
| `PUT /policy` | full `Policy` | `200 Policy` |

**Client-supplied intent fields:** `agentId`, `payee`, `amount` (finite number > 0), `currency`, `purpose` are
required. `id` (1–128 chars of `[A-Za-z0-9._:-]`) and `createdAt` (ISO 8601 with a zone) are optional; the server
fills in `pi_<uuid>` and the current time. Unknown fields are rejected. For an idempotent retry, send the same `id`
**and** `createdAt`: the core replay needs a deep-equal intent, otherwise the retry is a `409 intent_conflict`.

**Today's totals** use the same rule as core: UTC day of `intent.createdAt`, entries that count toward the daily
total (approved and not failed).

**Refresh contract:** `404 intent_not_found`; `409 no_receipt` (no receipt on the entry, e.g. rejected); `409 receipt_not_pending` when the receipt is already settled (`succeeded` / `failed` / `refunded`) — **409 instead of 200 `changed: false`** so clients know the intent is final and can read `GET /ledger`; `409 status_unsupported` when the adapter has no `status()` or the receipt rail differs; `502 status_check_failed` when `status()` throws or returns an invalid receipt (nothing stored).

**Resolve contract (operator, `POST /intents/:id/resolve`):** for pending receipts that `status()` cannot settle, e.g. PayPal
receipts with `meta.needsManualResolve: "true"` (duplicate `sender_batch_id` guesses, 5xx / network errors with no batch id,
batches with 2+ items). The route never calls the adapter (`pay()` or `status()`); it only writes the ledger.
- Body: `status` required, one of `succeeded` / `failed` / `refunded` (`pending` is rejected); `note` required, non-empty
  (≤1000 chars); `externalId` optional (≤256 chars, replaces the stored rail id, e.g. the real PayPal batch id; omitted =
  keep it); `resolvedBy` optional operator name (≤128 chars, default `"operator"`). Unknown fields → 400.
- Ledger: the receipt gets the new `status` / `externalId` / `at` (other receipt fields such as `meta` are kept), and the
  entry gets `resolution: {status, resolvedBy, note, at, previousExternalId}`.
- Daily total: `failed` also marks the payment failed, so the amount is freed; `succeeded` and `refunded` keep counting
  (same rule as `countsTowardDailyTotal`: refunds do not free budget).
- Response `200`: `{intentId, decision, status: "paid"|"failed", receipt, changed: true, resolution, error?}`
  (`error: "payment_failed: resolved as failed by <resolvedBy>"` for `failed`).
- Errors: `400 invalid_body` / `invalid_json`; `404 intent_not_found`; `409 no_receipt`; `409 receipt_not_pending`
  (already settled, including a second resolve).
- No auth: like the rest of this demo API it is meant for localhost only; `resolvedBy` is self-reported.

**Status codes:** `400` `invalid_body` / `invalid_json` / `invalid_path`; `404` `not_found` (route) or
`intent_not_found`; `405` `method_not_allowed` (with `Allow`); `409` `already_paid`, `not_pending`, `in_progress`,
`intent_conflict`, `no_receipt`, `receipt_not_pending`, `status_unsupported`; `502` `status_check_failed`; `413` `payload_too_large` (body cap 64 KiB); `500` `internal_error`. Policy rejections are not
HTTP errors: they come back as `status: "rejected"` results.

**CORS:** only `http://localhost:<port>` and `http://127.0.0.1:<port>` origins are echoed in
`Access-Control-Allow-Origin` (with `Vary: Origin`). `OPTIONS` answers `204` with `Allow`; for an allowed origin it
adds `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers: Content-Type` and `Max-Age: 600`. Other origins
get no CORS headers.

## Adapter registry
`apps/api/src/adapters.ts`:
```ts
type AdapterFactory = (ctx: { env; now: () => Date }) => PaymentAdapter | Promise<PaymentAdapter>;
export const adapterRegistry: Record<Rail, AdapterFactory | undefined> = {
  mock: (ctx) => createMockAdapter(ctx),     // apps/api mock: always succeeded
  paypal: paypalFactory,                     // createPayPalAdapter(payPalConfigFromEnv(ctx.env)): Payouts v1 sandbox
  near: nearFactory,                         // createNearAdapter + JSON-RPC client from nearConfigFromEnv(ctx.env): testnet native transfer
};
```
All three rails are wired. `createAdapter(rail, ctx)` still throws `adapter_not_wired` for a slot left `undefined` and `adapter_mismatch` if the factory returns an adapter for a different rail. When a factory's env config fails, it throws `AdapterConfigError` with `missing` set to the unset names from `RAIL_REQUIRED_ENV` (`paypal`: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`; `near`: `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY`), which `startup-error.ts` prints. PayPal here is **Payouts v1** (`createPayPalAdapter`), not Orders v2; the Orders v2 module (`paypal-orders`) is not in the registry, so `RAIL=paypal-orders` is `unknown_rail`. Neither `paypal` nor `near` implements refund.
