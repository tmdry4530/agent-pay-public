import { describe, expect, it } from 'vitest';
import { computeClockOffsetMs, parseServerDate, serverNow } from '../serverClock';

describe('serverClock', () => {
  describe('parseServerDate', () => {
    it('parses valid RFC 1123 Date header', () => {
      const header = 'Wed, 21 Oct 2015 07:28:00 GMT';
      expect(parseServerDate(header)).toBe(Date.parse(header));
    });

    it('returns undefined for missing, empty, and garbage', () => {
      expect(parseServerDate(null)).toBeUndefined();
      expect(parseServerDate(undefined)).toBeUndefined();
      expect(parseServerDate('')).toBeUndefined();
      expect(parseServerDate('   ')).toBeUndefined();
      expect(parseServerDate('not-a-date')).toBeUndefined();
    });
  });

  describe('computeClockOffsetMs', () => {
    const localReceive = 1_000_000;

    it('is positive when server is ahead of local', () => {
      const serverMs = localReceive + 5_000;
      const header = new Date(serverMs).toUTCString();
      expect(computeClockOffsetMs(header, localReceive)).toBe(5_000);
    });

    it('is negative when server is behind local', () => {
      const serverMs = localReceive - 90_000;
      const header = new Date(serverMs).toUTCString();
      expect(computeClockOffsetMs(header, localReceive)).toBe(-90_000);
    });

    it('is undefined when header is invalid', () => {
      expect(computeClockOffsetMs(null, localReceive)).toBeUndefined();
    });
  });

  describe('serverNow', () => {
    it('applies offset to local time', () => {
      const local = new Date('2026-03-01T12:00:00.000Z');
      expect(serverNow(local, -90_000).getTime()).toBe(local.getTime() - 90_000);
      expect(serverNow(local, 90_000).getTime()).toBe(local.getTime() + 90_000);
    });
  });
});
