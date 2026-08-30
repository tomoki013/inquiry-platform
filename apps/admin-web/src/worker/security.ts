import type { Context, Next } from "hono";
import type { AdminWebEnv } from "./env";
import { failure } from "./http";

type AdminContext = Context<{ Bindings: AdminWebEnv }>;

/**
 * A Content Security Policy that says almost nothing is allowed.
 *
 * The admin screen is a single bundled app with no third-party anything, so it
 * can afford the strictest policy there is: no external scripts, no framing, no
 * form posts anywhere, and images restricted to the origin's own bytes — which
 * is what report evidence is served as, through this Worker, from the private
 * bucket. `style-src` allows inline because Tailwind's build emits a stylesheet
 * and React sets a handful of inline styles; scripts do not get the same
 * exemption, which is the half that matters.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export async function securityHeaders(c: AdminContext, next: Next): Promise<void> {
  await next();
  // A response that came back from `ASSETS.fetch` carries immutable headers, so
  // setting one throws rather than being ignored — which took the whole screen
  // down with a 500 before anything else got a chance to go wrong. Rebuilding
  // the response gives a Headers that can be written to; the status and the
  // body are carried over untouched.
  c.res = new Response(c.res.body, c.res);
  const headers = c.res.headers;
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("X-Frame-Options", "DENY");
  // Nothing here is public and nothing should sit in a shared cache.
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    headers.set("Cache-Control", "private, no-store");
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The guard on every state-changing call.
 *
 * Access already requires a signed token, and the API is same-origin only, so
 * this is defence in depth rather than the only thing standing there — but the
 * two checks it makes are the ones that turn a cross-site request into a
 * refused one. There is no CORS configuration in this Worker at all: no
 * `Access-Control-Allow-Origin` is ever sent, so a browser will not let another
 * site read a response even if it managed to send the request.
 */
export async function requireSafeMutation(
  c: AdminContext,
  next: Next,
): Promise<Response | undefined> {
  if (!MUTATING.has(c.req.method)) {
    await next();
    return undefined;
  }

  const origin = c.req.header("Origin");
  const allowed = new Set([
    c.env.ADMIN_ORIGIN,
    ...(c.env.ENVIRONMENT === "local" ? ["http://localhost:4330", "http://127.0.0.1:4330"] : []),
  ]);
  if (!origin || !allowed.has(origin)) {
    return failure(c, { code: "FORBIDDEN", message: "この操作は許可されていません。" }, 403);
  }

  // JSON only. A form post cannot be sent cross-site with this content type
  // without a preflight, and a preflight is what the missing CORS headers stop.
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
