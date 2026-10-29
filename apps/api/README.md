# @agent-pay/api

`node:http` server, no runtime deps. `createApp(options)` / `createServer(options)` are exported from
`apps/api/src/index.ts` for tests; `src/main.ts` is the entrypoint: `npm run api` from the repo root (loads the root `.env` only if it exists), or
`npm start -w @agent-pay/api` (no `.env` loading).

## Env vars
| var | default | |
|---|---|---|
| `PORT` | `8787` | `0` = random port |
| `HOST` | `127.0.0.1` | bind address |
| `LEDGER_PATH` | `apps/api/.data/ledger.json` (resolved from the api package, gitignored) | single writer process per file |
| `RAIL` | `mock` | `mock` \| `paypal` (PayPal Payouts v1, sandbox) \| `near` (NEAR testnet native transfer). Missing credentials for a wired rail → exits 1 at startup with `adapter_config: …` plus `missing required env vars for RAIL=<rail>: <names>` (names only, no values, no stack trace) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL?`, `PAYPAL_TIMEOUT_MS?` | | only for `RAIL=paypal` (sandbox, from your shell env; never commit). `PAYPAL_TIMEOUT_MS` — positive integer HTTP timeout in ms (default `30000`) |
| `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY`, `NEAR_NETWORK?`, `NEAR_RPC_URL?` | | only for `RAIL=near`; `NEAR_RPC_URL` defaults to `https://test.rpc.fastnear.com` on testnet |
| `DEMO_PAYEES` | | optional for `RAIL=paypal` or `near` only: comma-separated `name=address` pairs (whitespace trimmed). When non-empty, **replaces** the default logical→address map entirely. Invalid syntax or payee for the rail → startup error `demo_payees: … (RAIL=…)`. Ignored for `mock`. |

All names are listed in the root [.env.example](../../.env.example); `npm run api` (root script:
`node --env-file-if-exists=.env apps/api/src/main.ts`) loads a filled-in copy when one exists. Startup errors are formatted by `src/startup-error.ts`: an error carrying a `missing` /
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
Seed scripts and tooling can import `DEFAULT_POLICY` from `apps/api/src/policy-defaults.ts` (side-effect free; no server or ledger I/O).

Kept **in memory** (one policy, one agent), seeded from `railSeed` (mock uses exported `DEFAULT_POLICY` unchanged):
`PUT /policy` replaces it until restart. After the JSON shape check, the next policy is passed to core `policyProblem` with `{ dailyTotal: 0 }`. A problem is `400 {"error":"invalid_policy","message":"<problem>"}` and the active policy is left unchanged. The ledger is on disk; the policy is not.

## Endpoints
All bodies are JSON. Errors are `{"error": "<code>", "message": "<detail>"}`.

| method & path | request | response |
|---|---|---|
| `GET /health` | | `200 {ok: true, rail}` |
| `GET /rail` | | `200 {rail, currency, amountScale, payees}` — demo mapping for agents (defaults: policy currency, scale 1, `{}`) |
| `POST /intents` | `{agentId, payee, amount, currency, purpose, id?, createdAt?}`; optional `Idempotency-Key` header | `201` (new) / `200` (replay) `PaymentResult & {intent}` = `{intentId, status: paid\|rejected\|needs_approval\|failed, decision, receipt?, error?, replayed?, intent}` |
| `POST /intents/:id/approve` | optional `{approver?}` | `200 PaymentResult` (`paid`, or `rejected` if the re-check fails) |
| `POST /intents/:id/reject` | optional `{approver?, note?}` | `200 PaymentResult` (`rejected`, reason `rejected_by_human: …`) |
| `POST /intents/:id/refresh` | optional empty body | `200 PaymentResult & {changed: boolean}` — polls the adapter's `status()` for a **pending** receipt on this rail; settles the ledger when the rail reports `succeeded` or `failed`. Still `pending` → `changed: false`, no ledger write. |
| `POST /intents/:id/resolve` | `{status: succeeded\|failed\|refunded, note, resolvedBy, externalId?}` | `200 PaymentResult & {changed: true, resolution}` — operator settles a **pending** receipt by hand; never calls the adapter (see below) |
| `GET /ledger` | | `200 {entries: LedgerEntry[], today: {day: "YYYY-MM-DD", totals: {[agentId]: {[currency]: number}}}}` |
| `GET /policy` | | `200 Policy` |
| `PUT /policy` | full `Policy` | `200 Policy`, or `400 invalid_policy` (active policy unchanged) |

**Client-supplied intent fields:** `agentId`, `payee`, `amount` (finite number > 0), `currency`, `purpose` are
required. If `currencyDecimals(currency)` is defined and `amount` has more decimal places than that (`toMinorUnits` is undefined), the response is `400 {"error":"invalid_amount","message":…}` before any ledger write or `pay()`. Unknown currencies are not rejected here; core evaluates them. `id` (1–128 chars of `[A-Za-z0-9._:-]`) and `createdAt` (ISO 8601 with a zone) are optional; the server
fills in `pi_<uuid>` and the current time. Unknown fields are rejected. Core replay needs a deep-equal intent, so a
different body for the same id is `409 intent_conflict`. Optional header `Idempotency-Key` uses the same charset as
`id` (invalid → `400 invalid_header`). When the body omits `id`, that key is the intent id; when both are set they
must match (`400 invalid_body` if they differ). If `createdAt` is omitted and that id is already stored, the server
reuses the stored `createdAt` so the retry replays.

**GET /ledger response** — shape:

```json
{"entries":[...],"today":{"day":"2026-10-29","totals":{"demo-agent":{"USD":87}}}}
```

`entries` are core `LedgerEntry` objects as stored, including `decisions`: every decision, oldest first, as
`{status, reason, at, actor?}` (`actor` is `policy` or the approver). `decision` is still the latest one.

`today.day` is core `accountingDay` for the server clock (UTC day of approval time, not `intent.createdAt`).
`today.totals` is nested per agent (`agentId` → `{CURRENCY: amount}`); amounts come from
`Ledger.dailyTotals(agentId, day)`. An agent with no counted spend for that day (e.g. spend dropped when
`pending` → `failed`) maps to `{}`. No currency scalar and no `totalsByCurrency`.

**Refresh contract:** `404 intent_not_found`; `409 no_receipt` (no receipt on the entry, e.g. rejected); `409 receipt_not_pending` when the receipt is already settled (`succeeded` / `failed` / `refunded`) — **409 instead of 200 `changed: false`** so clients know the intent is final and can read `GET /ledger`; `409 status_unsupported` when the adapter has no `status()` or the receipt rail differs. An entry flagged `needsManualResolve` (or a pending receipt whose `meta.needsManualResolve` is `true` / `"true"` when refresh already refuses with `status_unsupported`) is also `409 status_unsupported`, and `message` tells the caller to use `POST /intents/<id>/resolve` with that intent id. `502 status_check_failed` when `status()` throws or returns an invalid receipt (nothing stored).

**Resolve contract (operator, `POST /intents/:id/resolve`):** for pending receipts that `status()` cannot settle, e.g. PayPal
receipts with `meta.needsManualResolve: "true"` (duplicate `sender_batch_id` guesses, 5xx / network errors with no batch id,
batches with 2+ items). The route never calls the adapter (`pay()` or `status()`); it only writes the ledger.
- Body: `status` required, one of `succeeded` / `failed` / `refunded` (`pending` is rejected); `note` required, non-empty
  (≤1000 chars); `externalId` optional (≤256 chars, replaces the stored rail id, e.g. the real PayPal batch id; omitted =
  keep it); `resolvedBy` required operator name, non-empty after trimming (≤128 chars, no default; missing, empty or
  whitespace-only → `400 invalid_body`). Unknown fields → 400.
- Ledger: the receipt gets the new `status` / `externalId` / `at` (other receipt fields such as `meta` are kept), and the
  entry gets `resolution: {status, resolvedBy, note, at, previousExternalId}`.
- Daily total: `failed` also marks the payment failed, so the amount is freed; `succeeded` and `refunded` keep counting
  (same rule as `countsTowardDailyTotal`: refunds do not free budget).
- Response `200`: `{intentId, decision, status: "paid"|"failed", receipt, changed: true, resolution, error?}`
  (`error: "payment_failed: resolved as failed by <resolvedBy>"` for `failed`).
- Errors: `400 invalid_body` / `invalid_json`; `404 intent_not_found`; `409 no_receipt`; `409 receipt_not_pending`
  (already settled, including a second resolve).
- No auth: like the rest of this demo API it is meant for localhost only; `resolvedBy` is self-reported.

**Error body:** every error response is JSON `{"error":"<code>","message":"<detail>"}` with `Content-Type: application/json`. `error` is a bare machine code (no `:`). `message` is the detail after `"<code>: "` on `ValidationError`, `HttpError`, `PaymentError`, and `LedgerError` (if there is no detail, `message` is the code). Unknown errors are `500` `{"error":"internal_error","message":"unexpected server error"}` and do not include the thrown message. If the last-resort handler finds headers already sent, it ends the response without a second body.

For `POST /intents/:id/approve`, `reject`, intent replay, and `refresh`, the web UI handles these `409` codes:
`not_pending`, `already_paid`, `in_progress`, `status_unsupported`. Other `409`s keep their own codes in the table
below (`intent_conflict`, `no_receipt`, `receipt_not_pending`, `precondition_failed`, `duplicate_intent` unchanged).

| Status | `error` codes |
| --- | --- |
| 400 | `invalid_body`, `invalid_json`, `invalid_path`, `invalid_header`, `invalid_input`, `invalid_amount`, `invalid_policy` |
| 403 | `forbidden_origin` |
| 404 | `not_found` (route or ledger), `intent_not_found` |
| 405 | `method_not_allowed` (`Allow` header) |
| 409 | `already_paid`, `not_pending`, `in_progress`, `intent_conflict`, `no_receipt`, `receipt_not_pending`, `status_unsupported`, `precondition_failed`, `duplicate_intent` |
| 413 | `payload_too_large` (body cap 64 KiB) |
| 415 | `unsupported_media_type` (non-empty body whose `Content-Type` is not `application/json`, including a missing type) |
| 500 | `internal_error` |
| 502 | `status_check_failed` |
| 503 | `lock_timeout` (`Retry-After: 1`, message says to retry), `ledger_corrupt`, `ledger_missing` |

Policy rejections are not HTTP errors: they come back as `status: "rejected"` results.

**CORS:** only `http://localhost:<port>` and `http://127.0.0.1:<port>` origins are echoed in
`Access-Control-Allow-Origin` (with `Vary: Origin`). `OPTIONS` answers `204` with `Allow`; for an allowed origin it
adds `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers: Content-Type, Idempotency-Key`, `Access-Control-Expose-Headers: Date`, and `Max-Age: 600`. Other origins
get no CORS headers.

**Origin (CSRF):** for methods other than `GET`, `HEAD`, and `OPTIONS`, if the request sends an `Origin` header that
is not allowed, the server responds `403` `{"error":"forbidden_origin","message":…}` before the route handler runs or the body is read;
requests with no `Origin` are unchanged.

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
