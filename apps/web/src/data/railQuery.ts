import type { Rail } from '../types';

const VALID: Rail[] = ['mock', 'paypal', 'near'];

export function expectedRailFromSearch(search: string): Rail | null {
  const v = new URLSearchParams(search).get('rail');
  if (!v) return null;
  return VALID.includes(v as Rail) ? (v as Rail) : null;
}

export function railMismatchMessage(
  baseUrl: string,
  serverRail: string,
  expected: Rail,
): string {
  return `rail_mismatch: server ${baseUrl} runs rail=${serverRail} but rail=${expected} was expected; restart the API with RAIL=${expected} or drop ?rail=`;
}

export type RailMismatch = { expected: Rail; server: string };

/**
 * Web rail check (mirrors the agent CLI `--rail`): only an explicit `?rail=` can mismatch.
 * Without `?rail=` the UI follows whatever rail the server reports and never flags a mismatch,
 * including for receipts. Mock (in-browser) clients never mismatch.
 */
export function detectRailMismatch(input: {
  clientKind: 'mock' | 'http';
  expected: Rail | null;
  serverRail: string | null;
  receiptRail?: string | null;
}): RailMismatch | null {
  const { clientKind, expected, serverRail, receiptRail } = input;
  if (clientKind !== 'http' || expected === null) return null;
  if (serverRail !== null && serverRail !== expected) return { expected, server: serverRail };
  if (receiptRail && receiptRail !== expected) return { expected, server: receiptRail };
  return null;
}
