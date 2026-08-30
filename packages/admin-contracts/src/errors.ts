/**
 * The one error vocabulary every layer here speaks.
 *
 * Service bindings do not carry a JavaScript exception across intact — a thrown
 * class arrives at the caller as a bare `Error` with a message and nothing
 * else. So Admin Core does not throw across the boundary at all: every RPC
 * method returns a {@link Result}, and a failure is data with a code the caller
 * can branch on. The HTTP layer in Admin Web is the only place that turns a
 * code back into a status.
 */
export const adminErrorCodes = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_STATUS_TRANSITION",
  "STORAGE_ERROR",
  "MAIL_ERROR",
  "INTERNAL_ERROR",
] as const;

export type AdminErrorCode = (typeof adminErrorCodes)[number];

export interface AdminErrorBody {
  code: AdminErrorCode;
  /** Safe to show a person. Never a stack trace, never SQL, never a raw driver
   * message — see `toFailure` in Admin Core. */
  message: string;
  /** Field-level detail for `VALIDATION_ERROR`, keyed by path. */
  fields?: Record<string, string>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AdminErrorBody };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(
  code: AdminErrorCode,
  message: string,
  fields?: Record<string, string>,
): Result<T> {
  return { ok: false, error: fields ? { code, message, fields } : { code, message } };
}

/** HTTP status for a code. Kept here so Admin Web and any future caller agree. */
export const statusForErrorCode: Record<AdminErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATUS_TRANSITION: 400,
  STORAGE_ERROR: 502,
  MAIL_ERROR: 502,
  INTERNAL_ERROR: 500,
};
