import { ApiError, apiErrorCode } from './apiError';
import { isAlreadyProcessed, type AlreadyProcessedOptions } from './compat';

export type DescribedErrorKind =
  | 'network'
  | 'client'
  | 'server'
  | 'rail_mismatch'
  | 'already_processed'
  | 'unknown';

export type DescribeErrorContext = AlreadyProcessedOptions;

export type DescribedError = {
  kind: DescribedErrorKind;
  status: number;
  code: string;
  title: string;
  message: string;
  hint: string;
  retryable: boolean;
};

function splitMessage(message: string): { code: string; detail: string } {
  const i = message.indexOf(':');
  if (i === -1) return { code: message, detail: '' };
  return { code: message.slice(0, i).trim(), detail: message.slice(i + 1).trim() };
}

export function describeError(err: unknown, context: DescribeErrorContext = {}): DescribedError {
  if (isAlreadyProcessed(err, context)) {
    return {
      kind: 'already_processed',
      status: err instanceof ApiError ? err.status : 409,
      code: apiErrorCode(err) ?? 'not_pending',
      title: 'Already processed',
      message:
        'This intent was already approved or rejected by someone else. Showing the latest state.',
      hint: '',
      retryable: false,
    };
  }

  if (err instanceof ApiError) {
    const { code, detail } = splitMessage(err.message);
    if (code === 'rail_mismatch' || err.message.includes('rail_mismatch')) {
      return {
        kind: 'rail_mismatch',
        status: err.status,
        code: code || 'rail_mismatch',
        title: 'Rail mismatch',
        message: detail || err.message,
        hint: 'Restart the API with the expected RAIL or remove ?rail= from the URL.',
        retryable: false,
      };
    }
    if (err.status === 0 || code === 'network_error') {
      return {
        kind: 'network',
        status: 0,
        code: code || 'network_error',
        title: 'API unreachable',
        message: detail || err.message,
        hint: 'Start it with `npm run api` (default http://127.0.0.1:8787).',
        retryable: true,
      };
    }
    if (err.status >= 500) {
      return {
        kind: 'server',
        status: err.status,
        code: code || `http_${err.status}`,
        title: `Server error (${err.status})`,
        message: detail || err.message,
        hint: 'The API failed — retry or check server logs.',
        retryable: true,
      };
    }
    if (err.status >= 400) {
      return {
        kind: 'client',
        status: err.status,
        code: code || `http_${err.status}`,
        title: `Request rejected (${err.status})`,
        message: detail || err.message,
        hint: 'Fix the request or choose a different action.',
        retryable: false,
      };
    }
  }

  const code = apiErrorCode(err);
  if (code === 'rail_mismatch') {
    return {
      kind: 'rail_mismatch',
      status: 0,
      code,
      title: 'Rail mismatch',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Restart the API with the expected RAIL or remove ?rail= from the URL.',
      retryable: false,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: 'unknown',
    status: 0,
    code: code ?? 'unknown',
    title: 'Something went wrong',
    message,
    hint: 'Try again or reset the demo.',
    retryable: false,
  };
}
