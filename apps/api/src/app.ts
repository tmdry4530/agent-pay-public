import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Ledger,
  LedgerError,
  PaymentError,
  approve,
  countsTowardDailyTotal,
  reject,
  refreshIntent,
  runPayment,
  utcDay,
  type LedgerEntry,
  type LedgerErrorCode,
  type PaymentAdapter,
  type PaymentErrorCode,
  type Policy,
} from '@agent-pay/core';
import { ValidationError, parseDecisionBody, parseIdempotencyKey, parseIntentBody, parsePolicy } from './validate.ts';
import { resolveRoute } from './resolve-route.ts';

/** Seed policy for demos. Replace at runtime with PUT /policy. */
export const DEFAULT_POLICY: Policy = {
  agentId: 'demo-agent',
  perTxMax: 100,
  dailyMax: 200,
  allowedPayees: ['openai-api', 'anthropic-api', 'vercel', 'near-compute'],
  requireApprovalAbove: 50,
  currency: 'USD',
};

/** Max request body size in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface DemoRailInfo {
  currency: string;
  amountScale: number;
  payees: Record<string, string>;
}

export interface AppOptions {
  /** Ledger instance, or a path to build one. One writer process per file. */
  ledger: Ledger | string;
  adapter: PaymentAdapter;
  /** Initial policy (kept in memory). Defaults to DEFAULT_POLICY. */
  policy?: Policy;
  /** Per-rail demo mapping for GET /rail (currency, scale, logical payee → rail address). */
  demo?: DemoRailInfo;
  /** Clock for generated createdAt and "today" in GET /ledger. */
  now?: () => Date;
  /** Generator for intent ids when the client omits one. */
  newId?: () => string;
}

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const PAYMENT_ERROR_STATUS: Record<PaymentErrorCode, number> = {
  intent_not_found: 404,
  already_paid: 409,
  not_pending: 409,
  in_progress: 409,
  intent_conflict: 409,
  no_receipt: 409,
  receipt_not_pending: 409,
  status_unsupported: 409,
  status_check_failed: 502,
};

const LEDGER_ERROR_STATUS: Record<LedgerErrorCode, number> = {
  precondition_failed: 409,
  not_found: 404,
  duplicate_intent: 409,
  invalid_input: 400,
  lock_timeout: 503,
  ledger_corrupt: 503,
  ledger_missing: 503,
};

const ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** Echoed back in Access-Control-Allow-Origin only for http://localhost:* and http://127.0.0.1:*. */
export function isAllowedOrigin(origin: string | undefined): origin is string {
  return origin !== undefined && ORIGIN_RE.test(origin);
}

type Handler = (req: IncomingMessage, params: string[]) => Promise<{ status: number; body: unknown }>;
type Route = { pattern: RegExp; methods: Partial<Record<string, Handler>> };

/** Builds the request listener plus accessors (no listening socket). */
export function createApp(options: AppOptions) {
  const ledger = typeof options.ledger === 'string' ? new Ledger({ filePath: options.ledger, now: options.now }) : options.ledger;
  const adapter = options.adapter;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => `pi_${randomUUID()}`);
  let policy: Policy = structuredClone(options.policy ?? DEFAULT_POLICY);
  const demo: DemoRailInfo = options.demo ?? {
    currency: policy.currency ?? 'USD',
    amountScale: 1,
    payees: {},
  };

  const routes: Route[] = [
    {
      pattern: /^\/health$/,
      methods: { GET: async () => ({ status: 200, body: { ok: true, rail: adapter.rail } }) },
    },
    {
      pattern: /^\/rail$/,
      methods: {
        GET: async () => ({
          status: 200,
          body: {
            rail: adapter.rail,
            currency: demo.currency,
            amountScale: demo.amountScale,
            payees: demo.payees,
          },
        }),
      },
    },
    {
      pattern: /^\/intents$/,
      methods: {
        POST: async (req) => {
          const raw = await readJson(req);
          const idempotencyKey = parseIdempotencyKey(req.headers['idempotency-key']);
          const intent = parseIntentBody(raw, { id: newId, now, idempotencyKey });
          if (shouldReuseStoredCreatedAt(raw, idempotencyKey)) {
            const existing = await ledger.get(intent.id);
            if (existing) intent.createdAt = existing.intent.createdAt;
          }
          const result = await runPayment(intent, policy, ledger, adapter);
          return { status: result.replayed ? 200 : 201, body: { ...result, intent } };
        },
      },
    },
    {
      pattern: /^\/intents\/([^/]+)\/approve$/,
      methods: {
        POST: async (req, [id]) => {
          const { approver } = parseDecisionBody(await readJson(req), false);
          return { status: 200, body: await approve(id!, { policy, ledger, adapter, approver }) };
        },
      },
    },
    {
      pattern: /^\/intents\/([^/]+)\/reject$/,
      methods: {
        POST: async (req, [id]) => {
          const { approver, note } = parseDecisionBody(await readJson(req), true);
          return { status: 200, body: await reject(id!, { ledger, approver, note }) };
        },
      },
    },
    {
      pattern: /^\/intents\/([^/]+)\/refresh$/,
      methods: {
        POST: async (req, [id]) => {
          await readJson(req);
          const intentId = id!;
          try {
            return { status: 200, body: await refreshIntent(intentId, ledger, adapter) };
          } catch (err) {
            if (err instanceof PaymentError && err.code === 'status_unsupported') {
              const entry = await ledger.get(intentId);
              if (entry && entryNeedsManualResolve(entry)) {
                throw new HttpError(409, `status_unsupported: use POST /intents/${intentId}/resolve`);
              }
            }
            throw err;
          }
        },
      },
    },
    resolveRoute({ ledger, now, readJson }),
    {
      pattern: /^\/ledger$/,
      methods: {
        GET: async () => {
          const entries = await ledger.list();
          const day = utcDay(now());
          const byAgent: Record<string, number> = {};
          for (const e of entries) {
            if (utcDay(e.intent.createdAt) !== day || !countsTowardDailyTotal(e)) continue;
            byAgent[e.intent.agentId] = (byAgent[e.intent.agentId] ?? 0) + e.intent.amount;
          }
          return { status: 200, body: { entries, today: { day, totals: byAgent } } };
        },
      },
    },
    {
      pattern: /^\/policy$/,
      methods: {
        GET: async () => ({ status: 200, body: policy }),
        PUT: async (req) => {
          policy = parsePolicy(await readJson(req));
          return { status: 200, body: policy };
        },
      },
    },
  ];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const cors: Record<string, string> = { Vary: 'Origin' };
    if (isAllowedOrigin(origin)) cors['Access-Control-Allow-Origin'] = origin;
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      let match: { route: Route; params: string[] } | undefined;
      for (const route of routes) {
        const m = route.pattern.exec(path);
        if (m) {
          match = { route, params: m.slice(1).map(decodeParam) };
          break;
        }
      }
      if (!match) throw new HttpError(404, `not_found: no route for ${path}`);
      const allow = [...Object.keys(match.route.methods), 'OPTIONS'].join(', ');
      const method = req.method ?? 'GET';
      if (method === 'OPTIONS') {
        const headers: Record<string, string> = { ...cors, Allow: allow };
        if (cors['Access-Control-Allow-Origin']) {
          headers['Access-Control-Allow-Methods'] = allow;
          headers['Access-Control-Allow-Headers'] = 'Content-Type, Idempotency-Key';
          headers['Access-Control-Max-Age'] = '600';
        }
        res.writeHead(204, headers).end();
        return;
      }
      const handler = match.route.methods[method];
      if (!handler) throw new HttpError(405, `method_not_allowed: ${method} ${path}`, { Allow: allow });
      if (method !== 'GET' && method !== 'HEAD' && origin !== undefined && !isAllowedOrigin(origin)) {
        throw new HttpError(403, `forbidden_origin: origin not allowed for ${method}`);
      }
      const { status, body } = await handler(req, match.params);
      send(res, status, body, cors);
    } catch (err) {
      const mapped = toHttpError(err);
      if (mapped.status >= 500) console.error(err);
      send(res, mapped.status, { error: mapped.error, message: mapped.message }, { ...cors, ...mapped.headers });
      if (mapped.status === 413 || mapped.status === 403) req.resume();
    }
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      send(res, 500, { error: 'internal_error', message: 'unexpected server error' }, {});
    });
  };

  return {
    listener,
    ledger,
    adapter,
    getPolicy: (): Policy => structuredClone(policy),
  };
}

/** createApp + node:http server (not listening yet). */
export function createServer(options: AppOptions): Server {
  return createHttpServer(createApp(options).listener);
}

/** True when createdAt was omitted and the id comes from the body or Idempotency-Key. */
function shouldReuseStoredCreatedAt(body: unknown, idempotencyKey: string | undefined): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const o = body as Record<string, unknown>;
  return o.createdAt === undefined && (idempotencyKey !== undefined || o.id !== undefined);
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'invalid_path: malformed percent-encoding');
  }
}

function toHttpError(err: unknown): { status: number; error: string; message: string; headers: Record<string, string> } {
  if (err instanceof HttpError) return { status: err.status, ...splitCodedMessage(err.message), headers: err.headers };
  if (err instanceof ValidationError) return { status: 400, ...codedDetail(err.code, err.message), headers: {} };
  if (err instanceof PaymentError) {
    return { status: PAYMENT_ERROR_STATUS[err.code] ?? 409, ...codedDetail(err.code, err.message), headers: {} };
  }
  if (err instanceof LedgerError) {
    const headers: Record<string, string> = {};
    let { message } = codedDetail(err.code, err.message);
    if (err.code === 'lock_timeout') {
      headers['Retry-After'] = '1';
      message = 'the ledger is locked by another process; retry shortly';
    }
    return { status: LEDGER_ERROR_STATUS[err.code] ?? 500, error: err.code, message, headers };
  }
  return { status: 500, error: 'internal_error', message: 'unexpected server error', headers: {} };
}

/** `code` plus the text after `"<code>: "`. An empty detail becomes the code itself. */
function codedDetail(code: string, rawMessage: string): { error: string; message: string } {
  const prefix = `${code}: `;
  const detail = rawMessage.startsWith(prefix) ? rawMessage.slice(prefix.length).trim() : rawMessage.trim();
  return { error: code, message: detail.length > 0 ? detail : code };
}

/** HttpError messages are `"<code>: <detail>"`. */
function splitCodedMessage(raw: string): { error: string; message: string } {
  const idx = raw.indexOf(': ');
  if (idx > 0) {
    const error = raw.slice(0, idx).trim();
    if (error.length > 0 && !error.includes(':')) return codedDetail(error, raw);
  }
  const error = raw.trim() || 'internal_error';
  return { error, message: error };
}

/** Entry flag, or a receipt meta flag (`true` / `"true"`). */
function entryNeedsManualResolve(entry: LedgerEntry): boolean {
  if (entry.needsManualResolve === true) return true;
  const receipt = entry.receipt;
  if (receipt === undefined || !('meta' in receipt)) return false;
  const meta = (receipt as { meta: unknown }).meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const flag = (meta as { needsManualResolve?: unknown }).needsManualResolve;
  return flag === true || flag === 'true';
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** Reads and parses a JSON body. Empty body -> undefined. Over MAX_BODY_BYTES -> 413. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, `payload_too_large: body exceeds ${MAX_BODY_BYTES} bytes`, { Connection: 'close' });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, `payload_too_large: body exceeds ${MAX_BODY_BYTES} bytes`, { Connection: 'close' });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new HttpError(415, 'unsupported_media_type: Content-Type must be application/json');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json: request body is not valid JSON');
  }
}

function isJsonContentType(header: string | string[] | undefined): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return false;
  const media = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return media === 'application/json';
}
