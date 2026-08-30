/**
 * Everything Admin Core is given.
 *
 * Only this Worker has `DB` and `PRIVATE_FILES`. Admin Web deliberately has
 * neither: if the internet-facing Worker cannot reach the database, a bug in a
 * route handler cannot reach it either.
 */
export interface AdminCoreEnv {
  DB: D1Database;
  PRIVATE_FILES: R2Bucket;

  SUPPORT_EMAIL: string;
  SUPPORT_FROM_NAME: string;
  NOREPLY_EMAIL: string;
  REPORT_EMAIL: string;
  DEFAULT_SUPPORT_URL: string;

  /** Resend, or whatever provider replaces it. Absent means replies are
   * disabled and everything else still works. */
  MAIL_API_KEY?: string;
  /**
   * Keyed hash for pseudonymising the reporting apps' user ids. A plain SHA-256
   * of a UUID is reversible by anybody holding the same UUID list, which the
   * app backend does — the pepper is what makes the stored value useless
   * outside this database.
   */
  HASH_PEPPER?: string;
}
