import { describe, expect, it } from 'vitest';
import { ApiError } from '../apiError';
import { describeError } from '../describeError';

describe('describeError', () => {
  it('classifies network errors', () => {
    const d = describeError(new ApiError(0, 'network_error: cannot reach API'));
    expect(d.kind).toBe('network');
    expect(d.retryable).toBe(true);
    expect(d.title).toMatch(/unreachable/i);
  });

  it('classifies 4xx client errors', () => {
    const d = describeError(new ApiError(409, 'receipt_not_pending: not pending'));
    expect(d.kind).toBe('client');
    expect(d.code).toBe('receipt_not_pending');
    expect(d.retryable).toBe(false);
  });

  it('classifies 5xx as retryable', () => {
    const d = describeError(new ApiError(500, 'internal: boom'));
    expect(d.kind).toBe('server');
    expect(d.retryable).toBe(true);
    expect(d.title).toMatch(/500/);
  });

  it('classifies rail_mismatch', () => {
    const d = describeError(new ApiError(409, 'rail_mismatch: wrong rail'));
    expect(d.kind).toBe('rail_mismatch');
    expect(d.retryable).toBe(false);
  });
});
