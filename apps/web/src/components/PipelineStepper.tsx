import type { RefObject } from 'react';
import type { PipelineStepView } from '../data/intentFlow';
import { stepperStateText } from '../data/intentFlow';

type Props = {
  steps: PipelineStepView[];
  stepperRef: RefObject<HTMLOListElement | null>;
  mobileLabel: string;
};

function iconFor(step: PipelineStepView, index: number): string {
  switch (step.state) {
    case 'done':
      return '✓';
    case 'skipped':
      return '–';
    case 'error':
      return '✕';
    case 'pending':
      return '…';
    case 'current':
      return String(index + 1);
    default:
      return String(index + 1);
  }
}

export function PipelineStepper({ steps, stepperRef, mobileLabel }: Props) {
  return (
    <>
      <p className="stepper-mobile-label" aria-live="polite">
        {mobileLabel}
      </p>
      <ol className="stepper" aria-label="Pipeline steps" ref={stepperRef}>
        {steps.map((s, i) => {
          const classes = [
            'stepper__step',
            s.state === 'done' || s.state === 'current' || s.state === 'pending'
              ? ' is-active'
              : '',
            s.state === 'current' ? ' is-current' : '',
            s.state === 'done' ? ' is-done' : '',
            s.state === 'skipped' ? ' is-skipped' : '',
            s.state === 'error' ? ' is-error' : '',
            s.state === 'pending' ? ' is-pending' : '',
          ].join('');
          return (
            <li
              key={s.step}
              className={classes}
              aria-current={s.state === 'current' ? 'step' : undefined}
            >
              <span className="stepper__dot" aria-hidden>
                {iconFor(s, i)}
              </span>
              <span className="sr-only">{stepperStateText(s.state)}</span>
              <span className="stepper__label">{s.label}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}
