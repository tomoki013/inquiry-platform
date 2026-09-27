import type { AdminIdentity } from "@inquiry-platform/core";
import { can, permissionFor } from "@inquiry-platform/core";
import { Hono } from "hono";
import type { AdminWebEnv } from "./env";
import { failure } from "./http";
import { resolveIdentity } from "./identity";
import { type AdminApi, registerApiRoutes } from "./routes/api";
import { requireSafeMutation, securityHeaders } from "./security";

/**
 * The platform's API gateway.
 *
 * This Worker deliberately has no assets, HTML, PWA, or UI entrypoint. Every
 * consumer — an operator console, a CLI, or an integration — uses the same
 * authenticated API surface. It holds exactly one binding: Admin Core. No D1,
 * no R2. Everything it can do, it does by asking.
 */
export function createApp() {
  const app = new Hono<{ Bindings: AdminWebEnv; Variables: { identity: AdminIdentity } }>();

  app.use("*", securityHeaders);

  // The gate is global. There is no non-API surface to accidentally leave
  // outside authentication.
  app.use("*", async (c, next) => {
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

  /**
   * Authorization. After the gate (so there is an identity) and before every
   * route (so no route can forget it). The permission comes from the method
   * and path alone — see `permissionFor` — so a new route is covered the day
   * it is added.
   */
  app.use("/api/*", async (c, next) => {
    const permission = permissionFor(c.req.method, new URL(c.req.url).pathname);
    if (!permission || !can(c.get("identity").role, permission)) {
      return failure(c, { code: "FORBIDDEN", message: "この操作の権限がありません。" }, 403);
    }
    return await next();
  });

  registerApiRoutes(app as AdminApi);

  // No HTML fallback. A typo, an attempted UI route, and an unknown API route
  // all receive the same machine-readable 404 contract.
  app.all("*", (c) => failure(c, { code: "NOT_FOUND", message: "そのAPIはありません。" }, 404));

  return app;
}

export default createApp();
