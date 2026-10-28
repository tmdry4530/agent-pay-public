# agent-pay: demo video script

Total length: 2:50 (target under 3:00). Narration is paced at about 150 words per minute (2.5 words per second);
each scene lists its narration word count against the words its time slot allows.

## Recording setup

- API on the mock rail with an empty ledger (no real funds move):
  `LEDGER_PATH=/tmp/agent-pay-demo/ledger.json npm start -w @agent-pay/api` → `http://127.0.0.1:8787`, `rail=mock`.
- Web demo against that API, from `apps/web`: `VITE_API_BASE=http://127.0.0.1:8787 pnpm dev`. The header badge
  shows `API: http://127.0.0.1:8787` and the rail row shows "Rail is selected by the API server: mock".
  (Without `VITE_API_BASE` the web demo runs fully in the browser with an in-memory ledger; the scenes below
  look the same except for the header badge, which then reads `MOCK — no real funds`.)
- The web scenario cards are fixed: **Buy API credits** (`openai-api`, $12.00), **Rent GPU cluster**
  (`near-compute`, $480.00), **Buy NEAR compute hours** (`near-compute`, $75.00). Each run is: click the card →
  **Get quote** → **Run policy check & pay**. The web approver name is `demo-operator`.
- Scenes 2–6 run in this order on one fresh ledger, so "Spent today" goes $0.00 → $12.00 → $12.00 → $12.00 →
  $87.00.

## Scenes

### Scene 1 — Intro (0:00–0:20, 20 s)

**On screen:** Web demo, initial state. Three scenario cards on the left; the pipeline stepper (Task, Quote,
Policy, Decision, Approval, Payment, Receipt) in the middle; "Spending limit" panel on the right reading
"Per-tx max $100.00 · approval above $50.00", "Spent today $0.00", "Daily max $200.00"; empty Ledger panel.

**Narration (44 words / max 50):**
AI agents are starting to spend money, but an API key alone has no limits. agent-pay puts a policy between the
agent and the payment rail. This agent may spend one hundred dollars per payment, two hundred per day, and
needs approval above fifty.

### Scene 2 — $12 payment paid (0:20–0:45, 25 s)

**On screen:** Click **Buy API credits** ($12.00, `openai-api`) → **Get quote** (PaymentIntent draft: payee
`openai-api`, amount $12.00) → **Run policy check & pay**. Decision card: badge PAID, status "approved",
reason code `within_policy`, "amount 12 USD to "openai-api" is within policy". Receipt card: status `succeeded`,
rail Mock, external ID `mock_…`. Gauge: "Spent today $12.00".

**Narration (49 words / max 62):**
First task: buy twelve dollars of API credits from openai-api. The agent turns the task into a payment intent and
sends it to the API. The policy engine checks amount, payee, and daily total. It is within policy, so the mock
rail pays it and returns a succeeded receipt.

### Scene 3 — Over-limit payment rejected (0:45–1:10, 25 s)

**On screen:** Click **Rent GPU cluster** ($480.00, `near-compute`) → **Get quote** → **Run policy check & pay**.
Decision card: badge REJECTED, reason code `per_tx_limit_exceeded`, "amount 480 exceeds per-transaction max
100". No receipt card. Gauge still "Spent today $12.00".

**Narration (47 words / max 62):**
Next, the agent tries to rent a GPU cluster for four hundred eighty dollars. That is above the one hundred dollar
per-transaction limit, so the policy rejects it with per_tx_limit_exceeded. The payment rail is never called, no
receipt is created, and the daily total does not move.

### Scene 4 — $75 payment waiting for approval (1:10–1:35, 25 s)

**On screen:** Click **Buy NEAR compute hours** ($75.00, `near-compute`) → **Get quote** → **Run policy check &
pay**. Stepper stops at Approval. Decision card: badge NEEDS APPROVAL, reason code `approval_required`, "amount
75 is above approval threshold 50". **Approve** and **Deny** buttons appear. Gauge still "Spent today $12.00".

**Narration (54 words / max 62):**
Now seventy-five dollars of compute hours. It is inside the hard limits but above the fifty dollar approval
threshold, so the decision is needs approval. Nothing is paid yet. The intent sits in the ledger until a human
approves or denies it, here in the UI or with a call to the approve endpoint.

### Scene 5 — Approved, then paid (1:35–1:55, 20 s)

**On screen:** Click **Approve**. Decision card: badge PAID, status "approved", reason code
`approved_by_human`, "approved by "demo-operator"; 75 USD to "near-compute" is within hard limits", and "Approved
by human (demo-operator)". Receipt card: status `succeeded`, rail Mock. Gauge: "Spent today $87.00".

**Narration (40 words / max 50):**
The operator approves. agent-pay re-checks the hard limits and the payee allowlist at approval time, then pays
on the mock rail. The receipt succeeds, and the daily total is now eighty-seven dollars: twelve plus seventy-five.
The rejected payment never counted.

### Scene 6 — Ledger view (1:55–2:15, 20 s)

**On screen:** Zoom on the Ledger panel (newest first): "intent recorded", "policy decision" with the
`per_tx_limit_exceeded` reason, "human approved" with the `approved_by_human` reason, "payment paid", "receipt
succeeded" with `mock · mock_…`.

**Narration (42 words / max 50):**
Every step lands in the ledger: the intent, the policy or human decision, the payment, and the receipt, written
in a fixed order. Rejected and pending intents are recorded too. Replaying the same intent returns the stored result
instead of paying twice.

### Scene 7 — CLI `--json` output (2:15–2:50, 35 s)

**On screen:** Terminal. Run:

```sh
npm run -s agent -w @agent-pay/agent -- --scenario small --json
```

NDJSON scrolls by: `task`, `quote`, `submit_intent`, `intent_result` step events, then one `summary` line.
Highlight `"apiStatus":"paid"` and `"exitCode":0`. Excerpt from a real local run (ids and timestamps differ per
run):

```json
{"type":"step","step":"intent_result","ts":"2026-10-28T05:34:06.024Z","message":"paid: within_policy: amount 10 USD to \"openai-api\" is within policy","apiStatus":"paid","reason":"within_policy: amount 10 USD to \"openai-api\" is within policy","intentId":"pi_ef95be42-c3c9-4b1a-b3b1-140dad144ca1"}
{"type":"summary","ts":"2026-10-28T05:34:06.024Z","status":"paid","exitCode":0,"scenario":"small","task":"buy 1M tokens of GPT inference","quote":{"payee":"openai-api","amount":10,"currency":"USD","purpose":"buy 1M tokens of GPT inference (1 x 1M tokens @ 10 USD)"},"intentId":"pi_ef95be42-c3c9-4b1a-b3b1-140dad144ca1","receipt":{"intentId":"pi_ef95be42-c3c9-4b1a-b3b1-140dad144ca1","rail":"mock","externalId":"mock_53db5d17-6b8e-41ca-b13c-917ab7a7f7e0","status":"succeeded","at":"2026-10-28T05:34:06.018Z"},"reason":"within_policy: amount 10 USD to \"openai-api\" is within policy"}
```

End card: "agent-pay: policy-guarded payments for AI agents."

**Narration (77 words / max 87):**
The same API serves a task-agent CLI. Given "buy 1M tokens of GPT inference", a rule-based planner quotes ten
dollars to openai-api and submits the intent. With the json flag, every step is one JSON line, ending in a
summary with the status, receipt, and exit code: zero for paid, two for rejected, three if a wait times out. Next
up: a NEAR rail, which is not wired yet, and PayPal payments that need no buyer approval.
