import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ledger, LedgerError, runPayment } from '../src/index.ts';
import { basePolicy, delayedAdapter, makeIntent, newLedger, tempDir } from './helpers.ts';

const isCorrupt = (err: unknown) => err instanceof LedgerError && err.code === 'ledger_corrupt';

async function seeded(t: Parameters<typeof tempDir>[0]): Promise<{ filePath: string; good: Record<string, unknown> }> {
  const dir = await tempDir(t);
  const ledger = newLedger(dir);
  await runPayment(makeIntent(), basePolicy(), ledger, delayedAdapter(0));
  const good = JSON.parse(await readFile(ledger.filePath, 'utf8')) as Record<string, unknown>;
  return { filePath: ledger.filePath, good };
}

const cases: [string, (good: any) => string][] = [
  ['truncated JSON', (g) => JSON.stringify(g).slice(0, 40)],
  ['empty file', () => ''],
  ['wrong version', (g) => JSON.stringify({ ...g, version: 2 })],
  ['entries not an array', () => JSON.stringify({ version: 1, entries: {} })],
  ['entry with unparseable createdAt', (g) => { g.entries[0].intent.createdAt = 'garbage'; return JSON.stringify(g); }],
  ['entry with string amount', (g) => { g.entries[0].intent.amount = '150'; return JSON.stringify(g); }],
  ['entry with unknown payment status', (g) => { g.entries[0].paymentStatus = 'maybe'; return JSON.stringify(g); }],
  ['duplicate intent ids', (g) => { g.entries.push(structuredClone(g.entries[0])); return JSON.stringify(g); }],
];

for (const [name, corrupt] of cases) {
  test(`F10: ${name} → LedgerError ledger_corrupt on read and on runPayment; file untouched`, async (t) => {
    const { filePath, good } = await seeded(t);
    const bad = corrupt(structuredClone(good));
    await writeFile(filePath, bad);
    const ledger = new Ledger({ filePath });
    await assert.rejects(ledger.list(), isCorrupt);
    await assert.rejects(runPayment(makeIntent({ id: 'pi-2' }), basePolicy(), ledger, delayedAdapter(0)), isCorrupt);
    assert.equal(await readFile(filePath, 'utf8'), bad, 'a corrupt ledger is never rewritten');
  });
}

test('F10: ledger_corrupt message names the file and the bad field', async (t) => {
  const { filePath, good } = await seeded(t);
  (good as any).entries[0].intent.amount = '150';
  await writeFile(filePath, JSON.stringify(good));
  await assert.rejects(new Ledger({ filePath }).list(), (err: unknown) => {
    assert.ok(isCorrupt(err));
    const msg = (err as Error).message;
    assert.match(msg, /^ledger_corrupt: /);
    assert.ok(msg.includes(filePath), msg);
    assert.match(msg, /entries\[0\]\.intent\.amount/);
    return true;
  });
});

test('F10: a valid legacy file (no decisions history) still loads', async (t) => {
  const { filePath, good } = await seeded(t);
  for (const e of (good as any).entries) delete e.decisions;
  await writeFile(filePath, JSON.stringify(good));
  const [entry] = await new Ledger({ filePath }).list();
  assert.equal(entry?.decisions.length, 1);
});
