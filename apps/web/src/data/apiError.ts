export type ApiErrorOptions = {
  code?: string;
  detail?: string;
};

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;

  constructor(status: number, message: string, opts?: ApiErrorOptions) {
    super(message);
    this.status = status;
    if (opts?.code !== undefined) this.code = opts.code;
    if (opts?.detail !== undefined) this.detail = opts.detail;
  }
}

/** Returns the error code segment before the first `:` in an ApiError message. */
export function apiErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  if (err.code !== undefined && err.code.length > 0) return err.code;
  const i = err.message.indexOf(':');
  if (i === -1) return err.message;
  return err.message.slice(0, i);
}
