// Demo seed: fills the ledger file at LEDGER_PATH with two entries that need a human, using the REAL
// core functions (runPayment + Ledger), so the web Resolve form can be shown against the real API.
//   1. "Buy API credits (rail error)": the adapter throws -> paid + receipt pending + needsManualResolve.
//   2. "Deploy preview (stuck)": a payment left in `submitting` with timestamps 2 minutes in the past
//      (older than the 60 s pay timeout), as if the API process died mid-payment.
// It only writes the ledger; it adds nothing to the API. Either run it while the API is stopped, then start
// the API with the same LEDGER_PATH, or against a running API's ledger (core takes the file lock per op). Usage (repo root):
//   LEDGER_PATH=/tmp/agent-pay-demo/ledger.json npm run demo:seed-needs-check
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, runPayment } from '../../../packages/core/src/index.ts';

// The API's own DEFAULT_POLICY, loaded via Node 24's built-in TypeScript type stripping
// (policy-defaults.ts has only `import type`). Relative path: if the API module moves, fail loudly.
const policyDefaultsUrl = new URL('../../api/src/policy-defaults.ts', import.meta.url);
let DEFAULT_POLICY;
try {
  ({ DEFAULT_POLICY } = await import(policyDefaultsUrl.href));
  if (!DEFAULT_POLICY || typeof DEFAULT_POLICY !== 'object') throw new Error('module has no DEFAULT_POLICY export');
} catch (err) {
  console.error(`seed-needs-check: could not load DEFAULT_POLICY from ${fileURLToPath(policyDefaultsUrl)}`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error('  (needs Node >= 22.18 / 24 type stripping and apps/api/src/policy-defaults.ts exporting DEFAULT_POLICY)');
  process.exit(3);
}

const raw = process.env.LEDGER_PATH;
if (!raw) {
  console.error('LEDGER_PATH is required (the same path the API will use), e.g.\n  LEDGER_PATH=/tmp/agent-pay-demo/ledger.json npm run demo:seed-needs-check');
  process.exit(2);
}
const filePath = isAbsolute(raw) ? raw : resolve(process.env.INIT_CWD ?? process.cwd(), raw);
const rail = process.env.RAIL || 'mock';
const STALE_MS = 2 * 60_000;

// The API's own DEFAULT_POLICY (side-effect-free module), so the seed cannot drift from the server.
const policy = DEFAULT_POLICY;
const stamp = Date.now().toString(36);

const ledger = new Ledger({ filePath });
const throwing = {
  rail,
  async pay() {
    throw new Error('connection reset by rail');
  },
  async status() {
    throw new Error('status unsupported');
  },
};
const needsCheck = {
  id: `seed-needs-check-${stamp}`,
  agentId: policy.agentId,
  payee: 'openai-api',
  amount: 12,
  currency: 'USD',
  purpose: 'Buy API credits (rail error)',
  createdAt: new Date().toISOString(),
};
await runPayment(needsCheck, policy, ledger, throwing);

const past = () => new Date(Date.now() - STALE_MS);
const staleLedger = new Ledger({ filePath, now: past });
const neverSettles = { rail, pay: () => new Promise(() => {}), async status() { throw new Error('status unsupported'); } };
const stuck = {
  id: `seed-stuck-${stamp}`,
  agentId: policy.agentId,
  payee: 'vercel',
  amount: 20,
  currency: 'USD',
  purpose: 'Deploy preview (stuck)',
  createdAt: past().toISOString(),
};
// The pay promise never settles; we only wait until the `submitting` mark is on disk.
void runPayment(stuck, policy, staleLedger, neverSettles, { payTimeoutMs: 2_147_000_000 });

const deadline = Date.now() + 10_000;
let a, b;
while (Date.now() < deadline) {
  [a, b] = await Promise.all([ledger.get(needsCheck.id), ledger.get(stuck.id)]);
  if (a?.needsManualResolve && b?.paymentStatus === 'submitting') break;
  await new Promise((r) => setTimeout(r, 50));
}
const ok = Boolean(a?.needsManualResolve) && b?.paymentStatus === 'submitting';
console.log(`ledger: ${filePath}`);
console.log(`  ${needsCheck.id}  ${a?.paymentStatus}/${a?.receipt?.status}  needsManualResolve=${Boolean(a?.needsManualResolve)}  "${needsCheck.purpose}"`);
console.log(`  ${stuck.id}  ${b?.paymentStatus ?? 'missing'}  since ${b?.submission?.at ?? b?.updatedAt}  "${stuck.purpose}"`);
if (!ok) console.error('seed did not reach the expected states (daily limit used up? use a fresh LEDGER_PATH)');
process.exit(ok ? 0 : 1);
