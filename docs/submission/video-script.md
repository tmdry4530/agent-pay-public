# agent-pay: demo video script

Total length: 2:50 (170 s, limit 2:55). Narration is paced at about 150 words per minute (2.5 words per second);
each scene lists its narration word count against the words its time slot allows.

## Timing

| ID | Title | Start–end | Duration |
| --- | --- | --- | --- |
| S1 | Intro | 0:00–0:20 | 20 s |
| S2 | $12 payment paid | 0:20–0:45 | 25 s |
| S3 | Over-limit payment rejected | 0:45–1:05 | 20 s |
| S4 | $75 payment waiting for approval | 1:05–1:30 | 25 s |
| S5 | Approved, then paid | 1:30–1:50 | 20 s |
| S6 | Ledger view | 1:50–2:10 | 20 s |
| S7 | Intents & manual resolve | 2:10–2:30 | 20 s |
| S8 | CLI `--json` output | 2:30–2:50 | 20 s |
| | **Total** | **0:00–2:50** | **170 s** |

Scene *N* below is scene ID S*N*; the scene headings keep the `### Scene N — Title (m:ss–m:ss, N s)` form.

## Recording setup

- Seed one uncertain payment for S7 before the API starts (the API has no simulation path; the seed writes the
  ledger file with the real core functions and the mock rail):
  `LEDGER_PATH=/tmp/agent-pay-demo/ledger.json npm run demo:seed-needs-check` on a fresh, empty ledger path. It adds
  "Buy API credits (rail error)" ($12.00, the rail call threw, so the outcome is unknown) and "Deploy preview
  (stuck)" ($20.00, left in `submitting` two minutes in the past). Both are approved and hold the daily limit, so
  "Spent today" starts at $32.00.
- API on the mock rail with that ledger (no real funds move):
  `RAIL=mock LEDGER_PATH=/tmp/agent-pay-demo/ledger.json npm run api` → `http://127.0.0.1:8787`, `rail=mock`
  (`npm run api` loads the root `.env` if one exists; `RAIL=mock` in the shell takes precedence over it).
- Web demo against that API, from `apps/web`: `VITE_API_BASE=http://127.0.0.1:8787 pnpm dev`. The header badge
  shows `API: http://127.0.0.1:8787`. The rail toggle (**Mock** / **PayPal** / **NEAR**) is disabled in this mode
  and only highlights the rail the API reports on `GET /health` (**Mock**), with the note "Rail is selected by the
  API server: mock". (Without `VITE_API_BASE` the web demo runs fully in the browser with an in-memory ledger: the
  header badge reads `MOCK — no real funds`, and the toggle can be switched before a run, but all three options use
  simulated adapters, so receipts show rail "Mock", "PayPal (mock)" or "NEAR (mock)".)
- The web scenario cards are fixed: **Buy API credits** (`openai-api`, $12.00), **Rent GPU cluster**
  (`near-compute`, $480.00), **Buy NEAR compute hours** (`near-compute`, $75.00). Each run is: click the card →
  **Get quote** → **Run policy check & pay**. The web approver name is `demo-operator`; the S7 operator types
  `ops-bob`.
- Scenes S2–S7 run in this order on that one ledger, so "Spent today" goes $32.00 → $44.00 (S2) → $44.00 (S3) →
  $44.00 (S4) → $119.00 (S5) → $107.00 (S7, after the seeded $12.00 payment is resolved as failed).

## Scenes

### Scene 1 — Intro (0:00–0:20, 20 s)

**On screen:** Web demo, initial state. Three scenario cards on the left ("Demo scenarios"); the pipeline stepper
(Task, Quote, Policy, Decision, Approval, Payment, Receipt) in the middle, with the disabled **Mock** / **PayPal** /
**NEAR** rail toggle (Mock highlighted) and "Rail is selected by the API server: mock" under it; "Spending limit"
panel on the right reading "Per-tx max $100.00 · approval above $50.00", "Spent today $32.00", "Daily max $200.00";
the Ledger and Intents panels below it hold only the two seeded entries.

**Narration (44 words / max 50):**
AI agents are starting to spend money, but an API key alone has no limits. agent-pay puts a policy between the
agent and the payment rail. This agent may spend one hundred dollars per payment, two hundred per day, and
needs approval above fifty.

### Scene 2 — $12 payment paid (0:20–0:45, 25 s)

**On screen:** Click **Buy API credits** ($12.00, `openai-api`) → **Get quote** (PaymentIntent draft: payee
`openai-api`, amount $12.00) → **Run policy check & pay**. Decision card: Decision "Approved", reason code
`within_policy`, "amount 12 USD to "openai-api" is within policy"; Payment outcome badge "PAID", "Payment
succeeded". Receipt card: status `succeeded`, rail Mock, external ID `mock_…`. Gauge: "Spent today $44.00".

**Narration (49 words / max 62):**
First task: buy twelve dollars of API credits from openai-api. The agent turns the task into a payment intent and
sends it to the API. The policy engine checks amount, payee, and daily total. It is within policy, so the mock
rail pays it and returns a succeeded receipt.

### Scene 3 — Over-limit payment rejected (0:45–1:05, 20 s)

**On screen:** Click **Rent GPU cluster** ($480.00, `near-compute`) → **Get quote** → **Run policy check & pay**.
Decision card: Decision "Rejected", reason code `per_tx_limit_exceeded`, "amount 480 exceeds per-transaction max
100"; Status badge "REJECTED". No receipt card. Gauge still "Spent today $44.00".

**Narration (47 words / max 50):**
Next, the agent tries to rent a GPU cluster for four hundred eighty dollars. That is above the one hundred dollar
per-transaction limit, so the policy rejects it with per_tx_limit_exceeded. The payment rail is never called, no
receipt is created, and the daily total does not move.

### Scene 4 — $75 payment waiting for approval (1:05–1:30, 25 s)

**On screen:** Click **Buy NEAR compute hours** ($75.00, `near-compute`) → **Get quote** → **Run policy check &
pay**. Stepper stops at Approval. Decision card: Decision "Needs approval", reason code `approval_required`,
"amount 75 is above approval threshold 50"; Status badge "NEEDS APPROVAL". **Approve** and **Deny** buttons
appear. Gauge still "Spent today $44.00".

**Narration (55 words / max 62):**
Now seventy-five dollars of NEAR compute hours. It is inside the hard limits but above the fifty dollar approval
threshold, so the decision is needs approval. Nothing is paid yet. The intent sits in the ledger until a human
approves or denies it, here in the UI or with a call to the approve endpoint.

### Scene 5 — Approved, then paid (1:30–1:50, 20 s)

**On screen:** Click **Approve**. Decision card: Decision "Approved", reason code `approved_by_human`, "approved by
"demo-operator"; 75 USD to "near-compute" is within hard limits", and "Approved by human (demo-operator)"; Payment
outcome badge "PAID", "Payment succeeded". Receipt card: status `succeeded`, rail Mock. Gauge: "Spent today
$119.00".

**Narration (38 words / max 50):**
The operator approves. agent-pay re-checks the hard limits and the payee allowlist at approval time, then pays
on the mock rail. The receipt succeeds, and seventy-five dollars is added to the daily total. The rejected payment
never counted.

### Scene 6 — Ledger view (1:50–2:10, 20 s)

**On screen:** Zoom on the Ledger panel (newest first): "receipt succeeded" with `mock · mock_…`, "payment paid",
"human approved" with the `approved_by_human` reason and "by demo-operator", "approval required", "intent
recorded", and further down the "policy decision" with the `per_tx_limit_exceeded` reason.

**Narration (42 words / max 50):**
Every step lands in the ledger: the intent, the policy or human decision, the payment, and the receipt, written
in a fixed order. Rejected and pending intents are recorded too. Replaying the same intent returns the stored result
instead of paying twice.

### Scene 7 — Intents & manual resolve (2:10–2:30, 20 s)

**On screen:** Highlight the Intents panel. The entry "Buy API credits (rail error) · $12.00" shows the chip "Needs
check (pending) · Rail error"; "Spent today $119.00" still counts it. Click its **Resolve…** button. The Decision
card shows Payment outcome badge "NEEDS CHECK (PENDING)", and the Receipt card the "Needs check (pending)" banner ("…
The amount stays reserved and is not marked failed. … Do not retry the payment."). In the "Resolve payment" form:
Outcome **Failed**, Note "No charge on the rail dashboard", Resolved by `ops-bob` → **Record outcome**. Screen
shows "Resolved as failed by ops-bob.", Payment outcome badge "FAILED", "Payment failed — resolved by ops-bob";
the Intents entry turns "Resolved" with "Resolved failed by ops-bob · No charge on the rail dashboard". Gauge:
"Spent today $107.00".

**Narration (48 words / max 50):**
Here the rail call broke mid-payment, so the outcome is uncertain. agent-pay never resends it automatically. The
payment stays pending and keeps holding the spending limit. An operator checks the rail, records what happened
with a note and their name, and resolves it. The ledger keeps that record.

### Scene 8 — CLI `--json` output (2:30–2:50, 20 s)

**On screen:** Terminal. Run:

```sh
npm run -s agent -- --scenario small --json
```

(`-s` keeps npm's `> agent` banner out of the NDJSON. The recorded `docs/demo/agent-pay-submission.webm` shows this
same root command, `npm run -s agent -- --scenario small --json`.)

NDJSON scrolls by: `health`, `task`, `quote`, `submit_intent`, `intent_result` step events, then one `summary` line.
Highlight `"apiStatus":"paid"` and `"exitCode":0`. Excerpt from a real local run (ids and timestamps differ per
run):

```json
{"type":"step","step":"intent_result","ts":"2026-10-28T05:34:06.024Z","message":"paid: within_policy: amount 10 USD to \"openai-api\" is within policy","apiStatus":"paid","reason":"within_policy: amount 10 USD to \"openai-api\" is within policy","intentId":"pi_ef95be42-c3c9-4b1a-b3b1-140dad144ca1"}
{"type":"summary","ts":"2026-10-28T05:34:06.024Z","status":"paid","exitCode":0,"scenario":"small","task":"buy 1M tokens of GPT inference","quote":{"payee":"openai-api","amount":10,"currency":"USD","purpose":"buy 1M tokens of GPT inference (1 x 1M tokens @ 10 USD)"},"intentId":"pi_ef95be42-c3c9-4b1a-b3b1-140dad144ca1","receipt":{"intentId":"pi_ef95be42-c3c9-4b1a-b3b1-140dad144ca1","rail":"mock","externalId":"mock_53db5d17-6b8e-41ca-b13c-917ab7a7f7e0","status":"succeeded","at":"2026-10-28T05:34:06.018Z"},"reason":"within_policy: amount 10 USD to \"openai-api\" is within policy"}
```

End card: "agent-pay: policy-guarded payments for AI agents."

**Narration (46 words / max 50):**
A task-agent CLI uses the same API. A rule-based planner turns "buy 1M tokens of GPT inference" into a ten dollar
quote and submits it. With the json flag, every step is one JSON line, ending in a summary with the status,
receipt, and exit code.
