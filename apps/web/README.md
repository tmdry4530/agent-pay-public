# agent-pay web demo

Single-screen Vite + React demo for **agent-pay**: an AI agent pays on behalf of a user within a configurable spending policy (NEAR agent economy + PayPal AI hackathon narrative).

## Requirements

- Node.js 18+
- [pnpm](https://pnpm.io/) 11.28.5 (pinned via `packageManager` in `package.json`)

### Corepack

`packageManager` pins pnpm to `11.28.5` so Corepack does not pull a newer major (e.g. pnpm 12). Corepack's
default cache path can fail with `EACCES`, so point it at a user-writable directory before installing:

```bash
export COREPACK_HOME="$HOME/.cache/node/corepack"
npm run web:install          # from the repo root (pnpm -C apps/web install --frozen-lockfile)
pnpm -C apps/web --version   # expect 11.28.5 when pnpm is resolved through Corepack
```

Corepack picks the pnpm version from the `package.json` in the **current directory**, not the `-C` target. The
root `package.json` has no `packageManager`, so running the Corepack `pnpm` shim from the repo root (e.g.
`pnpm -C apps/web ...`) falls back to Corepack's last-known-good pnpm (possibly 12.x) and fails with
`ERR_PNPM_BAD_PM_VERSION`. Either run Corepack from this directory (`cd apps/web && pnpm --version`) or put a
standalone pnpm 11.28.5 ahead of the Corepack shim on `PATH` (e.g. `~/.local/bin/pnpm`). Check `command -v pnpm`
to see which one you get.

## Setup & scripts

From this directory (`apps/web`):

```bash
export PATH="$HOME/.local/bin:$HOME/.local/share/fnm/aliases/default/bin:$PATH"
pnpm install
pnpm dev          # local dev server (in-memory mock by default)
pnpm build        # typecheck + production bundle
pnpm preview      # preview production build
pnpm typecheck
pnpm test
pnpm lint
```

## Architecture

- **`@agent-pay/core`** (`../../packages/core`) is imported via TypeScript `paths` in `tsconfig.app.json` and matching Vite/Vitest `resolve.alias` entries. Type-only imports use `@agent-pay/core`; runtime code imports `@agent-pay/core/policy.ts` and `@agent-pay/core/orchestrator.ts` only (not `ledger.ts`, which uses `node:fs`).
- **`node:util`** is shimmed to `src/shims/node-util.ts` so the orchestrator bundles for the browser.
- **`AgentPayClient`** (`src/data/agentPayClient.ts`) abstracts policy, intent submission, approval, ledger reads, and optional reset.
- **`createClient()`** (`src/data/createClient.ts`) picks the implementation from `VITE_API_BASE`:
  - unset or empty → `createInMemoryClient()` (mock rails, in-memory ledger)
  - set → `createHttpClient({ baseUrl })` against the HTTP API

Connect to a local API:

```bash
VITE_API_BASE=http://127.0.0.1:8787 pnpm dev
```

In HTTP mode the **rail is chosen by the API server** (one adapter per process); the UI rail toggle is informational only. The reference API allows CORS from `http://localhost:*` and `http://127.0.0.1:*`.

## Mock rails (in-memory client)

All payment rails (**Mock**, **PayPal**, **NEAR**) are **fully mocked**. No network calls, no real funds. Receipt external IDs use demo prefixes (`mock_…`, `MOCK-PAYPAL-ORDER-…`, `mock-near-tx-…`).

To demo **pending settlement** (receipt stays `pending` until you click **Refresh status**), open the app with `?simulatePending=1` in the URL (mock client only). Pay returns a pending receipt; one **Refresh status** settles it to succeeded.

## Demo scenarios

Aligned with the API default policy (`demo-agent`, daily max $200, per-tx max $100, approval above $50):

1. **Buy API credits** (`openai-api`, $12) — paid (within policy)
2. **Rent GPU cluster** (`near-compute`, $480) — rejected (per-tx limit)
3. **Buy NEAR compute hours** (`near-compute`, $75) — needs approval → Approve/Deny

Use **Reset demo** (mock client only) to clear the ledger.
