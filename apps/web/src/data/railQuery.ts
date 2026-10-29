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
