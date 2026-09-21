import type { RemeetModerationApi } from "@tomokichi/admin-contracts";
/**
 * Everything Admin Core is given.
 *
 * Only this Worker has `DB` and `PRIVATE_FILES`. Admin Web deliberately has
 * neither: if the internet-facing Worker cannot reach the database, a bug in a
 * route handler cannot reach it either.
 */
export interface AdminCoreEnv {
  DB: D1Database;
  REMEET_MODERATION?: RemeetModerationApi;
  PRIVATE_FILES: R2Bucket;

  SUPPORT_EMAIL: string;
  SUPPORT_FROM_NAME: string;
  NOREPLY_EMAIL: string;
  REPORT_EMAIL: string;
  DEFAULT_SUPPORT_URL: string;

  /** Resend, or whatever provider replaces it. Absent means replies are
   * disabled and everything else still works. */
  MAIL_API_KEY?: string;

  /** `https://admin.tmkch.io`. Where a notification's link points. */
  ADMIN_ORIGIN: string;
  /**
   * The operator's own address, for the "a ticket arrived" mail. A Secret,
   * like `SUPPORT_FORWARD_EMAIL` on the mail Worker. Unset means no mail
   * channel; the ticket still exists and push still goes.
   */
  NOTIFICATION_EMAIL?: string;
  /**
   * VAPID, for Web Push. The public key is what browsers subscribe with and
   * is not secret; the private key is. Both base64url, generated with
   * `pnpm --filter @tomokichi/admin-core run vapid:generate`. Unset means push
   * is unavailable and the settings screen says so.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** `mailto:` contact the push services may use. */
  VAPID_SUBJECT?: string;
  /**
   * Keyed hash for pseudonymising the reporting apps' user ids. A plain SHA-256
   * of a UUID is reversible by anybody holding the same UUID list, which the
   * app backend does — the pepper is what makes the stored value useless
   * outside this database.
   */
  HASH_PEPPER?: string;
}
