# @agent-pay/api

`node:http` server, no runtime deps. `createApp(options)` / `createServer(options)` are exported from
`apps/api/src/index.ts` for tests; `src/main.ts` is the entrypoint (`npm start -w @agent-pay/api`).

## Env vars
| var | default | |
|---|---|---|
| `PORT` | `8787` | `0` = random port |
| `HOST` | `127.0.0.1` | bind address |
| `LEDGER_PATH` | `apps/api/.data/ledger.json` (resolved from the api package, gitignored) | single writer process per file |
| `RAIL` | `mock` | `mock` \| `paypal` \| `near`. `near` is not wired yet and exits at startup with `adapter_not_wired: near adapter not wired yet` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BASE_URL?` | | only for `RAIL=paypal` (sandbox, from your shell env; never commit). Missing → exits at startup with `adapter_config: …` |

## Policy
Kept **in memory** (one policy, one agent), seeded with `DEFAULT_POLICY`:
`{agentId: "demo-agent", perTxMax: 100, dailyMax: 200, allowedPayees: ["openai-api","anthropic-api","vercel","near-compute"], requireApprovalAbove: 50, currency: "USD"}`.
`PUT /policy` replaces it until restart. The ledger is on disk; the policy is not.

## Endpoints
All bodies are JSON. Errors are `{"error": "<code>: <detail>"}`.

| method & path | request | response |
|---|---|---|
| `GET /health` | | `200 {ok: true, rail}` |
| `POST /intents` | `{agentId, payee, amount, currency, purpose, id?, createdAt?}` | `201` (new) / `200` (replay) `PaymentResult & {intent}` = `{intentId, status: paid\|rejected\|needs_approval\|failed, decision, receipt?, error?, replayed?, intent}` |
| `POST /intents/:id/approve` | optional `{approver?}` | `200 PaymentResult` (`paid`, or `rejected` if the re-check fails) |
| `POST /intents/:id/reject` | optional `{approver?, note?}` | `200 PaymentResult` (`rejected`, reason `rejected_by_human: …`) |
| `POST /intents/:id/refresh` | optional empty body | `200 PaymentResult & {changed: boolean}` — polls the adapter's `status()` for a **pending** receipt on this rail; settles the ledger when the rail reports `succeeded` or `failed`. Still `pending` → `changed: false`, no ledger write. |
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

**Status codes:** `400` `invalid_body` / `invalid_json` / `invalid_path`; `404` `not_found` (route) or
`intent_not_found`; `405` `method_not_allowed` (with `Allow`); `409` `already_paid`, `not_pending`, `in_progress`,
`intent_conflict`, `no_receipt`, `receipt_not_pending`, `status_unsupported`; `502` `status_check_failed`; `413` `payload_too_large` (body cap 64 KiB); `500` `internal_error`. Policy rejections are not
HTTP errors: they come back as `status: "rejected"` results.

**CORS:** only `http://localhost:<port>` and `http://127.0.0.1:<port>` origins are echoed in
`Access-Control-Allow-Origin` (with `Vary: Origin`). `OPTIONS` answers `204` with `Allow`; for an allowed origin it
adds `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers: Content-Type` and `Max-Age: 600`. Other origins
get no CORS headers.

## Adapter registry (개발팀3 hook)
`apps/api/src/adapters.ts`:
```ts
type AdapterFactory = (ctx: { env; now: () => Date }) => PaymentAdapter | Promise<PaymentAdapter>;
export const adapterRegistry: Record<Rail, AdapterFactory | undefined> = {
  mock: (ctx) => createMockAdapter(ctx),     // apps/api mock: always succeeded
  paypal: paypalFactory,                     // createPayPalAdapter(payPalConfigFromEnv(ctx.env)) from @agent-pay/adapters
  near: undefined,                           // not wired yet
};
```
Wire a rail by replacing its `undefined` with a factory (e.g. `near: (ctx) => createNearAdapter(nearConfigFromEnv(ctx.env))`).
Note: the PayPal adapter does Orders v2 create + capture; without buyer approval PayPal answers `ORDER_NOT_APPROVED`,
which comes back as a `failed` result (see packages/adapters/README.md). `createAdapter(rail, ctx)` throws `adapter_not_wired` for
an empty slot and `adapter_mismatch` if the factory returns an adapter for a different rail.
