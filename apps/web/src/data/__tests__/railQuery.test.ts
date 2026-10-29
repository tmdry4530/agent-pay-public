import { describe, expect, it } from 'vitest';
import { detectRailMismatch, expectedRailFromSearch } from '../railQuery';

describe('detectRailMismatch', () => {
  it('never mismatches when ?rail is absent, whatever the server or receipt rail', () => {
    expect(expectedRailFromSearch('')).toBeNull();
    for (const serverRail of ['mock', 'paypal', 'near', 'something-new']) {
      expect(
        detectRailMismatch({ clientKind: 'http', expected: null, serverRail, receiptRail: 'near' }),
      ).toBeNull();
    }
  });

  it('flags ?rail that differs from the server rail', () => {
    expect(
      detectRailMismatch({ clientKind: 'http', expected: 'paypal', serverRail: 'mock' }),
    ).toEqual({ expected: 'paypal', server: 'mock' });
  });

  it('flags a receipt on another rail only when ?rail is set', () => {
    expect(
      detectRailMismatch({ clientKind: 'http', expected: 'near', serverRail: 'near', receiptRail: 'mock' }),
    ).toEqual({ expected: 'near', server: 'mock' });
  });

  it('matching rails and mock clients never mismatch', () => {
    expect(detectRailMismatch({ clientKind: 'http', expected: 'near', serverRail: 'near' })).toBeNull();
    expect(detectRailMismatch({ clientKind: 'mock', expected: 'near', serverRail: 'mock' })).toBeNull();
  });

  it('ignores unknown ?rail values (treated as absent)', () => {
    expect(expectedRailFromSearch('?rail=bogus')).toBeNull();
  });
});
