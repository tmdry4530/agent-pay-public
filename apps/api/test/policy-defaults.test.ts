import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { policyProblem, type Policy } from '@agent-pay/core';
import { DEFAULT_POLICY as reexportedDefaultPolicy } from '../src/index.ts';

const POLICY_DEFAULTS_PATH = join(import.meta.dirname, '../src/policy-defaults.ts');
const POLICY_DEFAULTS_HREF = pathToFileURL(POLICY_DEFAULTS_PATH).href;

/** A few seconds: the import must exit on its own and must not leave a listener up. */
const IMPORT_TIMEOUT_MS = 4_000;

const FORBIDDEN_SOURCE: readonly { label: string; re: RegExp }[] = [
  { label: 'process.env', re: /\bprocess\.env\b/ },
  { label: 'node:fs', re: /\bnode:fs\b/ },
  { label: 'node:http', re: /\bnode:http\b/ },
  { label: 'node:net', re: /\bnode:net\b/ },
  { label: 'createServer', re: /\bcreateServer\b/ },
  { label: 'listen(', re: /\blisten\s*\(/ },
];

interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runModuleImport(env: NodeJS.ProcessEnv): Promise<ChildRun> {
  const code = [
    `const { DEFAULT_POLICY } = await import(${JSON.stringify(POLICY_DEFAULTS_HREF)});`,
    'process.stdout.write(JSON.stringify(DEFAULT_POLICY));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, IMPORT_TIMEOUT_MS);
    const out = child.stdout;
    const err = child.stderr;
    if (out === null || err === null) {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error('spawn did not pipe stdout/stderr'));
      return;
    }
    out.setEncoding('utf8');
    err.setEncoding('utf8');
    out.on('data', (chunk: string) => {
      stdout += chunk;
    });
    err.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ code: exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function isEnoent(err: unknown): boolean {
  return err !== null && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';
}

/** Hostile PORT / RAIL / LEDGER_PATH: enough for main.ts to fail before any rail I/O. */
function breakStartEnv(ledgerPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (/^(PAYPAL|NEAR)_/.test(key)) continue;
    if (key === 'NODE_OPTIONS' || key === 'NODE_DEBUG' || key === 'NODE_DEBUG_NATIVE') continue;
    env[key] = value;
  }
  env.PORT = 'not-a-port';
  env.RAIL = 'paypal';
  env.LEDGER_PATH = ledgerPath;
  return env;
}

function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? '';
    const n = source[i + 1] ?? '';
    if (c === '/' && n === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += source[i] === '*' ? 2 : 0;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i += 1;
      while (i < source.length) {
        const ch = source[i] ?? '';
        out += ch;
        i += 1;
        if (ch === '\\' && i < source.length) {
          out += source[i] ?? '';
          i += 1;
          continue;
        }
        if (ch === c) break;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function splitCommas(inside: string): string[] {
  return inside.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

/** True when every binding in the clause is `type` (no value import). */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\s/.test(trimmed)) return true;
  const braceStart = trimmed.indexOf('{');
  if (braceStart === -1) return false;
  const before = trimmed.slice(0, braceStart).replace(/,\s*$/, '').trim();
  if (before.length > 0) return false;
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceEnd < braceStart) return false;
  const parts = splitCommas(trimmed.slice(braceStart + 1, braceEnd));
  return parts.length > 0 && parts.every((part) => /^type\s+\S/.test(part));
}

function assertImportsAreAllowed(source: string): void {
  const stripped = stripComments(source);
  const fromRe = /\b(?:import|export)\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g;
  const problems: string[] = [];
  for (const match of stripped.matchAll(fromRe)) {
    const clause = match[1] ?? '';
    const specifier = match[3] ?? '';
    if (specifier === '@agent-pay/core') continue;
    if (isTypeOnlyClause(clause)) continue;
    problems.push(`${clause.trim()} from '${specifier}'`);
  }
  const bareRe = /\bimport\s+(['"])([^'"]+)\1/g;
  for (const match of stripped.matchAll(bareRe)) {
    const specifier = match[2] ?? '';
    if (specifier !== '@agent-pay/core') problems.push(`import '${specifier}'`);
  }
  const dynamicRe = /\bimport\s*\(/g;
  for (const match of stripped.matchAll(dynamicRe)) {
    const rest = stripped.slice(match.index ?? 0);
    const literal = /^import\s*\(\s*(['"])([^'"]+)\1\s*\)/.exec(rest);
    const specifier = literal?.[2];
    if (specifier !== '@agent-pay/core') problems.push(`import(${specifier === undefined ? '…' : `'${specifier}'`})`);
  }
  assert.deepEqual(problems, [], `disallowed imports:\n${problems.join('\n')}`);
}

function assertNoRuntimeReferences(source: string): void {
  const hits = FORBIDDEN_SOURCE.filter(({ re }) => re.test(source)).map(({ label }) => label);
  assert.deepEqual(hits, [], `policy-defaults.ts must not reference: ${hits.join(', ')}`);
}

function isPolicy(value: unknown): value is Policy {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function loadDefaultPolicy(): Promise<Policy> {
  const loaded = (await import(POLICY_DEFAULTS_HREF)) as { DEFAULT_POLICY?: unknown };
  const policy = loaded.DEFAULT_POLICY;
  assert.ok(isPolicy(policy), 'DEFAULT_POLICY must be an object');
  return policy;
}

test('importing policy-defaults.ts does not start a server or create the ledger', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pay-policy-defaults-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, 'ledger.json');
  const result = await runModuleImport(breakStartEnv(ledgerPath));

  assert.equal(result.timedOut, false, 'process must exit on its own (no listening server)');
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, `import exited ${String(result.code)}`);
  assert.equal(result.stderr, '');
  const parsed: unknown = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(parsed), 'stdout must be only JSON.stringify(DEFAULT_POLICY)');
  assert.deepEqual(parsed, await loadDefaultPolicy());
  await assert.rejects(access(ledgerPath), isEnoent);
});

test('policy-defaults.ts source imports only types or @agent-pay/core and touches no server APIs', async () => {
  const source = await readFile(POLICY_DEFAULTS_PATH, 'utf8');
  assertImportsAreAllowed(source);
  assertNoRuntimeReferences(source);
});

test('policyProblem(DEFAULT_POLICY, { dailyTotal: 0 }) is undefined', async () => {
  const policy = await loadDefaultPolicy();
  assert.equal(policyProblem(policy, { dailyTotal: 0 }), undefined);
});

test('index.ts re-exports the same DEFAULT_POLICY object as policy-defaults.ts', async () => {
  const policy = await loadDefaultPolicy();
  assert.equal(reexportedDefaultPolicy, policy);
  assert.deepEqual(reexportedDefaultPolicy, policy);
});
