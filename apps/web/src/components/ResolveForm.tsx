import { useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { LedgerEntry } from '@agent-pay/core';
import {
  STUCK_SUBMITTING_MS,
  describeResolveError,
  needsManualResolve,
  validateResolveRequest,
  type ResolveRequest,
} from '../data/compat';

type Props = {
  entry: LedgerEntry;
  onResolve: (req: ResolveRequest) => Promise<void>;
  stuck?: boolean;
  defaultResolvedBy?: string;
  headingRef?: RefObject<HTMLHeadingElement>;
};

type FieldKey = 'status' | 'note' | 'resolvedBy' | 'externalId';

const FIELD_ORDER: FieldKey[] = ['status', 'note', 'resolvedBy', 'externalId'];

export function ResolveForm({
  entry,
  onResolve,
  stuck = false,
  defaultResolvedBy = '',
  headingRef,
}: Props) {
  const headingId = useId();
  const statusRef = useRef<HTMLFieldSetElement>(null);
  const firstStatusRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const byRef = useRef<HTMLInputElement>(null);
  const extRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [resolvedBy, setResolvedBy] = useState(defaultResolvedBy);
  const [externalId, setExternalId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [submitError, setSubmitError] = useState<{ title: string; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const stuckSeconds = STUCK_SUBMITTING_MS / 1000;
  const explanation = stuck
    ? `This payment has been submitting for over ${stuckSeconds} s. Check the rail, then record the outcome.`
    : needsManualResolve(entry)
      ? 'The rail did not confirm this payment. Check the rail dashboard, then record what actually happened.'
      : 'Check the rail, then record what actually happened.';

  const focusField = (field: FieldKey) => {
    const map: Record<FieldKey, HTMLElement | null> = {
      status: firstStatusRef.current,
      note: noteRef.current,
      resolvedBy: byRef.current,
      externalId: extRef.current,
    };
    map[field]?.focus();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const validated = validateResolveRequest({
      status,
      note,
      resolvedBy,
      externalId: externalId.trim() === '' ? undefined : externalId,
    });
    if (!validated.ok) {
      setFieldErrors(validated.errors);
      const first = FIELD_ORDER.find((f) => validated.errors[f]);
      if (first) focusField(first);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await onResolve(validated.value);
    } catch (err) {
      setSubmitError(describeResolveError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const errorIds = (field: FieldKey) => {
    const err = fieldErrors[field];
    if (!err) return undefined;
    return `resolve-error-${field}-msg`;
  };

  return (
    <form
      className="resolve-form card-panel"
      data-testid="resolve-form"
      aria-labelledby={headingId}
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
    >
      <h3 ref={headingRef} id={headingId} className="resolve-form__heading" tabIndex={-1}>
        Resolve payment
      </h3>
      <p className="hint resolve-form__intro">{explanation}</p>

      {submitError && (
        <div className="resolve-form__error status-banner status-banner--error" role="alert" data-testid="resolve-error">
          <p className="status-banner__title">{submitError.title}</p>
          <p className="hint">{submitError.message}</p>
        </div>
      )}

      <fieldset
        ref={statusRef}
        className="resolve-field"
        data-testid="resolve-status"
        aria-describedby={errorIds('status')}
        aria-invalid={fieldErrors.status ? true : undefined}
      >
        <legend>Outcome</legend>
        <div className="resolve-radio-row">
          <label htmlFor="resolve-status-succeeded">
            <input
              ref={firstStatusRef}
              id="resolve-status-succeeded"
              type="radio"
              name="resolve-status"
              value="succeeded"
              data-testid="resolve-status-succeeded"
              checked={status === 'succeeded'}
              onChange={() => setStatus('succeeded')}
              disabled={submitting}
            />
            Succeeded
          </label>
          <label htmlFor="resolve-status-failed">
            <input
              id="resolve-status-failed"
              type="radio"
              name="resolve-status"
              value="failed"
              data-testid="resolve-status-failed"
              checked={status === 'failed'}
              onChange={() => setStatus('failed')}
              disabled={submitting}
            />
            Failed
          </label>
        </div>
        {fieldErrors.status && (
          <p id="resolve-error-status-msg" className="field-error" data-testid="resolve-error-status">
            {fieldErrors.status}
          </p>
        )}
      </fieldset>

      <div className="resolve-field">
        <label htmlFor="resolve-note-input">Note</label>
        <textarea
          ref={noteRef}
          id="resolve-note-input"
          data-testid="resolve-note"
          rows={3}
          placeholder="What did you see on the rail?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={submitting}
          aria-describedby={errorIds('note')}
          aria-invalid={fieldErrors.note ? true : undefined}
        />
        {fieldErrors.note && (
          <p id="resolve-error-note-msg" className="field-error" data-testid="resolve-error-note">
            {fieldErrors.note}
          </p>
        )}
      </div>

      <div className="resolve-field">
        <label htmlFor="resolve-by-input">Resolved by</label>
        <input
          ref={byRef}
          id="resolve-by-input"
          type="text"
          data-testid="resolve-by"
          autoComplete="off"
          value={resolvedBy}
          onChange={(e) => setResolvedBy(e.target.value)}
          disabled={submitting}
          aria-describedby={errorIds('resolvedBy')}
          aria-invalid={fieldErrors.resolvedBy ? true : undefined}
        />
        {fieldErrors.resolvedBy && (
          <p id="resolve-error-resolvedBy-msg" className="field-error" data-testid="resolve-error-resolvedBy">
            {fieldErrors.resolvedBy}
          </p>
        )}
      </div>

      <div className="resolve-field">
        <label htmlFor="resolve-external-id-input">External ID</label>
        <input
          ref={extRef}
          id="resolve-external-id-input"
          type="text"
          data-testid="resolve-external-id"
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          disabled={submitting}
          aria-describedby={errorIds('externalId')}
          aria-invalid={fieldErrors.externalId ? true : undefined}
        />
        <p className="hint resolve-field__hint">Leave blank to keep the current ID</p>
        {fieldErrors.externalId && (
          <p id="resolve-error-externalId-msg" className="field-error" data-testid="resolve-error-externalId">
            {fieldErrors.externalId}
          </p>
        )}
      </div>

      <button type="submit" className="btn btn-primary" data-testid="btn-resolve-submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Record outcome'}
      </button>
    </form>
  );
}
