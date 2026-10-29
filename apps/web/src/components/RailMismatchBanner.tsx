type Props = {
  message: string;
  onRecheck: () => void;
  busy?: boolean;
};

export function RailMismatchBanner({ message, onRecheck, busy }: Props) {
  return (
    <div className="status-banner status-banner--warn" data-testid="rail-mismatch" role="alert">
      <p className="status-banner__title">Rail mismatch</p>
      <p className="hint mono wrap-anywhere">{message}</p>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={onRecheck}>
        Re-check
      </button>
    </div>
  );
}
