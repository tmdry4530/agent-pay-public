/**
 * Estimates server time from the HTTP `Date` response header.
 *
 * `offsetMs = server Date header − local receive time`. The header has 1 s resolution, so
 * the estimate can be off by up to ~1 s, which is fine against a 60 s stuck threshold.
 *
 * Cross-origin responses expose `Date` only when the API sends `Access-Control-Expose-Headers: Date`;
 * otherwise the header reads as null and the offset stays 0.
 */

/** Parses an HTTP `Date` header to epoch milliseconds, or undefined when missing/empty/unparseable. */
export function parseServerDate(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return ms;
}

/** Server clock minus local receive time; undefined when the header is invalid. */
export function computeClockOffsetMs(
  dateHeader: string | null | undefined,
  localReceiveMs: number,
): number | undefined {
  const serverMs = parseServerDate(dateHeader);
  if (serverMs === undefined) return undefined;
  return serverMs - localReceiveMs;
}

/** Applies a stored offset to the local clock for comparisons with server-recorded timestamps. */
export function serverNow(localNow: Date, offsetMs: number): Date {
  return new Date(localNow.getTime() + offsetMs);
}
