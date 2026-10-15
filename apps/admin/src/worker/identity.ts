import type { ActorRef, AdminIdentity, AdminRole } from "@inquiry-platform/core";
import { isAdminRole } from "@inquiry-platform/core";
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
      // Reaching Access at all means the Access policy let this person in.
      // What they may do once inside is configuration keyed by the subject
      // id — hard-coding an address to decide it is what the design forbids.
      role: roleFor(verified.claims.sub, env),
    };
  }

  // The only bypass, and it needs two things to be true at once: the deployment
  // must say it is local, and a developer must have named themselves. Neither
  // is true of the production Worker.
  if (verified.reason === "not_configured" && env.ENVIRONMENT === "local" && env.DEV_ADMIN_EMAIL) {
    const id = `local:${env.DEV_ADMIN_EMAIL}`;
    return { id, email: env.DEV_ADMIN_EMAIL, role: roleFor(id, env) };
  }

  return null;
}

/** `ADMIN_ROLES[subject]`, else `DEFAULT_ADMIN_ROLE`, else `viewer`. */
export function roleFor(subject: string, env: AdminWebEnv): AdminRole {
  const named = env.ADMIN_ROLES?.[subject];
  if (isAdminRole(named)) return named;
  return isAdminRole(env.DEFAULT_ADMIN_ROLE) ? env.DEFAULT_ADMIN_ROLE : "viewer";
}

export function actorFor(identity: AdminIdentity): ActorRef {
  return { type: "admin", id: identity.id };
}

/** Optional per-subject choice of an already scoped Service Binding. The
 * mapping is deployment configuration; neither a header nor a project slug
 * can select the binding. When configured, unlisted subjects are refused. */
export function coreFor(
  identity: AdminIdentity,
  env: AdminWebEnv,
): AdminWebEnv["ADMIN_CORE"] | null {
  if (env.ADMIN_CORE_ROUTES === undefined) return env.ADMIN_CORE;
  const name = env.ADMIN_CORE_ROUTES[identity.id];
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(name)) return null;
  const binding = (env as unknown as Record<string, unknown>)[name];
  return binding && typeof binding === "object" ? (binding as AdminWebEnv["ADMIN_CORE"]) : null;
}
