# Live readiness: moving from mock to PayPal sandbox and NEAR testnet

This checklist is for the owner of the project. It covers what the owner has to do personally before the team can
run agent-pay against real test networks instead of the `mock` rail:

- `RAIL=paypal`: PayPal Payouts v1 in the **sandbox**.
- `RAIL=near`: a native NEAR transfer on **testnet**.

Neither rail supports refunds. The PayPal Orders v2 adapter (`paypal-orders`) exists only in `packages/adapters`.
By decision it is not a server rail, so `RAIL=paypal-orders` makes the API exit 1 with `unknown_rail`.

## Who does what

| Step | Who |
|---|---|
| Create accounts (PayPal developer, sandbox accounts, NEAR testnet wallet) | Owner |
| Create the sandbox REST app, copy credentials, export the NEAR key | Owner |
| Fund the NEAR testnet account from the faucet | Owner |
| Put the values in a local `.env` file on the machine that runs the commands | Owner |
| Decide whether and when to make the GitHub repository public | Owner |
| Run the integration tests and rail demos ([Commands we run afterwards](#commands-we-run-afterwards)) | Team |

**Rules for secrets**

- Values go **only** into a local `.env` file. Never paste them into chat, issues, pull requests, commit messages,
  screenshots or logs.
- `.env` and `.env.*` are gitignored. Only `.env.example` is tracked, and it holds names only. Never commit a
  filled-in copy.
- Use test credentials only: a PayPal **sandbox** app and a NEAR **testnet** account created just for this
  project.
- The API never prints env values. On a failed start it prints only the **names** of missing variables and
  redacts values of `PAYPAL_*`, `NEAR_*` and other key-like variables from error messages.

## 0. Create the local `.env`

```sh
cp .env.example .env    # then fill in values locally; .env is gitignored
git status --short      # .env must NOT appear here
```

Empty values fall back to the defaults documented in `.env.example`.

## 1. PayPal sandbox (`RAIL=paypal`)

The `paypal` rail calls the Payouts v1 API (`/v1/payments/payouts`) with OAuth client credentials. By default it
targets the sandbox API base URL (`https://api-m.sandbox.paypal.com`).

Owner checklist:

- [ ] **Sign up for a PayPal developer account** and log in to the Developer Dashboard. Per PayPal, signing up
      automatically creates a sandbox environment with one **business** sandbox account (the sender) and one
      **personal** sandbox account (the receiver).
      Docs: [Get started with PayPal REST APIs](https://developer.paypal.com/api/rest/),
      [Sandbox accounts](https://developer.paypal.com/tools/sandbox/accounts/).
- [ ] **Create a sandbox REST app.** Toggle the dashboard to **Sandbox**, open **Apps & Credentials**, choose
      **Create App**, set the type to **Merchant** and link it to the sandbox business account.
      Docs: [Set up accounts and environment for payouts](https://developer.paypal.com/payouts/use-payouts/set-up).
- [ ] **Copy the app's client ID and client secret** into `.env`.
- [ ] **Confirm Payouts works for the sandbox app** (*needs confirmation*). PayPal's Payouts overview says that
      using Payouts requires requesting access, and that you can test in sandbox accounts while the request is
      pending. The sandbox setup page lists no separate Payouts toggle for sandbox
      apps. The docs don't say whether a sandbox app's **Features** list must show Payouts as enabled, so check
      the app's Features section in the dashboard. The live access request applies only to going live, which is
      out of scope.
      Docs: [Payouts overview](https://developer.paypal.com/docs/payouts/standard/),
      [Use Payouts API](https://developer.paypal.com/docs/payouts/standard/integrate-api/).
- [ ] **Check the sandbox business account has a balance.** Payouts are funded from the sender's PayPal balance.
      The amount a new sandbox business account starts with *needs confirmation*; check it on the sandbox
      accounts page.
- [ ] **Pick the receiver:** a **personal** sandbox account, and copy its **email address**. Its email is
      shown on the sandbox accounts page of the Developer Dashboard (see
      [Sandbox accounts](https://developer.paypal.com/tools/sandbox/accounts/)). It is used for the PayPal integration test and
      (recommended) for the demo payee map.

Env names to fill:

| Name | Required | Format (in words) |
|---|---|---|
| `PAYPAL_CLIENT_ID` | Yes, for `RAIL=paypal` and the PayPal integration tests | The sandbox REST app's client ID, as shown in Apps & Credentials |
| `PAYPAL_CLIENT_SECRET` | Yes, for `RAIL=paypal` and the PayPal integration tests | The same app's client secret |
| `PAYPAL_BASE_URL` | No | Leave empty to use the sandbox API base URL; do not point it at the live API |
| `PAYPAL_PAYOUT_RECEIVER` | Integration test only | The personal sandbox account's email address (the test sends a 0.01 USD payout to it) |
| `DEMO_PAYEES` | No, but recommended for the demo | See [Demo payee map](#demo-payee-map-demo_payees) |

## 2. NEAR testnet (`RAIL=near`)

The `near` rail signs one native NEAR transfer and submits it to a NEAR JSON-RPC endpoint. It defaults to testnet.

Owner checklist:

- [ ] **Create a testnet account** (a name ending in `.testnet`, not a mainnet `.near` account). NEAR's docs
      list two ways:
      - a wallet from the curated list at [wallet.near.org](https://wallet.near.org/). Some wallets create named
        testnet accounts directly; write down the seed phrase.
      - the NEAR CLI: `near create-account <name>.testnet --useFaucet` creates the account and funds it from
        the testnet faucet.

      Docs: [Create an Account](https://docs.near.org/getting-started/create-account),
      [Creating Implicit & Named Accounts](https://docs.near.org/protocol/tutorials/creating-implicit-and-named-accounts).
- [ ] **Fund it from the faucet** if it was not funded at creation. Use the official faucet page: enter the
      testnet account ID and select **Request**.
      Docs: [Token Faucet](https://docs.near.org/getting-started/faucet).
      The demo sends 0.1 NEAR per `small` run and the integration test sends 0.001 NEAR, plus gas. Whether one
      faucet request covers several runs *needs confirmation*: the docs say only that it sends "a small amount",
      and they note that the external Testnet Faucet "might be out of tokens at times".
- [ ] **Get the account's private key.** If the account was made with the CLI, NEAR's docs give
      `near account export-account <name>.testnet` to export the seed phrase or private key. With a wallet, use
      the wallet's backup/export flow. How each wallet exports a raw private key (as opposed to a seed phrase)
      differs by wallet and *needs confirmation* for the wallet you choose. The CLI route is the documented one.
- [ ] **Create or pick a receiver account**: a second testnet account that receives the transfers, either
      another `.testnet` named account or an existing 64-character hex implicit account.

**Security warnings for the NEAR key**

- Use an account created **only for testnet** and only for this project.
- **Never reuse a mainnet key or seed phrase**, and never set `NEAR_NETWORK=mainnet` for this work. Anyone with
  the key controls the account.
- The key is a full-access key for the sender account. Keep it only in the local `.env`.

Env names to fill:

| Name | Required | Format (in words) |
|---|---|---|
| `NEAR_ACCOUNT_ID` | Yes, for `RAIL=near` and the NEAR integration test | The sender account ID, a lowercase name ending in `.testnet` (2 to 64 characters; letters, digits, `-`, `_`, `.`) |
| `NEAR_PRIVATE_KEY` | Yes, for `RAIL=near` and the NEAR integration test | The sender's ed25519 private key in NEAR's text form: the `ed25519` prefix, a colon, then base58 text (a 32-byte seed or a 64-byte secret key). The code checks that it matches the account's key pair. |
| `NEAR_NETWORK` | No | `testnet` (default) or `mainnet`. Leave empty or set it to `testnet` |
| `NEAR_RPC_URL` | No | Leave empty to use the default testnet RPC, FASTNEAR's `https://test.rpc.fastnear.com`. NEAR's [RPC Providers](https://docs.near.org/api/rpc/providers) page lists it under Testnet as a public endpoint with a free tier; its free-tier limit is "Not published". To switch, use another **testnet** endpoint from that page |
| `NEAR_RECEIVER_ID` | Integration test only | The receiver account ID: a name ending in `.testnet` or a 64-character lowercase hex implicit account |
| `DEMO_PAYEES` | No, but recommended for the demo | See [Demo payee map](#demo-payee-map-demo_payees) |

The adapter accepts only named payees with the network's suffix (`.testnet` on testnet) or 64-character hex
implicit accounts. Other NEAR address forms in the docs (for example `0x...` Ethereum-like accounts) are rejected.

## Demo payee map (`DEMO_PAYEES`)

The agent's planner uses logical payee names (`openai-api`, `anthropic-api`, `vercel`, `near-compute`). The API
maps them to real addresses per rail and serves the map on `GET /rail`. Without `DEMO_PAYEES`:

- `paypal` maps them to placeholder `@example.com` emails, which are not sandbox accounts.
- `near` maps them all to `demo-merchant.testnet`. Whether that account exists on testnet *needs confirmation*.
  A transfer to a missing account fails.

So for a live demo, set `DEMO_PAYEES` to comma-separated `name=address` pairs. It replaces the whole default map.
The built-in scenarios pay `openai-api`, so include at least that name:

- `RAIL=paypal`: `openai-api=` followed by the personal sandbox account's email.
- `RAIL=near`: `openai-api=` followed by the receiver's testnet account ID.

`.env` holds one `DEMO_PAYEES` value, so change it when you switch rails. Invalid entries (a bad email on
`paypal`, a wrong-network or invalid account on `near`) make the API exit 1 at startup with a `demo_payees:`
error.

Rail seeds (from `apps/api/src/seed.ts`):

| Rail | Currency | Amount scale | Per-tx max | Daily max | Approval above |
|---|---|---|---|---|---|
| `paypal` | USD | 1 | 100 | 200 | 50 |
| `near` | NEAR | 0.01 | 1 | 2 | 0.5 |

The `small` scenario quotes 10 USD: that is a 10 USD payout on `paypal` and a 0.1 NEAR transfer on `near`. Both
are auto-approved.

## 3. Making the repository public (separate, future decision)

The GitHub repository is currently a **private** backup. Whether to make it public, and when, is the owner's
decision. Treat it as its own step, after the work above. Before flipping visibility:

- [ ] **Check the full history for secrets**, not just the current tree. Every branch and every commit becomes
      visible once the repository is public. Search for anything that looks like a client secret, private key or
      seed phrase, and confirm no `.env` file was ever committed (`git log --all --stat -- .env` should print
      nothing). If anything was ever committed, **rotate or revoke it first**: create a new PayPal sandbox
      secret, and replace the NEAR key or abandon that testnet account. GitHub's guidance is to rotate first, then
      decide whether to rewrite history (for example with `git-filter-repo`).
      Docs: [Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
- [ ] **Know what GitHub scanning covers.** GitHub secret scanning runs automatically and free on **public**
      repositories and scans the whole Git history on all branches. For user-owned private repositories it is
      available only on certain paid plans. So for a private repository on a personal account, do the local
      history check above before making it public rather than relying on GitHub's scan. Push protection for
      users is on by default and blocks pushing detected secrets to **public** repositories.
      Docs: [Secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning),
      [Push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection).
- [ ] **Flip visibility** in the repository's **Settings**, in the
      **Danger Zone** section. Making it public also
      makes Actions history and logs visible to everyone and lets anyone fork the repository.
      Docs: [Setting repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).

## Commands we run afterwards

These run from the repository root, on a machine where the owner has filled in `.env`. They need Node 24 and
`npm install`. Every command below exists in this repository's `package.json` scripts or uses a file or flag in
the repository.

### Integration tests (real sandbox / testnet calls)

The integration tests in `packages/adapters/test/` **skip themselves** unless their env vars are set. The
normal `npm test` therefore never calls PayPal or NEAR. Load `.env` with Node's `--env-file` and run one file at
a time:

```sh
# PayPal Payouts sandbox: needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_PAYOUT_RECEIVER
node --env-file=.env --test packages/adapters/test/paypal.integration.test.ts

# NEAR testnet: needs NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY, NEAR_RECEIVER_ID (NEAR_NETWORK / NEAR_RPC_URL optional)
node --env-file=.env --test packages/adapters/test/near.integration.test.ts
```

Expected result:

- **PayPal:** one test, "paypal sandbox payouts: pay and status", passes. It sends a 0.01 USD payout to
  `PAYPAL_PAYOUT_RECEIVER` and accepts a receipt status of `succeeded`, `pending` or `failed`. If the receipt
  has an external ID, it rechecks the status.
- **NEAR:** one test, "NEAR testnet transfer / sends 0.001 NEAR and rechecks status", passes. It sends
  0.001 NEAR to `NEAR_RECEIVER_ID`, checks that the adapter has no `refund`, and rechecks the status.
- If a required variable is missing or empty, the test is reported as **skipped** with a message naming the
  missing variables, for example `PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_PAYOUT_RECEIVER not set`.

Do **not** use `npm test -w @agent-pay/adapters` with `.env` loaded for this. It would also run
`paypal-orders.integration.test.ts`, which needs only `PAYPAL_CLIENT_ID` and calls the Orders v2 sandbox. That
adapter is not a server rail, and it is not part of this checklist.

### Rail demos (API plus agent CLI)

Two ways to run a live rail: the API alone plus the agent CLI, or the full demo (API plus web UI).

Terminal 1, start the API with the root script `npm run api`
(`node --env-file-if-exists=.env apps/api/src/main.ts`). It loads `.env` when the file exists. `RAIL` can be set
in `.env` or on the command line; an existing shell variable takes precedence over the file. A fresh
`LEDGER_PATH` keeps runs separate:

```sh
RAIL=paypal LEDGER_PATH=/tmp/agent-pay-paypal/ledger.json npm run api
# agent-pay api listening on http://127.0.0.1:8787 (rail=paypal, ledger=/tmp/agent-pay-paypal/ledger.json)

RAIL=near LEDGER_PATH=/tmp/agent-pay-near/ledger.json npm run api
# agent-pay api listening on http://127.0.0.1:8787 (rail=near, ledger=/tmp/agent-pay-near/ledger.json)
```

The API workspace's start script (`npm start -w @agent-pay/api`, which runs `node src/main.ts`) works too, but it
does not load `.env` by itself. The variables must already be in the shell environment.

Or run the full demo, which starts the API and the web UI on a fresh temporary ledger:

```sh
RAIL=paypal npm run demo
RAIL=near npm run demo
```

- The demo's rail comes **only from the shell** `RAIL` (default `mock`); a `RAIL` line in `.env` is ignored by
  the demo. A root `.env`, when present, is passed to the API for the credentials.
- Ports: `DEMO_API_PORT` (default 8787) and `DEMO_WEB_PORT` (default 5173).
- It prints `rail: <rail>` (plus `(api env file: .env)` when the file is used), then
  `agent-pay demo ready: http://127.0.0.1:5173/  (api http://127.0.0.1:8787, rail=<rail>, ledger ...)`.
- If the API cannot start, the demo prints the API's names-only message prefixed with `[api] `, then
  `error: api exited unexpectedly (code 1)`, stops what it started, and exits 1. The web UI is not started.

Terminal 2, run the agent against it with the rail check:

```sh
npm run agent -- --scenario small --rail paypal
npm run agent -- --scenario small --rail near
```

Expected result:

- The agent first calls `GET /health` and `GET /rail` and prints `server: http://127.0.0.1:8787 rail=paypal`
  (or `rail=near`).
- It submits the intent. The `small` scenario is auto-approved, and the agent prints a
  `Receipt: <rail> <external id> (<status>)` line.
- The exit code is **0** when the payment is paid. It is **3** when the receipt is still pending at the timeout
  (`--timeout-ms`, default 120000). It is **1** on errors, including a failed payment.
- Run `npm run agent -- --help` to see the other options, such as `--scenario needs-approval --auto-approve-as
  <name>` and `--json`.

**`--rail` check.** If the server runs a different rail, the agent exits 1 with
`rail_mismatch: server <url> runs rail=<rail> but --rail <expected> was expected; restart the API with RAIL=<expected> or drop --rail`.

**Missing env at startup.** With a credentialed rail selected and its required variables empty, the API exits 1
without a stack trace and prints names only. For example, with nothing set:

```text
agent-pay api failed to start: adapter_config: PAYPAL_CLIENT_ID environment variable is required (RAIL=paypal)
missing required env vars for RAIL=paypal: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
set them in the environment (names are listed in .env.example; values are never printed), or use RAIL=mock
```

`RAIL=near` behaves the same way with `NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY`. `RAIL=paypal-orders` (or any other
unknown value) exits 1 with `unknown_rail: RAIL must be one of mock|paypal|near`.

## Needs confirmation (open items)

1. Whether a PayPal **sandbox** REST app must have Payouts explicitly enabled under its Features before sandbox
   payouts succeed. The docs say sandbox testing is possible while live Payouts access is pending, but they don't
   mention a sandbox toggle.
2. The starting balance of the default sandbox business account, and whether it covers the demo payouts.
3. Whether one NEAR testnet faucet request funds enough for several demo runs (0.1 NEAR each) plus the
   integration test (0.001 NEAR) and gas.
4. How the chosen NEAR wallet exports a raw private key, as opposed to a seed phrase. The CLI export command is
   the documented route.
5. The rate limit of the default testnet `NEAR_RPC_URL` (`https://test.rpc.fastnear.com`). NEAR's RPC providers
   page lists its free-tier limit as "Not published".
6. Whether the default NEAR demo payee `demo-merchant.testnet` exists on testnet. Setting `DEMO_PAYEES` avoids
   the question.
7. Which HTTP status PayPal returns for each named Payouts error. The docs list the error names but not their HTTP
   statuses, so the adapter tests assume 400 or 403.
8. Whether a `VALIDATION_ERROR` whose details mention `sender_batch_id` can really occur. The duplicate check
   catches it, so it stays `pending` (`needsManualResolve`) instead of `failed`.
9. Whether every NEAR RPC node we use returns `final_execution_status`. On older nodes that don't, the payment
   always stays `pending` and needs `POST /intents/:id/resolve` or a refresh against a node that does.

## Known risks (remaining)

- The missing-ledger-file guard (F9) only works within one process; a fresh process recreates a missing ledger file.
- Adapters take no AbortSignal, so a pay or status call that timed out keeps running in the background; its late response is ignored and not recorded, so the operator should resolve the entry manually (`POST /intents/:id/resolve`).
- Taking over a stale ledger lock is best-effort.
