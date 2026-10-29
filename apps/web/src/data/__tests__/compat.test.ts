import { ReasonCode } from '@agent-pay/core/policy.ts';
import { PaymentError } from '@agent-pay/core/orchestrator.ts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../apiError';
import {
  failureInfo,
  isAlreadyProcessed,
  isSubmitting,
  isSubmittingResult,
  needsManualResolve,
  normalizeTotals,
  reasonInfo,
} from '../compat';

describe('compat', () => {
  describe('isSubmitting', () => {
    it('reads paymentStatus and legacy status/state fields', () => {
      expect(isSubmitting({ paymentStatus: 'submitting' })).toBe(true);
      expect(isSubmitting({ status: 'submitting' })).toBe(true);
      expect(isSubmitting({ state: 'submitting' })).toBe(true);
      expect(isSubmitting({ paymentStatus: 'paid' })).toBe(false);
      expect(isSubmitting(null)).toBe(false);
      expect(isSubmitting('garbage')).toBe(false);
    });
  });

  describe('isSubmittingResult', () => {
    it('reads result.status submitting', () => {
      expect(isSubmittingResult({ status: 'submitting', intentId: 'x', decision: {} })).toBe(true);
      expect(isSubmittingResult({ status: 'paid', intentId: 'x', decision: {} })).toBe(false);
    });
  });

  describe('needsManualResolve', () => {
    it('accepts meta string/boolean and top-level flags when pending', () => {
      expect(
        needsManualResolve({
          receipt: { status: 'pending', meta: { needsManualResolve: 'true' } },
        }),
      ).toBe(true);
      expect(
        needsManualResolve({
          receipt: { status: 'pending', meta: { needsManualResolve: true } },
        }),
      ).toBe(true);
      expect(needsManualResolve({ needsManualResolve: 'true', receipt: { status: 'pending' } })).toBe(true);
    });

    it('false for terminal receipt or resolution', () => {
      expect(
        needsManualResolve({
          receipt: { status: 'succeeded', meta: { needsManualResolve: 'true' } },
        }),
      ).toBe(false);
      expect(needsManualResolve({ resolution: { status: 'succeeded' }, receipt: { status: 'pending' } })).toBe(
        false,
      );
    });

    it('missing receipt with paid/submitting paymentStatus', () => {
      expect(needsManualResolve({ needsManualResolve: true, paymentStatus: 'paid' })).toBe(true);
      expect(needsManualResolve({ needsManualResolve: true, paymentStatus: 'submitting' })).toBe(true);
      expect(needsManualResolve({ needsManualResolve: true, paymentStatus: 'failed' })).toBe(false);
    });

    it('ignores garbage safely', () => {
      expect(needsManualResolve(undefined)).toBe(false);
      expect(needsManualResolve([])).toBe(false);
    });
  });

  describe('isAlreadyProcessed', () => {
    it('recognizes ApiError and PaymentError race codes', () => {
      expect(isAlreadyProcessed(new ApiError(409, 'not_pending: x'))).toBe(true);
      expect(isAlreadyProcessed(new ApiError(409, 'already_paid: x'))).toBe(true);
      expect(isAlreadyProcessed(new PaymentError('not_pending', 'x'))).toBe(true);
      expect(isAlreadyProcessed(new ApiError(409, 'intent_conflict: x'))).toBe(false);
    });

    it('approve/reject treats unknown 409 as race except intent_conflict', () => {
      expect(isAlreadyProcessed(new ApiError(409, 'in_progress: x'), { action: 'approve' })).toBe(true);
      expect(isAlreadyProcessed(new ApiError(409, 'intent_conflict: x'), { action: 'approve' })).toBe(false);
      expect(isAlreadyProcessed(new ApiError(409, 'receipt_not_pending: x'), { action: 'reject' })).toBe(true);
    });
  });

  describe('reasonInfo', () => {
    it('labels known ReasonCode values and invalid_policy', () => {
      const within = reasonInfo(`${ReasonCode.WithinPolicy}: ok`);
      expect(within.code).toBe(ReasonCode.WithinPolicy);
      expect(within.label).toBe('Within policy');
      expect(within.detail).toBe('ok');

      const invalid = reasonInfo('invalid_policy: policy.perTxMax is not a finite number');
      expect(invalid.label).toBe('Invalid policy');
      expect(invalid.explanation).toMatch(/malformed/);

      const unknown = reasonInfo('some_new_code: detail');
      expect(unknown.label).toBe('Some New Code');
    });
  });

  describe('failureInfo', () => {
    it('maps FailureCode prefixes to labels and explanations', () => {
      const timeout = failureInfo('adapter_timeout: pay timed out after 1500ms');
      expect(timeout.label).toBe('Rail timeout');
      expect(timeout.explanation).toMatch(/did not answer/i);

      const err = failureInfo('adapter_error: mock rail unreachable');
      expect(err.label).toBe('Rail error');

      const mismatch = failureInfo('receipt_mismatch: intentId wrong');
      expect(mismatch.label).toBe('Receipt mismatch');

      expect(failureInfo(undefined).label).toBe('Unknown outcome');
      expect(failureInfo('custom_code: detail').label).toBe('Custom Code');
    });
  });

  describe('normalizeTotals', () => {
    const opts = { agentId: 'agent-a', fallbackCurrency: 'USD' };

    it('per-currency nested totals', () => {
      const map = normalizeTotals(
        { day: '2026-01-01', totals: { 'agent-a': { usd: 10, EUR: 5 } } },
        opts,
      );
      expect(map).toEqual({ USD: 10, EUR: 5 });
    });

    it('legacy number per agent', () => {
      expect(normalizeTotals({ totals: { 'agent-a': 42 } }, opts)).toEqual({ USD: 42 });
    });

    it('totalsByCurrency field', () => {
      expect(
        normalizeTotals(
          { totals: {}, totalsByCurrency: { 'agent-a': { USD: 3, near: 1 } } },
          opts,
        ),
      ).toEqual({ USD: 3, NEAR: 1 });
    });

    it('flat currency map heuristic', () => {
      expect(normalizeTotals({ totals: { USD: 1, EUR: 2 } }, opts)).toEqual({ USD: 1, EUR: 2 });
    });

    it('ignores garbage and non-finite numbers', () => {
      expect(normalizeTotals(null, opts)).toEqual({});
      expect(normalizeTotals({ totals: { 'agent-a': { USD: NaN, EUR: 2 } } }, opts)).toEqual({ EUR: 2 });
    });
  });
});
