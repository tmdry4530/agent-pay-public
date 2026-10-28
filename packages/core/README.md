# @agent-pay/core

Policy engine + JSON ledger for agent-pay. TypeScript, run directly by Node ≥ 23.6
(built-in type stripping, erasable syntax only, `.ts` import extensions). No runtime deps.

```sh
npm install            # dev deps only: typescript, @types/node
npm test               # node --test (all workspaces)
npm run typecheck      # tsc --noEmit
```

## Types
- `PaymentIntent {id, agentId, payee, amount, currency, purpose, createdAt}`: `amount` is in major units; `createdAt` is ISO 8601.
- `Policy {agentId, perTxMax, dailyMax, allowedPayees, requireApprovalAbove, currency?}`
- `Decision {status: 'approved'|'rejected'|'needs_approval', reason}`: `reason` = `"<code>: <detail>"`; `reasonCode(decision)` extracts the code.
- `DecisionRecord = Decision & {at?, actor?}`: one element of `LedgerEntry.decisions` (see Ledger below).
- `Receipt {intentId, rail: 'mock'|'paypal'|'near', externalId, status: 'succeeded'|'pending'|'failed'|'refunded', at}`
- `LedgerState {dailyTotal}`: what `evaluate` needs from the ledger.

## `evaluate(policy, intent, ledgerState): Decision`
Pure (no I/O, no clock). First failing check wins:

| # | check | result / code |
|---|---|---|
| 1 | `intent.agentId !== policy.agentId` | rejected `agent_mismatch` |
| 2 | currency ≠ `policy.currency ?? 'USD'` (case-insensitive) | rejected `currency_mismatch` |
| 3 | amount not finite or `<= 0` | rejected `invalid_amount` |
| 4 | payee not in `allowedPayees` (exact match) | rejected `payee_not_allowed` |
| 5 | `amount > perTxMax` | rejected `per_tx_limit_exceeded` |
| 6 | `dailyTotal + amount > dailyMax` | rejected `daily_limit_exceeded` |
| 7 | `amount > requireApprovalAbove` | needs_approval `approval_required` |
| 8 | otherwise | approved `within_policy` |

All limits are inclusive (`amount == limit` passes). **Currency:** a policy's limits are in exactly one
currency (default `USD`; use `currency: 'NEAR'` for a NEAR policy). There is no FX conversion: an intent in
another currency is rejected. Amounts are plain JS numbers, so float sums like 0.1 + 0.2 are not exact.
Keep amounts to ≤ 2 decimals, or use whole minor units throughout.

## `PaymentAdapter` (interface only; implementations live in packages/adapters)
```ts
interface PaymentAdapter {
  readonly rail: 'mock' | 'paypal' | 'near';
  pay(intent: PaymentIntent): Promise<Receipt>;
  status?(receipt: Receipt): Promise<Receipt>; // optional: poll the rail for pending receipts
  refund?(receipt: Receipt): Promise<Receipt>;
}
```
- Call `pay` only for an `approved` decision. Return a `Receipt` with `intentId === intent.id` and `rail === adapter.rail`.
- If the rail declines the payment, resolve with `status: 'failed'`. Throw only for unexpected errors.
- `status` resolves with the rail's current view of that receipt (same `intentId` and `rail`; status `succeeded` | `pending` | `failed`). Used by `reconcile` / `refreshIntent`.
- `refund` resolves with a new receipt (`status: 'refunded'`).

## Orchestrator: `runPayment`, `approve`, `reject`
```ts
const r = await runPayment(intent, policy, ledger, adapter);
// r: { intentId, status: 'paid'|'rejected'|'needs_approval'|'failed', decision, receipt?, error?, replayed? }
if (r.status === 'needs_approval') {
  await approve(intent.id, { policy, ledger, adapter, approver: 'alice' }); // or reject(intent.id, { ledger, approver, note })
}
```
- **`runPayment`** records the intent, evaluates it with `ledger.ledgerStateFor(intent)`, records the decision,
  and calls `adapter.pay` only for `approved`. Then it records the payment and the receipt.
- **Statuses:** `paid` = receipt `succeeded` or `pending` (counts toward the daily total). `failed` = approved but
  not paid (does not count). `rejected` / `needs_approval` = the policy decision; the adapter was not called.
- **Adapter failures are results, not throws.** `error` is `"<code>: <detail>"`:
  - `adapter_error`: `pay` threw. The payment is recorded as `failed` and no receipt is stored.
  - `receipt_mismatch`: the receipt's `intentId` ≠ `intent.id`, its `rail` ≠ `adapter.rail`, or its status isn't
    `succeeded`/`pending`/`failed`. Recorded as `failed`, and the bad receipt is not stored. The rail may still
    have moved money, so reconcile it out of band.
  - `payment_declined`: the receipt status is `failed`. Recorded as `failed`, and the receipt is stored.
  Ledger I/O errors still throw.
- **Idempotent per intent id.** If the same intent (deep-equal) is already recorded, its stored outcome comes back
  with `replayed: true` and `pay` is **not** called again. It throws `PaymentError` with code `intent_conflict`
  when the id was recorded with different content, and `in_progress` when the entry is mid-flight (undecided, or
  approved with no payment recorded: another run is paying, or a crash needs manual reconciliation).
- **`approve(intentId, {policy, ledger, adapter, approver?})`** resumes a `needs_approval` intent. It throws
  `PaymentError` with code `intent_not_found`, `already_paid` or `not_pending`. Then it re-runs `evaluate` against
  the current ledger with the approval threshold disabled, so the agent, currency, amount, payee, per-tx and daily
  limits still apply. If the re-check fails, the decision is replaced with that rejection (reason suffix
  `(re-checked on approval by …)`), the result is `rejected` and nothing is paid. Otherwise the decision becomes
  `approved_by_human: approved by "<approver>"; …` and the pay/receipt steps run as in `runPayment`.
- **`reject(intentId, {ledger, approver?, note?})`** turns a `needs_approval` intent into `rejected_by_human: …`.
  It throws the same errors as `approve`.
- Both record the new decision with `recordDecision(id, d, { ifStatus: 'needs_approval', actor: approver })`, so of
  two concurrent approvals on one Ledger instance, only one pays (and only one decision is appended). The single-writer-per-file rule still applies.

## `Ledger`
```ts
const ledger = new Ledger({ filePath: 'data/ledger.json', now: () => new Date() });
await ledger.recordIntent(intent);
const decision = evaluate(policy, intent, await ledger.ledgerStateFor(intent));
await ledger.recordDecision(intent.id, decision);
if (decision.status === 'approved') {
  const receipt = await adapter.pay(intent);
  await ledger.recordPayment(intent.id, receipt.status === 'failed' ? 'failed' : 'paid');
  await ledger.recordReceipt(intent.id, receipt);
}
```
- File: `{ version: 1, entries: LedgerEntry[] }`. The file and its parent dirs are created when missing.
  An unknown format throws and is not overwritten.
- **Decision history:** `entry.decision` is the latest decision; `entry.decisions` lists every decision, oldest
  first, as `{status, reason, at, actor?}`. `at` is the ledger clock's ISO time. `actor` is `'policy'` for
  `runPayment`'s evaluation and for the re-check on approval, or the approver name for `approve`/`reject`
  (omitted when no name is given; pass `{ actor }` to `recordDecision` yourself). A `needs_approval` → human flow
  ends with two records. Replays, `recordPayment`, `recordReceipt`, `settleReceipt`, `reconcile` and a failed
  `ifStatus` check append nothing. Files written before this field existed are read with
  `decisions = [decision]` (no `at`/`actor`) or `[]` when undecided; reads never rewrite the file, and the next
  write stores the new shape.
- Order is enforced: decision needs an intent; payment needs an `approved` decision and no earlier payment;
  receipt needs a recorded payment and a matching `intentId`. A decision can be replaced until payment is
  recorded (e.g. `needs_approval` → `approved` after a human approves). Pass `{ ifStatus }` as the third argument
  to `recordDecision` to make the replacement conditional on the current status. Pending receipts are settled with
  `settleReceipt` (compare-and-set on `receipt.status === 'pending'`); other receipt replacements use `recordReceipt`
  (e.g. a refund receipt).
- **Daily totals:** grouped by the **UTC** date of `intent.createdAt`, not the record time and not KST.
  For example, 08:30 KST on 10/29 counts toward 10/28 UTC. `dailyTotal(agentId, day?)` takes a
  `Date`, an ISO string or `YYYY-MM-DD`. The default day is today in UTC from the injected `now`.
- **What counts:** entries whose decision is `approved`, unless `paymentStatus === 'failed'` or
  `receipt.status === 'failed'`. Approved but unpaid entries count, because the amount is reserved.
  `rejected`, `needs_approval` and undecided entries do not count. Refunded entries still count;
  refunds do not free up budget.
- `ledgerStateFor(intent)` returns the total for the intent's agent and UTC day, leaving out the
  intent itself.
- **Writes:** atomic (a temp file `<file>.<pid>.<ts>.<rand>.tmp` in the same directory, then `rename`).
  One instance runs its operations in order. Each operation re-reads the file. There is **no
  cross-process lock**, so use only one writer process per ledger file.

## Reconciliation: `reconcile`, `refreshIntent`
```ts
const summary = await reconcile(ledger, adapter);
// { rail, supported, checked, updated: [{intentId, from, to}], unchanged, errors: [{intentId, error}] }
const r = await refreshIntent(intentId, ledger, adapter);
// PaymentResult & { changed: boolean }
```
- If `adapter.status` is missing, `reconcile` returns `supported: false` and does not call the adapter.
- Otherwise every entry with `paymentStatus === 'paid'`, `receipt.status === 'pending'`, and `receipt.rail === adapter.rail` is checked via `adapter.status`. Still `pending` → no write (`unchanged++`). `succeeded` or `failed` → `ledger.settleReceipt` (failed also sets `paymentStatus` to `failed`).
- **Totals:** `pending` and `succeeded` receipts count toward the daily total; a receipt settled as `failed` (with `paymentStatus: 'failed'`) no longer counts, so its amount is freed for the rest of the UTC day. A replay of that intent through `runPayment` reports `failed`.
- Invalid receipts (wrong `intentId`/`rail`, or a status other than `succeeded`/`pending`/`failed`) or adapter errors become `errors[]` items (`receipt_mismatch: …` / `adapter_error: …`; a lost compare-and-set is `ledger_conflict: …`) and nothing is stored; one bad entry does not stop the batch. A second run after all receipts settle is a no-op (ledger file byte-identical).
- **`refreshIntent`** throws `PaymentError`: `intent_not_found`, `no_receipt`, `receipt_not_pending` (already settled), `status_unsupported`, `status_check_failed`. On a failed rail status the result is `status: 'failed'` with `payment_declined: … on status check`.
