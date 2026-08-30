import { type AdminErrorCode, fail, type Result } from "@tomokichi/admin-contracts";
import type { ZodError } from "zod";

/**
 * The one place an internal error becomes something a person may read.
 *
 * A D1 driver message can quote the statement, and a statement can quote a
 * customer's subject line. So nothing from a caught exception reaches the
 * caller: the code goes out, the detail goes to the structured log with a
 * request id, and the two are matched up by hand when somebody investigates.
 */
export function internalFailure<T = never>(scope: string, error: unknown): Result<T> {
  console.error(
    JSON.stringify({
      event: "admin_core.error",
      scope,
      // A name and nothing else. `error.message` from D1 can contain SQL, and
      // SQL here can contain a person's writing.
      error: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  return fail("INTERNAL_ERROR", "処理中に問題が発生しました。");
}

/** Zod's issues, flattened into the `fields` map the UI renders next to inputs. */
export function validationFailure<T = never>(error: ZodError): Result<T> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_";
    if (!fields[path]) fields[path] = issue.message;
  }
  return fail("VALIDATION_ERROR", "入力内容を確認してください。", fields);
}

export function notFound<T = never>(what: string): Result<T> {
  return fail("NOT_FOUND", `${what}が見つかりませんでした。`);
}

export const failureCodes: readonly AdminErrorCode[] = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_STATUS_TRANSITION",
];
