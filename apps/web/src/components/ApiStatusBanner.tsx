type Props = {
  baseUrl: string;
  onRetry: () => void;
  busy?: boolean;
};

export function ApiStatusBanner({ baseUrl, onRetry, busy }: Props) {
  return (
    <div className="status-banner status-banner--error" data-testid="api-status" role="alert">
      <p className="status-banner__title">API not connected</p>
      <p className="hint">
        Base URL: <span className="mono">{baseUrl}</span>
      </p>
      <p className="hint">Start it with `npm run api` (default http://127.0.0.1:8787)</p>
      <button
        type="button"
        className="btn btn-primary"
        data-testid="btn-retry-connection"
        disabled={busy}
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}
