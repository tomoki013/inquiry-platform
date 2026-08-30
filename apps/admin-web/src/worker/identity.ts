import type { ActorRef, AdminIdentity } from "@tomokichi/admin-contracts";
import { verifyAccessJwt } from "./access";
import type { AdminWebEnv } from "./env";

/**
 * The line between "who Cloudflare says you are" and "who this application
 * thinks you are".
 *
 * Everything below this file sees an {@link AdminIdentity} and has never heard
 * of a JWT, an Access team domain or an identity provider. Moving to Google
 * Workspace changes the Access application's IdP and nothing here; moving off
 * Access entirely changes this file and nothing below it.
 */
export async function resolveIdentity(
  request: Request,
  env: AdminWebEnv,
): Promise<AdminIdentity | null> {
  const verified = await verifyAccessJwt(request, env);
  if (verified.ok) {
    return {
      // The Access subject, not the address: a stable opaque id is what belongs
      // in an audit row that is kept forever.
      id: verified.claims.sub,
      email: verified.claims.email,
      // One role in Phase 1–3. Reaching Access at all means being a member of
      // the Cloudflare account, which the Access policy enforces; there is no
      // second check to make here yet, and hard-coding an address to decide it
      // is exactly what the design forbids.
      role: "owner",
    };
  }

  // The only bypass, and it needs two things to be true at once: the deployment
  // must say it is local, and a developer must have named themselves. Neither
  // is true of the production Worker.
  if (verified.reason === "not_configured" && env.ENVIRONMENT === "local" && env.DEV_ADMIN_EMAIL) {
    return { id: `local:${env.DEV_ADMIN_EMAIL}`, email: env.DEV_ADMIN_EMAIL, role: "owner" };
  }

  return null;
}

export function actorFor(identity: AdminIdentity): ActorRef {
  return { type: "admin", id: identity.id };
}
