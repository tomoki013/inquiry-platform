import type { AdminIdentity } from "@tomokichi/admin-contracts";
import { Hono } from "hono";
import type { AdminWebEnv } from "./env";
import { failure } from "./http";
import { resolveIdentity } from "./identity";
import { type AdminApi, registerApiRoutes } from "./routes/api";
import { requireSafeMutation, securityHeaders } from "./security";

/**
 * `admin.tmkch.io` — the only part of Admin that is on the internet.
 *
 * It serves the built React app and answers `/api/*`, and it holds exactly one
 * binding: Admin Core. No D1, no R2. Everything it can do, it does by asking.
 *
 * Order matters in the middleware below. Security headers go on every response
 * including the ones that were refused; the Access check runs before any route
 * so there is no way to add a route that forgets it; and the mutation guard
 * runs after the identity is known, so a rejected origin is refused for a
 * signed-in person as readily as for anybody else.
 */
export function createApp() {
  const app = new Hono<{ Bindings: AdminWebEnv; Variables: { identity: AdminIdentity } }>();

  app.use("*", securityHeaders);

  /**
   * The gate.
   *
   * `requireAdminAccess` in the design. Applied to `*`, not to `/api/*`: the
   * client bundle is not secret, but there is no reason to hand the admin
   * screen's markup to somebody who cannot use it, and one rule is easier to
   * be sure about than two.
   */
  app.use("*", async (c, next) => {
    // The install surface of the PWA — the manifest and its icons — carries
    // nothing but a name and a picture, and a browser fetches the icons
    // without credentials, so behind the gate they would be broken images on
    // the install sheet. Nothing else is exempt: the bundle, the service
    // worker and every `/api/*` route stay behind Access. (The Access policy at
    // the edge needs the matching bypass; see `apps/admin-core/README.md`.)
    if (isInstallAsset(new URL(c.req.url).pathname)) return await next();

    const identity = await resolveIdentity(c.req.raw, c.env);
    if (!identity) {
      // Access normally redirects to the login page before a request ever gets
      // here. Reaching this line means the token was missing, wrong, or minted
      // for a different application — none of which is a thing to explain in
      // detail to whoever is asking.
      return failure(c, { code: "UNAUTHORIZED", message: "サインインが必要です。" }, 401);
    }
    c.set("identity", identity);
    return await next();
  });

  app.use("/api/*", requireSafeMutation);

  registerApiRoutes(app as AdminApi);

  // Anything that is not the API is the single-page app. `not_found_handling`
  // in wrangler.jsonc turns an unknown path into index.html, so the client
  // router owns routing and a deep link works on a cold load.
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}

/** `/manifest.webmanifest` and `/icons/*` — see the gate above. */
export function isInstallAsset(pathname: string): boolean {
  return pathname === "/manifest.webmanifest" || pathname.startsWith("/icons/");
}

export default createApp();
