# agent-pay: project description

## One-paragraph summary

agent-pay is a policy-guarded payment layer for AI agents. Instead of handing an agent a payment API key, the
agent submits a payment intent to a local HTTP API; a pure policy engine checks it against a per-transaction max,
a daily max, a payee allowlist, the policy currency and an approval threshold, and the result is `approved`,
`rejected` or `needs_approval`. Every intent, decision, payment and receipt is written in a fixed order to a JSON
ledger, retries of the same intent never pay twice, and payments above the threshold wait until a human approves
them over HTTP (limits are re-checked at approval time). Only approved intents reach a rail adapter. The demo runs
on a mock rail with no real funds; a PayPal sandbox adapter (Orders v2) exists, and a NEAR rail is planned but not
wired yet.

## Full description

### Problem

An AI agent that can spend money needs more than credentials for a payment provider. Without guard rails it can
overspend in one payment or across a day, pay someone it should not pay, pay twice when a request is retried, make
large payments no human has looked at, or report a payment as done while the rail has not settled it.

### How it works

The agent never calls a payment rail directly. It sends an intent (`agentId`, `payee`, `amount`, `currency`,
`purpose`) to `POST /intents`. The policy engine evaluates it and returns `approved` (`within_policy`), `rejected`
(for example `per_tx_limit_exceeded`) or `needs_approval` (`approval_required`). Approved intents go to the
configured rail adapter, and the API answers `paid` with a receipt (or `failed` if the rail declines). Intents that need approval are stored and wait
for `POST /intents/:id/approve` or `/reject`. `GET /ledger` returns every entry plus today's totals.

The demo policy for `demo-agent` allows up to 100 USD per transaction and 200 USD per day, requires approval above
50 USD, and allows four payees: `openai-api`, `anthropic-api`, `vercel` and `near-compute`. A task-agent CLI turns
a task such as "buy 1M tokens of GPT inference" into a quote, submits it, waits for a human when needed, and exits
with 0 (paid), 2 (rejected), 3 (approval or receipt wait timed out) or 1 (failed or error). `--json` prints NDJSON for automation. A
React web demo walks the same pipeline step by step: task, quote, policy, decision, approval, payment, receipt.

### Safety

- Hard limits and the payee allowlist are checked before any rail call, and again when a human approves.
- Re-sending an identical intent (same `id`, `createdAt` and fields) returns the stored result instead of paying again; the same id with different
  fields is a `409 intent_conflict`.
- The ledger enforces intent, decision, payment, receipt order, allows one payment per intent, and writes
  atomically.
- A `pending` receipt is not final: `POST /intents/:id/refresh` asks the rail for its status, and a payment that
  turns out `failed` stops counting toward the daily total.
- The API binds to `127.0.0.1` by default, the mock rail needs no credentials, and PayPal sandbox credentials are
  read only from the environment.

### Tech stack

TypeScript run directly by Node 24 (type stripping, no build step). Core, API and agent CLI have no third-party
runtime dependencies: `node:http`, a JSON-file ledger and `node:test`. The web demo uses React, Vite and Vitest. The PayPal
adapter calls the PayPal REST Orders v2 sandbox (OAuth, create order, capture, refund).

### Next steps

- Wire the NEAR rail. The slot exists, but `RAIL=near` currently stops at startup with `adapter_not_wired`.
- Make PayPal usable for unattended agents. Today the adapter creates and captures an order; without buyer
  approval PayPal answers `ORDER_NOT_APPROVED`, which is recorded as a `failed` payment.
- Add an LLM planner behind the existing `Planner` interface; the policy engine still has the final say.
- Persist policies, support several agents, and replace the single-writer JSON ledger with a database.
