import type { IncomingMessage } from 'node:http';
import { resolveIntent, RESOLVE_STATUSES, type Ledger, type ResolveInput, type ResolveStatus } from '@agent-pay/core';
import { ValidationError } from './validate.ts';

const bad = (detail: string) => new ValidationError('invalid_body', detail);

type Obj = Record<string, unknown>;

function asObject(value: unknown, what: string): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad(`${what} must be a JSON object`);
  return value as Obj;
}

function onlyKeys(obj: Obj, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw bad(`${what} has unknown field "${key}"`);
  }
}

function str(obj: Obj, key: string, max: number): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') throw bad(`"${key}" must be a non-empty string`);
  if (v.length > max) throw bad(`"${key}" must be at most ${max} characters`);
  return v;
}

function optAnyStr(obj: Obj, key: string, max: number): string | undefined {
  if (obj[key] === undefined) return undefined;
  const v = obj[key];
  if (typeof v !== 'string') throw bad(`"${key}" must be a string`);
  if (v.length > max) throw bad(`"${key}" must be at most ${max} characters`);
  return v;
}

const RESOLVE_STATUS_SET: ReadonlySet<string> = new Set(RESOLVE_STATUSES);

function parseStatus(o: Obj): ResolveStatus {
  const v = o.status;
  if (v === undefined) throw bad('"status" is required');
  if (typeof v !== 'string') throw bad('"status" must be a string');
  if (v === 'pending') throw bad('"status" must not be "pending"');
  if (!RESOLVE_STATUS_SET.has(v)) {
    throw bad(`"status" must be one of ${RESOLVE_STATUSES.join(', ')}`);
  }
  return v as ResolveStatus;
}

/** Validates POST /intents/:id/resolve body. Unknown fields are rejected. */
export function parseResolveBody(body: unknown): ResolveInput {
  const o = asObject(body, 'body');
  onlyKeys(o, ['status', 'note', 'externalId', 'resolvedBy'], 'body');
  const status = parseStatus(o);
  const note = str(o, 'note', 1000);
  const externalId = optAnyStr(o, 'externalId', 256);
  if (o.resolvedBy === undefined) throw bad('"resolvedBy" is required');
  const resolvedBy = str(o, 'resolvedBy', 128);
  return {
    status,
    note,
    ...(externalId === undefined ? {} : { externalId }),
    resolvedBy,
  };
}

type Handler = (req: IncomingMessage, params: string[]) => Promise<{ status: number; body: unknown }>;

/**
 * Operator endpoint POST /intents/:id/resolve — manually settles a stuck pending receipt.
 * Never calls adapter pay() or status(); 404 intent_not_found, 409 no_receipt / receipt_not_pending, 400 validation.
 */
export function resolveRoute(deps: {
  ledger: Ledger;
  now: () => Date;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}): { pattern: RegExp; methods: Partial<Record<string, Handler>> } {
  return {
    pattern: /^\/intents\/([^/]+)\/resolve$/,
    methods: {
      POST: async (req, [id]) => ({
        status: 200,
        body: await resolveIntent(id!, deps.ledger, parseResolveBody(await deps.readJson(req)), deps.now),
      }),
    },
  };
}
