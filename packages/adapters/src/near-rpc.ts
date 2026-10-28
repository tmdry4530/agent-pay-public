import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';

export interface NearTransferRequest {
  receiverId: string;
  amountYocto: string;
}

export type NearSendResult =
  | { kind: 'final'; txHash: string; success: boolean; failure?: unknown }
  | { kind: 'rejected'; txHash?: string; error: unknown }
  | { kind: 'unknown'; txHash?: string; error: unknown };

export type NearStatusResult =
  | { kind: 'final'; success: boolean; failure?: unknown }
  | { kind: 'notFound' }
  | { kind: 'unknown'; error: unknown };

export interface NearClient {
  readonly accountId: string;
  sendTransfer(req: NearTransferRequest): Promise<NearSendResult>;
  txStatus(txHash: string): Promise<NearStatusResult>;
}

export interface NearRpcClientOptions {
  rpcUrl: string;
  accountId: string;
  /** `ed25519:<base58 of 64-byte secret (seed||pubkey) or 32-byte seed>`. */
  privateKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Applied to `send_tx`. Defaults to `EXECUTED_OPTIMISTIC`. */
  waitUntil?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_UNTIL = 'EXECUTED_OPTIMISTIC';
/** Status polls always wait until execution; `NONE` does not report SuccessValue/Failure. */
const STATUS_WAIT_UNTIL = 'EXECUTED_OPTIMISTIC';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP: number[] = Array.from({ length: 128 }, () => -1);
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  const code = BASE58_ALPHABET.charCodeAt(i);
  BASE58_MAP[code] = i;
}

/**
 * PKCS#8 DER prefix for a 32-byte Ed25519 seed:
 * SEQUENCE { version INTEGER 0, algorithm OID 1.3.101.112, OCTET STRING { seed } }.
 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const textEncoder = new TextEncoder();

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }
  const digits: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (let k = 0; k < bytes.length - 1 && bytes[k] === 0; k++) {
    out += '1';
  }
  for (let q = digits.length - 1; q >= 0; q--) {
    const digit = digits[q] ?? 0;
    const char = BASE58_ALPHABET[digit];
    if (char === undefined) {
      throw new Error('base58 encode failed');
    }
    out += char;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  if (text.length === 0) {
    return new Uint8Array();
  }
  const bytes: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < BASE58_MAP.length ? BASE58_MAP[code] : undefined;
    if (value === undefined || value < 0) {
      throw new Error('invalid base58 character');
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < text.length - 1 && text[k] === '1'; k++) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export interface TransferTransactionInput {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  depositYocto: bigint;
}

/**
 * Borsh-encode a NEAR `Transaction` with a single `Transfer` action
 * (enum variant index 3). Layout matches nearcore / near-api-js.
 */
export function serializeTransferTransaction(input: TransferTransactionInput): Uint8Array {
  if (input.publicKey.length !== 32) {
    throw new Error('publicKey must be 32 bytes');
  }
  if (input.blockHash.length !== 32) {
    throw new Error('blockHash must be 32 bytes');
  }
  return concat([
    borshString(input.signerId),
    Uint8Array.of(0),
    input.publicKey,
    u64le(input.nonce),
    borshString(input.receiverId),
    input.blockHash,
    u32le(1),
    Uint8Array.of(3),
    u128le(input.depositYocto),
  ]);
}

/**
 * Default testnet RPC: FASTNEAR's public endpoint. NEAR's RPC providers page
 * (https://docs.near.org/api/rpc/providers, checked 2026-10-28) lists it under Testnet as a public endpoint
 * with a free tier and no API key in the URL; its free-tier limit is "Not published". Set NEAR_RPC_URL to override.
 */
export const NEAR_DEFAULT_TESTNET_RPC_URL = 'https://test.rpc.fastnear.com';
export const NEAR_DEFAULT_MAINNET_RPC_URL = 'https://rpc.mainnet.near.org';

export function nearConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  rpcUrl: string;
  accountId: string;
  privateKey: string;
  networkId: 'testnet' | 'mainnet';
} {
  const accountId = env.NEAR_ACCOUNT_ID?.trim() ?? '';
  const privateKey = env.NEAR_PRIVATE_KEY?.trim() ?? '';
  if (accountId === '') {
    throw new Error('NEAR_ACCOUNT_ID environment variable is required');
  }
  if (privateKey === '') {
    throw new Error('NEAR_PRIVATE_KEY environment variable is required');
  }
  const networkRaw = env.NEAR_NETWORK?.trim() || 'testnet';
  if (networkRaw !== 'testnet' && networkRaw !== 'mainnet') {
    throw new Error('NEAR_NETWORK must be testnet or mainnet');
  }
  const rpcUrl =
    env.NEAR_RPC_URL?.trim() ||
    (networkRaw === 'mainnet' ? NEAR_DEFAULT_MAINNET_RPC_URL : NEAR_DEFAULT_TESTNET_RPC_URL);
  return { rpcUrl, accountId, privateKey, networkId: networkRaw };
}

export function createNearRpcClient(opts: NearRpcClientOptions): NearClient {
  const rpcUrl = opts.rpcUrl?.trim() ?? '';
  const accountId = opts.accountId?.trim() ?? '';
  const privateKey = opts.privateKey?.trim() ?? '';
  if (rpcUrl === '') {
    throw new Error('rpcUrl is required');
  }
  if (accountId === '') {
    throw new Error('accountId is required');
  }
  if (privateKey === '') {
    throw new Error('privateKey is required');
  }
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive number');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const waitUntil = opts.waitUntil ?? DEFAULT_WAIT_UNTIL;
  const fetchImpl = opts.fetch ?? fetch;
  const parsed = parseNearPrivateKey(privateKey);
  const secrets = [privateKey, privateKey.startsWith('ed25519:') ? privateKey.slice('ed25519:'.length) : privateKey];
  const publicKeyParam = `ed25519:${base58Encode(parsed.publicKey)}`;

  function scrub(error: unknown): unknown {
    return scrubSecrets(error, secrets);
  }

  async function rpcCall(method: string, params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'dontcare', method, params }),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown = null;
      if (text !== '') {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new Error('RPC response was not JSON');
        }
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    accountId,
    async sendTransfer(req: NearTransferRequest): Promise<NearSendResult> {
      let txHash: string | undefined;
      try {
        const access = await rpcCall('query', {
          request_type: 'view_access_key',
          finality: 'final',
          account_id: accountId,
          public_key: publicKeyParam,
        });
        if (access.status < 200 || access.status >= 300) {
          throw new Error(`access key query failed with HTTP ${access.status}`);
        }
        if (!isRecord(access.body)) {
          throw new Error('access key query returned an invalid body');
        }
        if (access.body.error !== undefined) {
          throw access.body.error;
        }
        const { nonce, blockHash } = readAccessKey(access.body.result);
        if (!/^\d+$/.test(req.amountYocto)) {
          throw new Error('amountYocto must be a non-negative integer string');
        }
        const txBytes = serializeTransferTransaction({
          signerId: accountId,
          publicKey: parsed.publicKey,
          nonce,
          receiverId: req.receiverId,
          blockHash,
          depositYocto: BigInt(req.amountYocto),
        });
        const hash = sha256(txBytes);
        const signature = signHash(hash, parsed.key);
        const signed = concat([txBytes, Uint8Array.of(0), signature]);
        txHash = base58Encode(hash);
        const sent = await rpcCall('send_tx', {
          signed_tx_base64: Buffer.from(signed).toString('base64'),
          wait_until: waitUntil,
        });
        return interpretSend(sent.status, sent.body, txHash, scrub);
      } catch (error) {
        if (txHash === undefined) {
          return { kind: 'rejected', error: scrub(error) };
        }
        return { kind: 'unknown', txHash, error: scrub(error) };
      }
    },

    async txStatus(txHash: string): Promise<NearStatusResult> {
      try {
        const response = await rpcCall('tx', {
          tx_hash: txHash,
          sender_account_id: accountId,
          wait_until: STATUS_WAIT_UNTIL,
        });
        return interpretStatus(response.status, response.body, scrub);
      } catch (error) {
        return { kind: 'unknown', error: scrub(error) };
      }
    },
  };
}

function interpretSend(
  status: number,
  body: unknown,
  txHash: string,
  scrub: (error: unknown) => unknown,
): NearSendResult {
  if (status >= 500) {
    return { kind: 'unknown', txHash, error: scrub(body ?? new Error(`HTTP ${status}`)) };
  }
  if (status >= 400) {
    return { kind: 'rejected', txHash, error: scrub(body ?? new Error(`HTTP ${status}`)) };
  }
  if (!isRecord(body)) {
    return { kind: 'unknown', txHash, error: scrub(new Error('invalid RPC response')) };
  }
  if (body.error !== undefined) {
    const parsed = readRpcError(body.error);
    const error = scrub(body.error);
    if (parsed.causeName === 'TIMEOUT_ERROR') {
      return { kind: 'unknown', txHash, error };
    }
    if (parsed.handlerName === 'HANDLER_ERROR' && parsed.causeName === 'INVALID_TRANSACTION') {
      return { kind: 'rejected', txHash, error };
    }
    // [assumption] A request the node refuses before accepting the tx is rejected.
    // Anything else after broadcast may already be in flight, so it stays unknown.
    if (parsed.causeName === 'REQUEST_VALIDATION_ERROR' || parsed.handlerName === 'REQUEST_VALIDATION_ERROR') {
      return { kind: 'rejected', txHash, error };
    }
    return { kind: 'unknown', txHash, error };
  }
  const execution = readExecutionStatus(body.result);
  if (execution.kind === 'success') {
    return { kind: 'final', txHash, success: true };
  }
  if (execution.kind === 'failure') {
    return { kind: 'final', txHash, success: false, failure: execution.failure };
  }
  return { kind: 'unknown', txHash, error: scrub(new Error('unrecognized transaction status')) };
}

function interpretStatus(
  status: number,
  body: unknown,
  scrub: (error: unknown) => unknown,
): NearStatusResult {
  if (status >= 500) {
    return { kind: 'unknown', error: scrub(body ?? new Error(`HTTP ${status}`)) };
  }
  if (!isRecord(body)) {
    return { kind: 'unknown', error: scrub(new Error('invalid RPC response')) };
  }
  if (body.error !== undefined) {
    const parsed = readRpcError(body.error);
    if (parsed.causeName === 'UNKNOWN_TRANSACTION') {
      return { kind: 'notFound' };
    }
    if (status >= 400 || parsed.causeName === 'TIMEOUT_ERROR') {
      return { kind: 'unknown', error: scrub(body.error) };
    }
    return { kind: 'unknown', error: scrub(body.error) };
  }
  if (status >= 400) {
    return { kind: 'unknown', error: scrub(body) };
  }
  const execution = readExecutionStatus(body.result);
  if (execution.kind === 'success') {
    return { kind: 'final', success: true };
  }
  if (execution.kind === 'failure') {
    return { kind: 'final', success: false, failure: execution.failure };
  }
  return { kind: 'unknown', error: scrub(new Error('unrecognized transaction status')) };
}

function readExecutionStatus(result: unknown): { kind: 'success' } | { kind: 'failure'; failure: unknown } | { kind: 'missing' } {
  if (!isRecord(result) || !isRecord(result.status)) {
    return { kind: 'missing' };
  }
  if (result.status.SuccessValue !== undefined) {
    return { kind: 'success' };
  }
  if (result.status.Failure !== undefined) {
    return { kind: 'failure', failure: result.status.Failure };
  }
  return { kind: 'missing' };
}

function readAccessKey(result: unknown): { nonce: bigint; blockHash: Uint8Array } {
  if (!isRecord(result)) {
    throw new Error('access key query missing result');
  }
  const nonceRaw = result.nonce;
  let nonce: bigint;
  if (typeof nonceRaw === 'number' && Number.isSafeInteger(nonceRaw) && nonceRaw >= 0) {
    nonce = BigInt(nonceRaw);
  } else if (typeof nonceRaw === 'string' && /^\d+$/.test(nonceRaw)) {
    nonce = BigInt(nonceRaw);
  } else {
    throw new Error('access key nonce is invalid');
  }
  const next = nonce + 1n;
  if (next > 0xffffffffffffffffn) {
    throw new Error('access key nonce is out of range');
  }
  if (typeof result.block_hash !== 'string') {
    throw new Error('access key block_hash is missing');
  }
  let blockHash: Uint8Array;
  try {
    blockHash = base58Decode(result.block_hash);
  } catch {
    throw new Error('access key block_hash is not valid base58');
  }
  if (blockHash.length !== 32) {
    throw new Error('access key block_hash must be 32 bytes');
  }
  return { nonce: next, blockHash };
}

/**
 * [assumption] NEAR JSON-RPC errors look like
 * `{ code, message, data: { name: 'HANDLER_ERROR', cause: { name } } }`.
 * `name` / `cause` on the error object itself are also accepted.
 * A string `data` value is treated as the cause name (some nodes send `"UNKNOWN_TRANSACTION"` that way).
 */
function readRpcError(error: unknown): { handlerName?: string; causeName?: string } {
  if (typeof error === 'string') {
    return { causeName: error };
  }
  if (!isRecord(error)) {
    return {};
  }
  const data = error.data;
  if (typeof data === 'string') {
    return {
      handlerName: typeof error.name === 'string' ? error.name : undefined,
      causeName: data,
    };
  }
  const source = isRecord(data) ? data : error;
  const handlerName = typeof source.name === 'string' ? source.name : undefined;
  const cause = source.cause;
  if (isRecord(cause) && typeof cause.name === 'string') {
    return { handlerName, causeName: cause.name };
  }
  return { handlerName };
}

function parseNearPrivateKey(privateKey: string): { publicKey: Uint8Array; key: KeyObject } {
  if (!privateKey.startsWith('ed25519:')) {
    throw new Error('private key must start with ed25519:');
  }
  let raw: Uint8Array;
  try {
    raw = base58Decode(privateKey.slice('ed25519:'.length));
  } catch {
    throw new Error('private key is not valid base58');
  }
  let seed: Uint8Array;
  let publicKey: Uint8Array | undefined;
  if (raw.length === 64) {
    seed = new Uint8Array(raw.subarray(0, 32));
    publicKey = new Uint8Array(raw.subarray(32));
  } else if (raw.length === 32) {
    seed = new Uint8Array(raw);
  } else {
    throw new Error('private key must be a 32-byte seed or 64-byte secret key');
  }
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const derived = publicKeyFromKey(key);
  if (publicKey === undefined) {
    publicKey = derived;
  } else if (!bytesEqual(publicKey, derived)) {
    throw new Error('private key public half does not match the seed');
  }
  return { publicKey, key };
}

function publicKeyFromKey(key: KeyObject): Uint8Array {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  if (typeof der === 'string') {
    throw new Error('unexpected SPKI encoding');
  }
  const bytes = Buffer.from(der);
  if (bytes.length < 32) {
    throw new Error('unexpected SPKI length');
  }
  return new Uint8Array(bytes.subarray(bytes.length - 32));
}

function signHash(hash: Uint8Array, key: KeyObject): Uint8Array {
  const signature = cryptoSign(null, Buffer.from(hash), key);
  if (signature.length !== 64) {
    throw new Error('unexpected ed25519 signature length');
  }
  return new Uint8Array(signature);
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

function scrubSecrets(error: unknown, secrets: readonly string[]): unknown {
  const redact = (input: string): string => {
    let out = input;
    for (const secret of secrets) {
      if (secret.length >= 8) {
        out = out.split(secret).join('[redacted]');
      }
    }
    return out;
  };
  if (error instanceof Error) {
    const next = new Error(redact(error.message));
    next.name = error.name;
    if (typeof error.stack === 'string') {
      next.stack = redact(error.stack);
    }
    return next;
  }
  if (typeof error === 'string') {
    return redact(error);
  }
  if (error === null || error === undefined) {
    return error;
  }
  try {
    return JSON.parse(redact(JSON.stringify(error))) as unknown;
  } catch {
    return new Error('RPC error');
  }
}

function borshString(value: string): Uint8Array {
  const bytes = textEncoder.encode(value);
  return concat([u32le(bytes.length), bytes]);
}

function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('u32 out of range');
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error('u64 out of range');
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function u128le(value: bigint): Uint8Array {
  if (value < 0n || value >= 2n ** 128n) {
    throw new Error('u128 out of range');
  }
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, value & 0xffffffffffffffffn, true);
  view.setBigUint64(8, value >> 64n, true);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
