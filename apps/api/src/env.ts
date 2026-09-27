/**
 * Everything the platform API Worker is given.
 *
 * Only this Worker has `DB` and `PRIVATE_FILES`. The API gateway deliberately has
 * neither: if the internet-facing Worker cannot reach the database, a bug in a
 * route handler cannot reach it either.
 */
export interface AdminCoreEnv {
  DB: D1Database;
  /**
   * Projects that act on reports through a moderation adapter: project slug →
   * the name of the Service Binding implementing it. The binding itself is
   * declared in `services` under that name. See `domain/moderation.ts`.
   */
  SIGNED_MODERATION?: Record<string, string>;
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
   * Legacy operator-client origin. Used only as a fallback when
   * `OPERATOR_TICKET_URL_TEMPLATE` is not configured.
   */
  ADMIN_ORIGIN: string;
  /**
   * Absolute URL template owned by the deployment's operator client. The
   * literal `{ticketNumber}` is replaced with the encoded Ticket number.
   */
  OPERATOR_TICKET_URL_TEMPLATE?: string;
  /**
   * The operator's own address, for the "a ticket arrived" mail. A Secret,
   * like `SUPPORT_FORWARD_EMAIL` on the mail Worker. Unset means no mail
   * channel; the ticket still exists and push still goes.
   */
  NOTIFICATION_EMAIL?: string;
  /**
   * VAPID, for Web Push. The public key is what browsers subscribe with and
   * is not secret; the private key is. Both base64url, generated with
   * `pnpm --filter @inquiry-platform/api run vapid:generate`. Unset means push
   * is unavailable and the API reports that channel as unavailable.
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
  /**
   * What this deployment calls itself — console name, fallback signature,
   * mail logo. A JSON object in `vars`, read by `parseBranding`, which falls
   * back to neutral defaults. See `packages/core/src/branding.ts`.
   */
  BRANDING?: unknown;
}
