import type { AdminErrorBody, Result } from "@tomokichi/admin-contracts";
import { statusForErrorCode } from "@tomokichi/admin-contracts";
import type { Context } from "hono";

/**
 * One response shape for the whole admin API.
 *
 * Success and failure both carry a `requestId`, and the same id is on the
 * structured log line — so "it said something went wrong at 14:32" is enough to
 * find the actual error, which never leaves the server.
 */
export interface ApiFailure {
  ok: false;
  error: AdminErrorBody;
  requestId: string;
}

export function requestId(c: Context): string {
  // Cloudflare's own ray id where there is one; it also appears in Workers
  // Logs, which makes correlating free.
  return c.req.header("Cf-Ray") ?? crypto.randomUUID();
}

/** Unwraps a `Result` from Admin Core into an HTTP response. */
export function respond<T>(c: Context, result: Result<T>): Response {
  const id = requestId(c);
  if (result.ok) {
    return c.json({ ok: true, data: result.value, requestId: id }, 200);
  }
  logFailure(c, id, result.error);
  return c.json(
    { ok: false, error: result.error, requestId: id },
    statusForErrorCode[result.error.code] as 400,
  );
}

export function failure(c: Context, error: AdminErrorBody, status: number): Response {
  const id = requestId(c);
  logFailure(c, id, error);
  return c.json({ ok: false, error, requestId: id }, status as 400);
}

/**
 * What a log line is allowed to say.
 *
 * A code, a route and an id. Never the message body — a `VALIDATION_ERROR`'s
 * `fields` can quote what somebody typed, and a support message is somebody's
 * private writing.
 */
function logFailure(c: Context, id: string, error: AdminErrorBody): void {
  console.log(
    JSON.stringify({
      worker: "tomokichi-admin-web",
      requestId: id,
      route: new URL(c.req.url).pathname,
      method: c.req.method,
      errorCode: error.code,
    }),
  );
}
