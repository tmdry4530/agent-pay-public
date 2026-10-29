import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Ledger, LedgerError } from '../src/index.ts';
import { makeIntent, tempDir } from './helpers.ts';

const missing = (err: unknown) => err instanceof LedgerError && err.code === 'ledger_missing';

test('F9: first run creates the ledger file', async (t) => {
  const filePath = join(await tempDir(t), 'nested', 'ledger.json');
  const ledger = new Ledger({ filePath });
  assert.deepEqual((await ledger.load()).entries, []);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 1);
  await ledger.recordIntent(makeIntent());
  assert.equal((await ledger.load()).entries.length, 1);
});

test('F9: a file that was read and then disappears throws ledger_missing (reads and writes), not a silent reset', async (t) => {
  const filePath = join(await tempDir(t), 'ledger.json');
  const ledger = new Ledger({ filePath });
  await ledger.recordIntent(makeIntent());
  await rm(filePath);
  await assert.rejects(ledger.load(), missing);
  await assert.rejects(ledger.get('pi-1'), missing);
  await assert.rejects(ledger.recordIntent(makeIntent({ id: 'pi-2' })), missing);
  await assert.rejects(ledger.dailyTotal('agent-1'), missing);
  await assert.rejects(readFile(filePath), { code: 'ENOENT' }, 'nothing was recreated');
  // Another instance in the same process on the same path also refuses.
  await assert.rejects(new Ledger({ filePath }).load(), missing);
});
