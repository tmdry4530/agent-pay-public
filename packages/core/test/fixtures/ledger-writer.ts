// Child process for the F8 cross-process test: appends N intents to a shared ledger file.
import { Ledger } from '../../src/index.ts';

const [filePath, prefix, count] = process.argv.slice(2) as [string, string, string];
const ledger = new Ledger({ filePath });
for (let i = 0; i < Number(count); i++) {
  await ledger.recordIntent({
    id: `${prefix}-${i}`,
    agentId: 'agent-1',
    payee: 'openai-api',
    amount: 1,
    currency: 'USD',
    purpose: 'cross-process',
    createdAt: '2026-10-28T10:00:00.000Z',
  });
}
