import { useEffect, useState } from 'react';
import { formatPendingElapsed, PENDING_SLOW_MS } from '../data/intentFlow';

type Props = {
  sinceIso: string;
};

export function PendingTimer({ sinceIso }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsedMs = now - new Date(sinceIso).getTime();
  const showSlow = elapsedMs >= PENDING_SLOW_MS;

  return (
    <>
      <p className="pending-elapsed" data-testid="pending-elapsed" aria-live="off">
        {formatPendingElapsed(sinceIso, now)}
      </p>
      {showSlow && (
        <p className="hint pending-slow-hint" data-testid="pending-slow-hint">
          Taking longer than usual. Use Refresh status to re-check the rail; an operator can settle
          it with POST /intents/:id/resolve.
        </p>
      )}
    </>
  );
}

export { PENDING_SLOW_MS };
