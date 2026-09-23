import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { AdminWebEnv } from "./env";

/**
 * Verifying Cloudflare Access, in the Worker, again.
 *
 * Access already stopped the request at the edge — so why check? Because
 * "Access is in front of this hostname" is a dashboard setting, and a Worker
 * that trusts it is one misconfigured route, one preview URL or one
 * `workers.dev` subdomain away from being open. The token is checked here so
 * that the guarantee lives in code that ships with the application.
 *
 * `jose` does the cryptography. Nothing in this file parses a JWT by hand.
 */
export interface AccessClaims {
  /** Access's stable subject id for the person. */
  sub: string;
  email?: string;
}

export type AccessResult =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: "missing" | "invalid" | "not_configured" };

/** One JWKS fetcher per team domain, kept across requests — `jose` caches and
 * refreshes the keys itself, and building a new one per request would fetch
 * Cloudflare's certificates on every page load. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(teamDomain: string) {
  let existing = jwksCache.get(teamDomain);
  if (!existing) {
    existing = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, existing);
  }
  return existing;
}

export async function verifyAccessJwt(request: Request, env: AdminWebEnv): Promise<AccessResult> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    // Unconfigured is a refusal, never a bypass. The one exception is local
    // development, and it is decided in `identity.ts` where it is visible.
    return { ok: false, reason: "not_configured" };
  }

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ?? cookie(request, "CF_Authorization");
  if (!token) return { ok: false, reason: "missing" };

  try {
    const { payload } = await jwtVerify(token, keySet(env.ACCESS_TEAM_DOMAIN), {
      // Signature, issuer, audience and expiry — all four, because three of
      // them still admit a valid token minted for a different application.
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
    return { ok: true, claims: toClaims(payload) };
  } catch {
    // Nothing about *why* goes anywhere near the response or the log: a
    // verification error message can quote the token.
    return { ok: false, reason: "invalid" };
  }
}

function toClaims(payload: JWTPayload): AccessClaims {
  const email = typeof payload.email === "string" ? payload.email : undefined;
  return { sub: typeof payload.sub === "string" ? payload.sub : "unknown", email };
}

function cookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
