import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ledger } from '../src/index.ts';
import { makeIntent, tempDir } from './helpers.ts';

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  return new Promise<number>((r) => child.on('exit', () => r(child.pid!)));
}

test('F13: tmp files left by a crashed writer are removed on the next load, live ones are kept', async (t) => {
  const dir = await tempDir(t);
  const filePath = join(dir, 'ledger.json');
  await new Ledger({ filePath }).recordIntent(makeIntent());
  const dead = `ledger.json.${await deadPid()}.1761600000000.deadbeef.tmp`;
  const live = `ledger.json.${process.ppid}.1761600000000.cafebabe.tmp`;
  const other = `other.json.${await deadPid()}.1761600000000.deadbeef.tmp`;
  for (const name of [dead, live, other]) await writeFile(join(dir, name), '{"partial');

  const fresh = new Ledger({ filePath });
  const file = await fresh.load();
  assert.equal(file.entries.length, 1);
  const names = await readdir(dir);
  assert.ok(!names.includes(dead), 'dead writer tmp removed');
  assert.ok(names.includes(live), 'tmp of a live process kept');
  assert.ok(names.includes(other), 'tmp of another ledger file untouched');
});

test('F13: tmp files are also swept before the first write, and a write leaves no tmp behind', async (t) => {
  const dir = await tempDir(t);
  const filePath = join(dir, 'ledger.json');
  const dead = `ledger.json.${await deadPid()}.1761600000000.deadbeef.tmp`;
  await writeFile(join(dir, dead), '{"partial');
  const ledger = new Ledger({ filePath });
  await ledger.recordIntent(makeIntent());
  assert.deepEqual((await readdir(dir)).sort(), ['ledger.json']);
});
