# @agent-pay/agent

Demo task-agent CLI. It takes a task ("buy 1M tokens of GPT inference") or a built-in scenario, asks a
**Planner** for a quote, submits it with `POST /intents`, and when the policy says `needs_approval` it waits
for a human by polling `GET /ledger`. Every run starts with `GET /health`: it prints the server's rail and exits 1
at once if the API is unreachable (connection refused, 5 s timeout) or `/health` is not 2xx. No runtime deps beyond `@agent-pay/core` types and Node built-ins
(global `fetch`, `node:util` `parseArgs`). No API keys, no LLM calls.

## Run

```sh
npm start -w @agent-pay/api                                   # terminal 1: API on :8787, RAIL=mock

npm run agent -w @agent-pay/agent -- --scenario small          # terminal 2
npm run agent -w @agent-pay/agent -- --scenario over-limit
npm run agent -w @agent-pay/agent -- --scenario needs-approval --auto-approve-as alice
npm run agent -w @agent-pay/agent -- --scenario needs-approval   # then approve it yourself:
#   curl -X POST localhost:8787/intents/<id>/approve -H 'content-type: application/json' -d '{"approver":"alice"}'
npm run agent -w @agent-pay/agent -- "rent a GPU on NEAR for 3 hours"
npm run agent -w @agent-pay/agent -- --scenario small --json
```

Use `npm run -s ...` to hide npm's own banner and its error footer on non-zero exits.

| Option | Default | |
|---|---|---|
| `<task...>` / `--task <text>` | | Free-text task for the planner |
| `--scenario <name>` | | `small`, `over-limit`, or `needs-approval` (mutually exclusive with a task) |
| `--api <url>` | `http://127.0.0.1:8787` | API base URL |
| `--rail <name>` | | Expected server rail (`mock`, `paypal`, `near`, …). If `GET /health` reports another rail, exit 1 (`rail_mismatch`) before any intent is sent |
| `--agent-id <id>` | `demo-agent` | `agentId` on the intent |
| `--timeout-ms <n>` | `120000` | How long to wait for a human decision, and (separately) for a pending receipt to settle |
| `--poll-ms <n>` | `1000` | `GET /ledger` poll interval while waiting for approval; `POST /intents/:id/refresh` interval while a receipt is pending |
| `--auto-approve-as <name>` | | **Demo only: simulates the human.** After printing the "waiting for human approval" step, the CLI itself calls `POST /intents/:id/approve {"approver": name}`. The API cannot tell it apart from a real approval. |
| `--approve-delay-ms <n>` | `1000` | Pause before the simulated approval, so the wait is visible on screen |
| `--json` | off | NDJSON output (below) |
| `--help` | | Usage |

Each HTTP request has a 10 s timeout.

## Scenarios

Each scenario is a task string run through `RuleBasedPlanner` (10 USD per 1M GPT tokens), sized for the
seed policy (`demo-agent`: perTxMax 100, dailyMax 200, approval above 50, USD).

| Scenario | Task | Quote | Outcome |
|---|---|---|---|
| `small` | buy 1M tokens of GPT inference | 10 USD → openai-api | paid (auto-approved) |
| `over-limit` | buy 15M tokens of GPT inference | 150 USD → openai-api | rejected, `per_tx_limit_exceeded` |
| `needs-approval` | buy 7.5M tokens of GPT inference | 75 USD → openai-api | `needs_approval` → human approves → paid |

When `POST /intents` or `/approve` returns `paid` with a **pending** receipt (or the approval poll sees the same), the agent
enters **`await_receipt`**: it calls `POST /intents/:id/refresh` every `--poll-ms` until the receipt is `succeeded`
(→ `paid`, exit 0) or `failed` (→ `failed`, exit 1), or `--timeout-ms` elapses, measured from the start of the receipt
wait (→ `receipt_pending`, exit 3). A **`refresh`** step (`from`, `to`, `receiptStatus`) is emitted only when the receipt
status changes. `409 receipt_not_pending` (settled elsewhere, e.g. by `reconcile`) → read `GET /ledger` and finish from
it; `409 no_receipt` / `status_unsupported` → finish `receipt_pending` at once; `5xx` (e.g. `502 status_check_failed`)
or network errors are retried until the timeout, with one `refresh` step per distinct error; other `4xx` → `error`
(exit 1). The default mock rail always returns `succeeded`, so this path only runs on rails that return `pending`.

Paid amounts count toward the 200 USD daily max, so on one ledger the third `needs-approval` run of a UTC
day is rejected with `daily_limit_exceeded`. Use a fresh `LEDGER_PATH` to reset.

## Exit codes

| Code | Status | Meaning |
|---|---|---|
| 0 | `paid` | Payment went through |
| 2 | `rejected` | Rejected by policy or by a human |
| 3 | `approval_timeout` / `receipt_pending` | Still `needs_approval` after `--timeout-ms`, or receipt still `pending` after the receipt wait |
| 1 | `failed` / `error` | Payment failed on the rail, or the agent could not finish: bad arguments, planner error, API down (`api_unreachable`, `health_check_failed`), `--rail` mismatch (`rail_mismatch`), HTTP error |

## Human output

First a `server: <api url> rail=<rail>` line from `GET /health`, then one `[step] message` line per step, then
`Done: <status> (exit N)` plus `Reason:`, `Receipt:` or `Error:` lines.

```
server: http://127.0.0.1:8787 rail=mock
[task] scenario "needs-approval": buy 7.5M tokens of GPT inference
[quote] rule-based quoted 75 USD to openai-api (buy 7.5M tokens of GPT inference (7.5 x 1M tokens @ 10 USD))
[submit_intent] POST http://127.0.0.1:8787/intents as demo-agent
[intent_result] needs_approval: approval_required: amount 75 is above approval threshold 50
[await_approval] waiting for human approval (simulated by --auto-approve-as "alice")
[auto_approve] simulated human "alice" calls POST /intents/pi_…/approve
[approve_result] paid: approved_by_human: approved by "alice"; 75 USD to "openai-api" is within hard limits
Done: paid (exit 0)
```

## `--json` format: NDJSON

stdout carries one JSON object per line: a `step` event per step, then exactly one `summary` line, always last.
Argument errors caught before the run starts go to stderr only (exit 1, no NDJSON). The first line is the `health`
step; if the API is down the output is just an `error` step and an `error` summary; a `--rail` mismatch gives
`health`, `error`, `summary`.

```jsonc
// step event
{ "type": "step", "step": "<step>", "ts": "<ISO 8601>", "message": "<human text>", "intentId": "pi_…" /* once known */, ... }
// final line
{ "type": "summary", "ts": "…", "status": "paid|rejected|approval_timeout|receipt_pending|failed|error", "exitCode": 0,
  "task": "…", "scenario": "small" /* if used */, "quote": { "payee", "amount", "currency", "purpose" },
  "intentId": "pi_…", "receipt": { "intentId", "rail", "externalId", "status", "at" } /* if any */,
  "reason": "<code>: <detail>" /* policy or human decision */, "error": "…" /* status error only */ }
```

| `step` | Extra fields |
|---|---|
| `health` | `apiUrl`, `rail` (`unknown` if `/health` has none), `expectedRail` (with `--rail`); always the first line when the API is up |
| `task` | `task`, `scenario` |
| `quote` | `planner`, `quote` |
| `submit_intent` | `agentId` |
| `intent_result` | `apiStatus` (`paid`/`rejected`/`needs_approval`/`failed`), `reason` |
| `await_approval` | `timeoutMs`, `pollMs`, `autoApproveAs` |
| `auto_approve` | `approver` |
| `approve_result` | `apiStatus` or `httpStatus` (409 when someone else decided first) |
| `poll` | `ledgerStatus` (`pending`/`paid`/`rejected`/`failed`); emitted only when it changes |
| `await_receipt` | `timeoutMs`, `pollMs` |
| `refresh` | `from`, `to`, `receiptStatus`; optional `error`, `httpStatus` on retryable failures |
| `error` | `httpStatus` for HTTP errors |

Absent fields are omitted. In-process callers get the same events through `runAgent(options, { emit })`.

## Planner

```ts
interface Quote { payee: string; amount: number; currency: string; purpose: string }
interface PlannerContext { agentId: string; currency?: string }
interface Planner { readonly name: string; plan(task: string, ctx: PlannerContext): Promise<Quote> }
```

`RuleBasedPlanner` matches whole-word keywords against `PRICE_TABLE`, first match wins: claude/anthropic →
anthropic-api, gpt/openai → openai-api (10 USD per 1M tokens), vercel/deploy/hosting → vercel (20 USD per
deploy), near/gpu/compute → near-compute (5 USD per hour), and plain tokens/inference → openai-api. Quantities
like `1M tokens`, `500k tokens`, `2.5M`, `3 hours`, `2 deploys` are parsed; the default is 1. No match throws
`PlannerError` (exit 1). Pass a custom table with `new RuleBasedPlanner(table)`.

**LLM hook:** write `class LlmPlanner implements Planner` that asks a model for a Quote JSON, validates it,
and throws `PlannerError` on bad output. Then pass it as `runAgent({ ..., planner })` or return it from the
`'llm'` branch of `createPlanner` (currently throws `not_implemented`). The policy engine still decides, so a
bad quote is caught by the API.

## In-process

```ts
import { runAgent } from '@agent-pay/agent';
const result = await runAgent(
  { apiUrl: 'http://127.0.0.1:8787', agentId: 'demo-agent', scenario: 'small' },
  { emit: (event) => {}, writeLine: (line) => {} }, // both optional; writeLine defaults to console.log
);
// result: { status, exitCode, task, scenario?, quote?, intentId?, receipt?, reason?, error? }; never throws
```

`runAgent` options also take `expectedRail` (the CLI's `--rail`) and `healthCheck: false` to skip `GET /health`.

## Tests

`npm test -w @agent-pay/agent` starts `apps/api` with `createServer` on port 0, a temp `LEDGER_PATH`, and the
mock rail, then drives the agent in-process and as a child process (scenarios, external approve/reject,
approval timeout, API down / non-2xx `/health`, `--rail` mismatch, `--json` shape, exit codes) plus `RuleBasedPlanner` unit tests.
