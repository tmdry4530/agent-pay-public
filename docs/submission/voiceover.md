# agent-pay: submission video voiceover

Spoken English narration for `docs/demo/agent-pay-submission.webm` (170 s, 8 scenes). It is written to be heard,
so it does not read the on-screen captions word for word; the facts match the captions and
[`video-script.md`](video-script.md). Everything shown runs on the mock rail. On-screen text is unchanged.

- Voice: ElevenLabs premade voice "Eric - Smooth, Trustworthy" (`cjVigY5qzO86Huf0OWal`), model
  `eleven_multilingual_v2`, stability 0.5, similarity 0.75, style 0.15, speaker boost on, speed 0.92.
- Cues: each scene is split into short cue lines. Each cue is its own clip, placed at the on-screen moment it
  describes (caption onsets and click times from the recorder's timing output). A cue starts at its anchor, or
  0.35 s after the previous cue ends if that is later, and every scene's speech ends at least 1 s before the next
  scene starts.
- Spoken spellings: amounts are written as words with "dollars" ("a hundred nineteen dollars"), so they are
  not read like clock times. The operator is written "Ops Bob" so it is read as a name, not spelled out letter
  by letter. The screen still shows `$119` and `ops-bob`.
- Generated with `scripts/narration/generate-voiceover.mjs` (reads `ELEVENLABS_API_KEY` from the environment
  only), placed and muxed with `scripts/narration/mux-voiceover.mjs`.

Each `> @<seconds> <text>` line is one cue: the anchor time in the video, then the exact text sent to
text-to-speech. Cue ids are `S<scene>.<n>` in order. The placed start and end times are in the table at the end.

### S1 · Intro (0:00–0:20, 20 s)

> @0.5 AI agents are starting to spend real money, and an API key on its own has no limits.
> @6.8 agent-pay puts a policy between the agent and the payment rail.
> @11.9 Here, the limit is a hundred dollars per payment and two hundred dollars a day, all on a mock rail.

### S2 · $12 payment paid (0:20–0:45, 25 s)

> @20.4 First up: twelve dollars of API credits from the OpenAI API.
> @25.2 The agent turns that task into a payment intent: who to pay, how much, and why. Then it sends it to agent-pay.
> @32.8 The policy checks the amount, the payee, and today's total.
> @37.4 Twelve dollars is well within policy, so the mock rail pays it and hands back a receipt.

### S3 · Over-limit payment rejected (0:45–1:05, 20 s)

> @45.4 Now the agent tries to rent a GPU cluster for four hundred eighty dollars.
> @51.0 That's way over the per-payment max of a hundred dollars, so the policy rejects it on the spot.
> @57.8 The rail is never called, and spent today stays at forty-four dollars.

### S4 · $75 payment waiting for approval (1:05–1:30, 25 s)

> @65.4 Next, seventy-five dollars of NEAR compute hours.
> @68.4 That's inside the hard limits, but above the fifty-dollar sign-off threshold, so the decision is: needs approval.
> @76.9 Nothing is paid yet.
> @78.7 The intent waits in the ledger until a person approves or denies it, right here in the UI, or with one call to the approve endpoint.

### S5 · Approved, then paid (1:30–1:50, 20 s)

> @90.4 The operator approves.
> @92.2 agent-pay re-checks the hard limits and the payee allowlist at approval time, then pays on the mock rail.
> @101.1 The receipt comes back, and spent today climbs to a hundred nineteen dollars. The rejected payment never counted.

### S6 · Ledger view (1:50–2:10, 20 s)

> @110.4 Every step lands in the ledger, in a fixed order: the intent, the policy or human decision, the payment, and the receipt.
> @120.6 Rejected and pending intents are recorded too.
> @123.1 And replaying the same intent returns the stored result, instead of paying twice.

### S7 · Intents & manual resolve (2:10–2:30, 20 s)

> @130.4 Now the tricky case: a rail call broke mid-payment, so the outcome is unknown.
> @134.6 agent-pay won't retry it blindly, and the payment keeps holding its share of the limit.
> @139.4 Ops Bob checks the rail, and resolves it as failed.
> @143.6 Spent today falls from a hundred nineteen dollars to a hundred seven dollars.

### S8 · CLI `--json` output (2:30–2:50, 20 s)

> @150.4 Agents can use the same API from the command line.
> @153.1 A rule-based planner turns "buy one million tokens of GPT inference" into a ten-dollar quote.
> @160.3 Each step is one JSON line, ending in a summary: status paid, exit code zero. That's agent-pay.


## Placed cue times

Speech start and end for each cue in the muxed video (seconds), as placed by `mux-voiceover.mjs` and checked
on the final audio track with `silencedetect` (-45 dB). Caption and click times come from the recorder's timing
output.

| Cue | Anchor | Speech | On screen |
| --- | ---: | --- | --- |
| S1.1 | 0.5 | 0.50–5.60 | Intro caption (0.5 s) |
| S1.2 | 6.8 | 6.80–9.96 | Intro caption, policy-between sentence |
| S1.3 | 11.9 | 11.90–16.94 | Spending-limit caption (11.8 s) |
| S2.1 | 20.4 | 20.40–24.14 | "First task" caption (20.0 s) |
| S2.2 | 25.2 | 25.20–31.57 | "Turns the task into a payment intent" (25.1 s) |
| S2.3 | 32.8 | 32.80–35.46 | "Policy engine checks" (32.8 s) |
| S2.4 | 37.4 | 37.40–42.16 | "Within policy … succeeded receipt" (37.4 s) |
| S3.1 | 45.4 | 45.40–49.20 | GPU cluster caption (45.0 s) |
| S3.2 | 51.0 | 51.00–56.53 | per_tx_limit_exceeded rejection (51.0 s) |
| S3.3 | 57.8 | 57.80–61.60 | "Rail is never called" (57.8 s) |
| S4.1 | 65.4 | 65.40–67.89 | NEAR compute caption (65.0 s) |
| S4.2 | 68.4 | 68.40–75.25 | "Decision is needs approval" (68.2 s) |
| S4.3 | 76.9 | 76.90–77.86 | "Nothing is paid yet" (76.8 s) |
| S4.4 | 78.7 | 78.70–86.26 | "Sits in the ledger until a human approves" (78.6 s) |
| S5.1 | 90.4 | 90.40–91.46 | "The operator approves" (90.0 s) |
| S5.2 | 92.2 | 92.20–98.80 | Re-check at approval time (same caption) |
| S5.3 | 101.1 | 101.10–107.17 | Receipt, spent today $119 (101.1 s) |
| S6.1 | 110.4 | 110.40–117.98 | Ledger caption (110.0 s) |
| S6.2 | 120.6 | 120.60–122.75 | "Rejected and pending intents" (121.0 s) |
| S6.3 | 123.1 | 123.10–127.65 | Replay caption (same) |
| S7.1 | 130.4 | 130.40–134.73 | Rail call broke caption (130.0 s), gauge $119 (131.7 s) |
| S7.2 | 134.6 | 135.08–139.54 | "Stays pending, keeps holding the limit" (134.5 s), Resolve… click (133.7 s) |
| S7.3 | 139.4 | 139.89–142.39 | Record outcome by ops-bob (139.4 s), FAILED (140.1 s) |
| S7.4 | 143.6 | 143.60–147.52 | Gauge $107 (144.1 s) |
| S8.1 | 150.4 | 150.40–152.94 | CLI caption (150.4 s) |
| S8.2 | 153.1 | 153.29–159.76 | Planner quote caption (153.0 s) |
| S8.3 | 160.3 | 160.30–167.81 | JSON summary caption (160.9 s) |

Per scene, measured on the final track: every scene's speech starts within 0.6 s of the scene start and ends 1.7–3.7 s
before the next scene; the longest pause inside a scene is 2.6 s (S6, before the rejected/pending caption).
Mix: -16.0 LUFS integrated, true peak -2.0 dBTP; video stream copied unchanged.
