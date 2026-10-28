# agent-pay: project description

## One-paragraph summary

agent-pay is a policy-guarded payment layer for AI agents. Instead of handing an agent a payment API key, the
agent submits a payment intent to a local HTTP API; a pure policy engine checks it against a per-transaction max,
a daily max, a payee allowlist, the policy currency and an approval threshold, and the result is `approved`,
`rejected` or `needs_approval`. Every intent, decision, payment and receipt is written in a fixed order to a JSON
ledger, retries of the same intent never pay twice, and payments above the threshold wait until a human approves
them over HTTP (limits are re-checked at approval time). Only approved intents reach a rail adapter. The demo was
recorded on a mock rail with no real funds; the same flow is wired to PayPal Payouts sandbox (`RAIL=paypal`) and
NEAR testnet (`RAIL=near`) adapters.

## Full description

### Problem

An AI agent that can spend money needs more than credentials for a payment provider. Without guard rails it can
overspend in one payment or across a day, pay someone it should not pay, pay twice when a request is retried, make
large payments no human has looked at, or report a payment as done while the rail has not settled it.

### How it works

The agent never calls a payment rail directly. It sends an intent (`agentId`, `payee`, `amount`, `currency`,
`purpose`) to `POST /intents`. The policy engine returns `approved`, `rejected` (for example
`per_tx_limit_exceeded`) or `needs_approval`. Approved intents go to the configured rail adapter, and the API
answers `paid` with a receipt (or `failed` if the rail declines). Intents that need approval wait for
`POST /intents/:id/approve` or `/reject`.

On the mock rail the demo policy allows 100 USD per transaction and 200 USD per day, requires approval above 50 USD,
and allows four payees. A task-agent CLI turns a task such as "buy 1M tokens of GPT inference" into a quote, submits
it, waits for a human if needed, and exits 0 (paid), 2 (rejected), 3 (timed out) or 1 (failed or error). It first
calls `GET /health` and prints the server's rail; `--rail` stops it if the API runs another one. The planner is
rail-agnostic: `GET /rail` maps its logical payees and USD amounts to rail addresses and currency (on NEAR, 10 USD
becomes 0.1 NEAR). A React web demo walks the same pipeline; its Mock/PayPal/NEAR toggle shows the API's rail.

### Safety

- Hard limits and the payee allowlist are checked before any rail call, and again when a human approves.
- Re-sending an identical intent returns the stored result instead of paying again; the same id with different
  fields is a `409 intent_conflict`.
- The ledger enforces intent, decision, payment, receipt order and one payment per intent, and writes atomically.
- A `pending` receipt is not final: `POST /intents/:id/refresh` asks the rail for its status, and a payment that
  turns out `failed` stops counting toward the daily total.
- The API binds to `127.0.0.1` by default. PayPal and NEAR credentials are read only from the environment; a missing
  one stops startup with its name, never its value.

### Tech stack

TypeScript run directly by Node 24. Core, API and agent CLI have no third-party runtime
dependencies. The web demo uses React and Vite. The `paypal` adapter targets PayPal Payouts v1 sandbox
(email payee, status refresh, no refund). The `near` adapter signs one native NEAR testnet transfer through a
zero-dependency JSON-RPC client; transfers are final (no refund). Neither has been run against the live services
yet. A PayPal Orders v2 module (`paypal-orders`) stays adapter-side only.

### Next steps

- Add an LLM planner behind the existing `Planner` interface; the policy engine still has the final say.
- Persist policies, support several agents, and replace the single-writer JSON ledger with a database.
