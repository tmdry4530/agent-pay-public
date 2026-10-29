import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Ledger,
  PaymentError,
  approve,
  countsTowardDailyTotal,
  reject,
  refreshIntent,
  runPayment,
  utcDay,
  type PaymentAdapter,
  type PaymentErrorCode,
  type Policy,
} from '@agent-pay/core';
import { ValidationError, parseDecisionBody, parseIntentBody, parsePolicy } from './validate.ts';
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
          const intent = parseIntentBody(await readJson(req), { id: newId, now });
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
          return { status: 200, body: await refreshIntent(id!, ledger, adapter) };
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
          headers['Access-Control-Allow-Headers'] = 'Content-Type';
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
      const { status, message, headers } = toHttpError(err);
      if (status >= 500) console.error(err);
      send(res, status, { error: message }, { ...cors, ...headers });
      if (status === 413 || status === 403) req.resume();
    }
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end();
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

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'invalid_path: malformed percent-encoding');
  }
}

function toHttpError(err: unknown): { status: number; message: string; headers: Record<string, string> } {
  if (err instanceof HttpError) return { status: err.status, message: err.message, headers: err.headers };
  if (err instanceof ValidationError) return { status: 400, message: err.message, headers: {} };
  if (err instanceof PaymentError) return { status: PAYMENT_ERROR_STATUS[err.code] ?? 409, message: err.message, headers: {} };
  return { status: 500, message: 'internal_error: unexpected server error', headers: {} };
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
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json: request body is not valid JSON');
  }
}
