# agent-pay web demo

Single-screen Vite + React demo for **agent-pay**: an AI agent that pays on behalf of a user within a configurable spending policy (NEAR agent economy + PayPal AI hackathon narrative).

## Requirements

- Node.js 18+
- [pnpm](https://pnpm.io/)

## Setup & scripts

From this directory (`apps/web`):

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$PATH"
pnpm install
pnpm dev          # local dev server
pnpm build        # typecheck + production bundle
pnpm preview      # preview production build
pnpm typecheck
pnpm test
pnpm lint
```

## Mock rails

All payment rails (**Mock**, **PayPal**, **NEAR**) are **fully mocked in memory**. No network calls, no real funds, no API keys. Receipt external IDs follow demo prefixes (`MOCK-TX-…`, `MOCK-PAYPAL-ORDER-…`, `mock-near-tx-…`).

Swap `ClientProvider` implementation later for real `@agent-pay/core` and adapter packages when published.

## Demo scenarios

1. **Buy API credits** — auto-approved under policy  
2. **Rent GPU cluster** — rejected (over per-tx cap)  
3. **Purchase dataset license** — needs human approval  

Use **Reset demo** to clear ledger and spend counters.
