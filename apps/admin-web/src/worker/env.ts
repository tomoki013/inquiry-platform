import type { AdminCoreStub } from "@tomokichi/admin-contracts";

export interface AdminWebEnv {
  /** The only binding this Worker has. See `wrangler.jsonc`. */
  ADMIN_CORE: AdminCoreStub;
  ASSETS: Fetcher;

  /** e.g. `tomokichi.cloudflareaccess.com`. Empty means Access is not wired up
   * yet, which in production means every request is refused. */
  ACCESS_TEAM_DOMAIN: string;
  /** The Access Application's AUD tag. Not a secret — it is a claim in every
   * token this Worker verifies — so it lives in `vars`, not in Secrets. */
  ACCESS_AUD: string;
  ADMIN_ORIGIN: string;
  ENVIRONMENT: string;

  /** Local development only, and only honoured when `ENVIRONMENT` is `local`.
   * There is no code path that lets this stand in for Access in production. */
  DEV_ADMIN_EMAIL?: string;
}
