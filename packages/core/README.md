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
  refund?(receipt: Receipt): Promise<Receipt>;
}
```
- Call `pay` only for an `approved` decision. Return a `Receipt` with `intentId === intent.id` and `rail === adapter.rail`.
- If the rail declines the payment, resolve with `status: 'failed'`. Throw only for unexpected errors.
- `refund` resolves with a new receipt (`status: 'refunded'`).

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
- Order is enforced: decision needs an intent; payment needs an `approved` decision and no earlier payment;
  receipt needs a recorded payment and a matching `intentId`. A decision can be replaced until payment is
  recorded (e.g. `needs_approval` → `approved` after a human approves). Receipts can be replaced
  (e.g. pending → succeeded, or a refund receipt).
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
