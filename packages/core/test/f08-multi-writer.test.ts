import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, LedgerError } from '../src/index.ts';
import { makeIntent, tempDir } from './helpers.ts';

const WRITER = fileURLToPath(new URL('./fixtures/ledger-writer.ts', import.meta.url));

function runChild(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

async function onDisk(filePath: string): Promise<string[]> {
  const file = JSON.parse(await readFile(filePath, 'utf8')) as { entries: { intent: { id: string } }[] };
  return file.entries.map((e) => e.intent.id).sort();
}

test('F8: two Ledger instances on one file in one process lose no updates', async (t) => {
  const filePath = join(await tempDir(t), 'ledger.json');
  const a = new Ledger({ filePath });
  const b = new Ledger({ filePath: `${filePath}` });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).recordIntent(makeIntent({ id: `pi-${String(i).padStart(2, '0')}` }))),
  );
  assert.equal((await onDisk(filePath)).length, 20);
});

test('F8: concurrent writer processes lose no updates (lock file)', async (t) => {
  const filePath = join(await tempDir(t), 'ledger.json');
  const codes = await Promise.all(['p1', 'p2', 'p3'].map((p) => runChild([filePath, p, '10'])));
  assert.deepEqual(codes, [0, 0, 0]);
  const ids = await onDisk(filePath);
  assert.equal(ids.length, 30);
});

test('F8: a lock left by a dead process is taken over', async (t) => {
  const filePath = join(await tempDir(t), 'ledger.json');
  // A pid that is certainly dead: a child that has already exited.
  const child = spawn(process.execPath, ['-e', '0']);
  const deadPid = await new Promise<number>((r) => child.on('exit', () => r(child.pid!)));
  await writeFile(`${filePath}.lock`, `${deadPid}\n`);
  const ledger = new Ledger({ filePath, lockTimeoutMs: 2000 });
  await ledger.recordIntent(makeIntent());
  assert.deepEqual(await onDisk(filePath), ['pi-1']);
});

test('F8: a lock held by a live process times out with LedgerError lock_timeout', async (t) => {
  const filePath = join(await tempDir(t), 'ledger.json');
  await writeFile(`${filePath}.lock`, `${process.ppid}\n`); // parent of the test runner: alive
  const ledger = new Ledger({ filePath, lockTimeoutMs: 100 });
  await assert.rejects(ledger.recordIntent(makeIntent()), (err: unknown) => err instanceof LedgerError && err.code === 'lock_timeout');
});
