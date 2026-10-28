export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Returns the error code segment before the first `:` in an ApiError message. */
export function apiErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const i = err.message.indexOf(':');
  if (i === -1) return err.message;
  return err.message.slice(0, i);
}
