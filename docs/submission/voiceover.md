# agent-pay: submission video voiceover

Spoken English narration for `docs/demo/agent-pay-submission.webm` (170 s, 8 scenes). It is written to be heard,
so it does not read the on-screen captions word for word; the facts match the captions and
[`video-script.md`](video-script.md). Everything shown runs on the mock rail.

- Voice: ElevenLabs premade voice "Eric - Smooth, Trustworthy" (`cjVigY5qzO86Huf0OWal`), model
  `eleven_multilingual_v2`.
- Pacing: about 2.3 words per second. Each clip starts 0.4 s after its scene starts and ends before the next
  scene begins.
- Generated with `scripts/narration/generate-voiceover.mjs` (reads `ELEVENLABS_API_KEY` from the environment
  only), mixed and muxed with `scripts/narration/mux-voiceover.sh`.

The `> ` lines under each scene heading are the exact text sent to text-to-speech.

### S1 · Intro (0:00–0:20, 20 s)

> AI agents are starting to spend money, and an API key alone has no limits. agent-pay puts a policy between the
> agent and the payment rail. Everything here runs on a mock rail, so no real money moves.

### S2 · $12 payment paid (0:20–0:45, 25 s)

> First, the agent wants twelve dollars of API credits from the OpenAI API. It turns that into a payment intent
> and sends it in. The policy checks the amount, the payee, and today's total. Twelve dollars is well within
> policy, so it's paid automatically, and we get a receipt.

### S3 · Over-limit payment rejected (0:45–1:05, 20 s)

> Now the agent tries to rent a GPU cluster for four hundred eighty dollars. The per-payment max is one hundred,
> so the policy rejects it on the spot. The rail is never called, and spent today stays at forty-four.

### S4 · $75 payment waiting for approval (1:05–1:30, 25 s)

> Next, seventy-five dollars of NEAR compute hours. That's inside the hard limits, but above the fifty dollar
> sign-off threshold. So nothing gets paid yet. The intent waits in the ledger until a person approves or denies
> it.

### S5 · Approved, then paid (1:30–1:50, 20 s)

> The operator approves. agent-pay re-checks the limits at approval time, then pays on the mock rail. The receipt
> comes back, and spent today climbs to one hundred nineteen dollars.

### S6 · Ledger view (1:50–2:10, 20 s)

> Every step lands in the ledger, in order: the intent, the policy or human decision, the payment, and the
> receipt. Rejections are recorded too, so you get a complete audit trail.

### S7 · Intents & manual resolve (2:10–2:30, 20 s)

> Now the tricky case. A rail call broke mid-payment, so the outcome is unknown. agent-pay won't retry it
> blindly. Ops-bob checks the rail and resolves it as failed, and spent today drops from one nineteen to one oh
> seven.

### S8 · CLI `--json` output (2:30–2:50, 20 s)

> Agents can use the same API from the command line. With the json flag, every step prints as one JSON line,
> ending in a summary: status paid, exit code zero. That's agent-pay: policy-guarded payments for AI agents.
