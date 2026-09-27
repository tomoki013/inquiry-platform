import type { Context, Next } from "hono";
import type { AdminWebEnv } from "./env";
import { failure } from "./http";

type AdminContext = Context<{ Bindings: AdminWebEnv }>;

/** The API is not a document surface; keep browser embedding impossible. */
const CSP = ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"].join("; ");

export async function securityHeaders(c: AdminContext, next: Next): Promise<void> {
  await next();
  // Rebuild the response so headers are writable regardless of the upstream
  // implementation.
  c.res = new Response(c.res.body, c.res);
  const headers = c.res.headers;
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "private, no-store");
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Cookie-authenticated browser clients need an Origin check to prevent CSRF.
 * Token-authenticated API clients do not need a browser Origin and can be
 * implemented in any language. There is no CORS configuration in this Worker.
 */
export async function requireSafeMutation(
  c: AdminContext,
  next: Next,
): Promise<Response | undefined> {
  if (!MUTATING.has(c.req.method)) {
    await next();
    return undefined;
  }

  const hasTokenHeader =
    c.req.header("Cf-Access-Jwt-Assertion") !== undefined ||
    c.req.header("Authorization")?.startsWith("Bearer ") === true;
  if (!hasTokenHeader) {
    const origin = c.req.header("Origin");
    const allowed = new Set([
      c.env.ADMIN_ORIGIN,
      ...(c.env.ENVIRONMENT === "local" ? ["http://localhost:4330", "http://127.0.0.1:4330"] : []),
    ]);
    if (!origin || !allowed.has(origin)) {
      return failure(c, { code: "FORBIDDEN", message: "この操作は許可されていません。" }, 403);
    }
  }

  // JSON only. A form post cannot be sent cross-site with this content type
  // without a preflight, and this API emits no CORS headers.
  const contentType = c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (c.req.method !== "DELETE" && contentType !== "application/json") {
    return failure(
      c,
      { code: "VALIDATION_ERROR", message: "Content-Type は application/json のみです。" },
      400,
    );
  }
  await next();
  return undefined;
}
