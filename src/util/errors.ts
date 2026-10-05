export type AppiiErrorCode = 'BAD_INPUT' | 'NOT_FOUND' | 'BROWSER' | 'CAPTURE' | 'BUILD' | 'EXPORT' | 'IO' | 'UNSUPPORTED' | 'INTERNAL';

export class AppiiError extends Error {
  readonly code: AppiiErrorCode;
  readonly details?: unknown;

  constructor(code: AppiiErrorCode, message: string, opts: { details?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppiiError';
    this.code = code;
    if (opts.details !== undefined) this.details = opts.details;
  }
}

export function isAppiiError(err: unknown): err is AppiiError {
  return err instanceof AppiiError;
}
