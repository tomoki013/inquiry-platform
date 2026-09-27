import type { AdminCoreStub } from "@inquiry-platform/core";

export interface AdminWebEnv {
  /** The only binding this Worker has. See `wrangler.jsonc`. */
  ADMIN_CORE: AdminCoreStub;

  /** e.g. `example.cloudflareaccess.com`. Empty means Access is not wired up
   * yet, which in production means every request is refused. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access Application's AUD tag. Not a secret — it is a claim in every
   * token this Worker verifies — so it lives in `vars`, not in Secrets. */
  ACCESS_AUD: string;
  /** Allowed Origin for cookie-authenticated browser clients. */
  ADMIN_ORIGIN: string;
  ENVIRONMENT: string;

  /**
   * The role of anybody Access lets in and `ADMIN_ROLES` does not name.
   * `viewer`, `operator` or `admin`; anything else, or unset, is `viewer`,
   * so a typo narrows access rather than widening it.
   */
  DEFAULT_ADMIN_ROLE?: string;
  /** Per-person roles, keyed by the Access subject id (never an address):
   * `{ "<sub>": "operator" }`. A JSON object in `vars`. */
  ADMIN_ROLES?: Record<string, string>;

  /** Local development only, and only honoured when `ENVIRONMENT` is `local`.
   * There is no code path that lets this stand in for Access in production. */
  DEV_ADMIN_EMAIL?: string;
}
