import type { PaymentIntent, Policy } from '@agent-pay/core';

/** Thrown for a request body that is not acceptable; mapped to HTTP 400. */
export class ValidationError extends Error {
  override name = 'ValidationError';
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

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

function optStr(obj: Obj, key: string, max: number): string | undefined {
  return obj[key] === undefined ? undefined : str(obj, key, max);
}

function num(obj: Obj, key: string, { positive }: { positive: boolean }): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`"${key}" must be a finite number`);
  if (positive ? v <= 0 : v < 0) throw bad(`"${key}" must be ${positive ? '> 0' : '>= 0'}`);
  return v;
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Client-supplied fields of POST /intents. */
export const INTENT_REQUIRED = ['agentId', 'payee', 'amount', 'currency', 'purpose'] as const;
export const INTENT_OPTIONAL = ['id', 'createdAt'] as const;

/**
 * Validates a POST /intents body and fills in server defaults:
 * - required: agentId, payee, amount (finite > 0), currency, purpose
 * - optional: id (1-128 of [A-Za-z0-9._:-]; default "pi_<uuid>"),
 *   createdAt (ISO 8601 with a zone; default now). createdAt is kept verbatim.
 * Unknown fields are rejected.
 */
export function parseIntentBody(body: unknown, gen: { id: () => string; now: () => Date }): PaymentIntent {
  const o = asObject(body, 'body');
  onlyKeys(o, [...INTENT_REQUIRED, ...INTENT_OPTIONAL], 'body');
  const agentId = str(o, 'agentId', 128);
  const payee = str(o, 'payee', 256);
  const amount = num(o, 'amount', { positive: true });
  const currency = str(o, 'currency', 16);
  const purpose = str(o, 'purpose', 1000);
  let id: string;
  if (o.id === undefined) id = gen.id();
  else if (typeof o.id === 'string' && ID_RE.test(o.id)) id = o.id;
  else throw bad('"id" must be 1-128 characters of [A-Za-z0-9._:-]');
  let createdAt: string;
  if (o.createdAt === undefined) createdAt = gen.now().toISOString();
  else if (typeof o.createdAt === 'string' && ISO_RE.test(o.createdAt) && !Number.isNaN(Date.parse(o.createdAt))) {
    createdAt = o.createdAt;
  } else throw bad('"createdAt" must be an ISO 8601 timestamp with a zone, e.g. 2026-10-28T10:00:00Z');
  return { id, agentId, payee, amount, currency, purpose, createdAt };
}

/** Validates a full Policy (PUT /policy). Unknown fields are rejected. */
export function parsePolicy(body: unknown): Policy {
  const o = asObject(body, 'policy');
  onlyKeys(o, ['agentId', 'perTxMax', 'dailyMax', 'allowedPayees', 'requireApprovalAbove', 'currency'], 'policy');
  const agentId = str(o, 'agentId', 128);
  const perTxMax = num(o, 'perTxMax', { positive: false });
  const dailyMax = num(o, 'dailyMax', { positive: false });
  const requireApprovalAbove = num(o, 'requireApprovalAbove', { positive: false });
  const payees = o.allowedPayees;
  if (!Array.isArray(payees) || payees.length > 1000) throw bad('"allowedPayees" must be an array (max 1000)');
  const allowedPayees = payees.map((p, i) => {
    if (typeof p !== 'string' || p.trim() === '' || p.length > 256) {
      throw bad(`"allowedPayees[${i}]" must be a non-empty string (max 256)`);
    }
    return p;
  });
  const currency = optStr(o, 'currency', 16);
  return {
    agentId,
    perTxMax,
    dailyMax,
    allowedPayees,
    requireApprovalAbove,
    ...(currency === undefined ? {} : { currency: currency.toUpperCase() }),
  };
}

/** Optional body of POST /intents/:id/approve and /reject. Empty body = {}. */
export function parseDecisionBody(body: unknown, allowNote: boolean): { approver?: string; note?: string } {
  if (body === undefined) return {};
  const o = asObject(body, 'body');
  onlyKeys(o, allowNote ? ['approver', 'note'] : ['approver'], 'body');
  const approver = optStr(o, 'approver', 128);
  const note = allowNote ? optStr(o, 'note', 1000) : undefined;
  return { ...(approver === undefined ? {} : { approver }), ...(note === undefined ? {} : { note }) };
}
