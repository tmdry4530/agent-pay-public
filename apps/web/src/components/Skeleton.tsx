import type { ButtonHTMLAttributes } from 'react';

type SkeletonProps = {
  testId: string;
  label: string;
};

export function GaugeSkeleton({ testId }: SkeletonProps) {
  return (
    <div className="skeleton-block" data-testid={testId} aria-busy="true" aria-label="Loading gauge">
      <div className="skeleton skeleton--line skeleton--wide" />
      <div className="skeleton skeleton--gauge" />
      <div className="skeleton skeleton--line" />
    </div>
  );
}

export function LedgerSkeleton({ testId }: SkeletonProps) {
  return (
    <div className="skeleton-block" data-testid={testId} aria-busy="true" aria-label="Loading ledger">
      <div className="skeleton skeleton--line skeleton--wide" />
      <div className="skeleton skeleton--line" />
      <div className="skeleton skeleton--line skeleton--short" />
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
};

export function ActionButton({ busy, children, className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn ${className}`.trim()}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className="btn-spinner" aria-hidden />}
      {children}
    </button>
  );
}
