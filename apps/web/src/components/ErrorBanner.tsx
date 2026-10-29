import type { DescribedError } from '../data/describeError';

type Props = {
  error: DescribedError;
  onRetry?: () => void;
  onDismiss: () => void;
};

export function ErrorBanner({ error, onRetry, onDismiss }: Props) {
  const isInfo = error.kind === 'already_processed';
  return (
    <div
      className={`error-banner${isInfo ? ' error-banner--info' : ''}`}
      data-testid="error-banner"
      role={isInfo ? 'status' : 'alert'}
    >
      <p className="error-banner__title">{error.title}</p>
      {isInfo ? (
        <p className="error-banner__message">{error.message}</p>
      ) : (
        <p className="error">
          {error.code}
          {error.message ? `: ${error.message}` : ''}
        </p>
      )}
      {error.hint && <p className="hint error-banner__hint">{error.hint}</p>}
      <div className="error-banner__actions">
        {error.retryable && onRetry && (
          <button type="button" className="btn btn-primary" data-testid="btn-retry" onClick={onRetry}>
            Retry
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
