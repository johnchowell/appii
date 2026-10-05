export type AppiiErrorCode =
  | 'BAD_INPUT'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'FORM_NOT_FOUND'
  | 'FORM_INVALID'
  | 'FORM_REJECTED'
  | 'UPSTREAM'
  | 'UPSTREAM_STATUS'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'TOO_MANY_REDIRECTS'
  | 'ORIGIN_NOT_ALLOWED'
  | 'DEFINITION_INVALID'
  | 'EXTRACT_FAILED'
  | 'LOGIN_FAILED'
  | 'BROWSER'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED'
  | 'INTERNAL';

const DEFAULT_STATUS: Record<AppiiErrorCode, number> = {
  BAD_INPUT: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  FORM_NOT_FOUND: 404,
  FORM_INVALID: 422,
  FORM_REJECTED: 422,
  UPSTREAM: 502,
  UPSTREAM_STATUS: 502,
  NETWORK: 502,
  TIMEOUT: 504,
  TOO_MANY_REDIRECTS: 502,
  ORIGIN_NOT_ALLOWED: 403,
  DEFINITION_INVALID: 400,
  EXTRACT_FAILED: 502,
  LOGIN_FAILED: 502,
  BROWSER: 500,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED: 415,
  INTERNAL: 500,
};

export class AppiiError extends Error {
  readonly code: AppiiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppiiErrorCode, message: string, opts: { status?: number; details?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppiiError';
    this.code = code;
    this.status = opts.status ?? DEFAULT_STATUS[code];
    if (opts.details !== undefined) this.details = opts.details;
  }

  toJSON(): { error: AppiiErrorCode; message: string; details?: unknown } {
    return this.details === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, details: this.details };
  }
}

export function isAppiiError(err: unknown): err is AppiiError {
  return err instanceof AppiiError;
}

export function toAppiiError(err: unknown): AppiiError {
  if (err instanceof AppiiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppiiError('INTERNAL', message, { cause: err });
}
