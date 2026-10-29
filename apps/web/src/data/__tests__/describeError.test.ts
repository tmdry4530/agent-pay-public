import { describe, expect, it } from 'vitest';
import { ApiError } from '../apiError';
import { isAlreadyProcessed, RACE_409_CODES } from '../compat';
import { describeError } from '../describeError';

describe('describeError', () => {
  it('classifies network errors', () => {
    const d = describeError(new ApiError(0, 'network_error: cannot reach API'));
    expect(d.kind).toBe('network');
    expect(d.retryable).toBe(true);
    expect(d.title).toMatch(/unreachable/i);
  });

  it('classifies non-race 409 as conflict', () => {
    const d = describeError(new ApiError(409, 'receipt_not_pending: not pending'));
    expect(d.kind).toBe('conflict');
    expect(d.code).toBe('receipt_not_pending');
    expect(d.retryable).toBe(false);
    expect(d.title).toBe('Conflict');
    expect(d.message).toBe('not pending');
  });

  it('classifies 5xx as retryable', () => {
    const d = describeError(new ApiError(500, 'internal: boom'));
    expect(d.kind).toBe('server');
    expect(d.retryable).toBe(true);
    expect(d.title).toMatch(/500/);
  });

  it('classifies already processed on approve race', () => {
    const d = describeError(new ApiError(409, 'not_pending: gone'), { action: 'approve' });
    expect(d.kind).toBe('already_processed');
    expect(d.title).toBe('Already processed');
    expect(d.retryable).toBe(false);
  });

  it('classifies rail_mismatch', () => {
    const d = describeError(new ApiError(409, 'rail_mismatch: wrong rail'));
    expect(d.kind).toBe('rail_mismatch');
    expect(d.retryable).toBe(false);
  });

  describe('409 conflict (non-race)', () => {
    it('in_progress on approve without race context is conflict with specific title only via race path', () => {
      const race = describeError(new ApiError(409, 'in_progress: paying', { code: 'in_progress', detail: 'paying' }), {
        action: 'approve',
      });
      expect(race.kind).toBe('already_processed');
      expect(race.title).toBe('Payment in progress');
    });

    it('precondition_failed with {code, detail} => conflict with server message verbatim', () => {
      const d = describeError(
        new ApiError(409, 'precondition_failed: ignored', {
          code: 'precondition_failed',
          detail: 'policy changed since quote',
        }),
      );
      expect(d.kind).toBe('conflict');
      expect(d.title).toBe('Conflict');
      expect(d.message).toBe('policy changed since quote');
      expect(d.hint).toBe('Showing the latest ledger state.');
      expect(d.code).toBe('precondition_failed');
    });

    it('duplicate_intent legacy message => conflict with detail after colon', () => {
      const d = describeError(new ApiError(409, 'duplicate_intent: intent x exists'));
      expect(d.kind).toBe('conflict');
      expect(d.message).toBe('intent x exists');
    });

    it('unknown code with empty message => fallback text', () => {
      const d = describeError(new ApiError(409, 'weird_new_code:', { code: 'weird_new_code', detail: '' }));
      expect(d.kind).toBe('conflict');
      expect(d.message).toBe('The server reported a conflict with the current state. Showing the latest ledger.');
    });

    it('bare code with no message (legacy {error:"duplicate_intent"}) => fallback, code kept', () => {
      const d = describeError(new ApiError(409, 'duplicate_intent'));
      expect(d.kind).toBe('conflict');
      expect(d.code).toBe('duplicate_intent');
      expect(d.message).toBe('The server reported a conflict with the current state. Showing the latest ledger.');
    });

    it('409 on approve with unknown code is NOT already_processed', () => {
      const err = new ApiError(409, 'precondition_failed: stale', { code: 'precondition_failed', detail: 'stale' });
      expect(isAlreadyProcessed(err, { action: 'approve' })).toBe(false);
      const d = describeError(err, { action: 'approve' });
      expect(d.kind).toBe('conflict');
    });

    it('returns HTML in message verbatim', () => {
      const d = describeError(
        new ApiError(409, 'precondition_failed: x', {
          code: 'precondition_failed',
          detail: '<b>x</b>',
        }),
      );
      expect(d.message).toBe('<b>x</b>');
    });
  });

  describe('already_processed race409 codes', () => {
    it.each(RACE_409_CODES)('legacy shape %s', (code) => {
      const d = describeError(new ApiError(409, `${code}: server detail`), { action: 'approve' });
      expect(d.kind).toBe('already_processed');
      expect(d.code).toBe(code);
      expect(d.retryable).toBe(false);
      if (code === 'not_pending') {
        expect(d.message).toBe(
          'This intent was already approved or rejected by someone else. Showing the latest state.',
        );
      }
    });

    it.each(RACE_409_CODES)('new ApiError shape %s', (code) => {
      const detail = 'detail text';
      const d = describeError(new ApiError(409, `${code}: ${detail}`, { code, detail }), { action: 'reject' });
      expect(d.kind).toBe('already_processed');
      expect(d.code).toBe(code);
      expect(d.retryable).toBe(false);
    });
  });
});
