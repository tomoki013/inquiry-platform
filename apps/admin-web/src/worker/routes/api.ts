import type { AdminIdentity } from "@tomokichi/admin-contracts";
import { INTERNAL_ORIGIN, INTERNAL_PATHS } from "@tomokichi/admin-contracts";
import type { Hono } from "hono";
import type { AdminWebEnv } from "../env";
import { failure, respond } from "../http";
import { actorFor } from "../identity";

type Variables = { identity: AdminIdentity };
export type AdminApi = Hono<{ Bindings: AdminWebEnv; Variables: Variables }>;

/**
 * Every admin route.
 *
 * Thin on purpose: parse the path, hand the body to Admin Core, unwrap the
 * `Result`. There is no validation here beyond what the path shape requires and
 * no business rule at all — the status machine, the send guards and the
 * template rendering all live in Admin Core, because the browser is not the
 * only thing that can reach them and a rule enforced in two places is a rule
 * that will disagree with itself.
 */
export function registerApiRoutes(app: AdminApi): void {
  const actor = (c: { get: (k: "identity") => AdminIdentity }) => actorFor(c.get("identity"));

  // ---- session ----------------------------------------------------------
  app.get("/api/session", async (c) => {
    const identity = c.get("identity");
    return c.json({
      ok: true,
      data: {
        email: identity.email,
        role: identity.role,
        // Drives the composer: with no provider the send button is disabled and
        // says why, and everything else on the screen still works.
        mailConfigured: await c.env.ADMIN_CORE.mailProviderConfigured(),
      },
    });
  });

  app.get("/api/dashboard", async (c) => respond(c, await c.env.ADMIN_CORE.getDashboard()));

  app.get("/api/activity", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.listActivity({
        appId: c.req.query("appId"),
        targetType: c.req.query("targetType") as never,
        targetId: c.req.query("targetId"),
        limit: numberParam(c.req.query("limit"), 50),
        offset: numberParam(c.req.query("offset"), 0),
      }),
    ),
  );

  // ---- reports ----------------------------------------------------------
  app.get("/api/reports", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.listReports({
        appId: c.req.query("appId"),
        status: c.req.query("status") as never,
        reasonCode: c.req.query("reasonCode"),
        contentType: c.req.query("contentType"),
        query: c.req.query("query"),
        limit: numberParam(c.req.query("limit"), 50),
        offset: numberParam(c.req.query("offset"), 0),
      }),
    ),
  );

  app.get("/api/reports/:id", async (c) =>
    respond(c, await c.env.ADMIN_CORE.getReport(c.req.param("id"))),
  );

  app.post("/api/reports/:id/status", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.changeReportStatus(
        { ...(await body(c)), reportId: c.req.param("id") } as never,
        actor(c),
      ),
    ),
  );

  app.post("/api/reports/:id/notes", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.addReportNote(
        { ...(await body(c)), reportId: c.req.param("id") } as never,
        actor(c),
      ),
    ),
  );

  app.post("/api/reports/:id/resolution", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.updateReportResolution(
        { ...(await body(c)), reportId: c.req.param("id") } as never,
        actor(c),
      ),
    ),
  );

  /**
   * Report evidence.
   *
   * The bytes come from the private bucket, through Admin Core, through this
   * authenticated route, to the browser. No signed URL and no public link ever
   * exists: a photo somebody reported is readable for exactly as long as
   * somebody is signed in to this screen.
   */
  app.get("/api/reports/:id/attachments/:attachmentId", async (c) =>
    proxyAttachment(
      c.env,
      INTERNAL_PATHS.reportAttachment(c.req.param("id"), c.req.param("attachmentId")),
    ),
  );

  // ---- support ----------------------------------------------------------
  app.get("/api/support/threads", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.listSupportThreads({
        appId: c.req.query("appId"),
        status: c.req.query("status") as never,
        query: c.req.query("query"),
        limit: numberParam(c.req.query("limit"), 50),
        offset: numberParam(c.req.query("offset"), 0),
      }),
    ),
  );

  app.get("/api/support/threads/:id", async (c) =>
    respond(c, await c.env.ADMIN_CORE.getSupportThread(c.req.param("id"))),
  );

  app.post("/api/support/threads/:id/status", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.setSupportStatus(
        { ...(await body(c)), threadId: c.req.param("id") } as never,
        actor(c),
      ),
    ),
  );

  app.post("/api/support/threads/:id/app", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.assignSupportApp(
        { ...(await body(c)), threadId: c.req.param("id") } as never,
        actor(c),
      ),
    ),
  );

  /** An internal note. A different Admin Core method from a reply, reaching a
   * different service, which does not have a mail provider. */
  app.post("/api/support/threads/:id/notes", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.addInternalNote(
        { ...(await body(c)), threadId: c.req.param("id") } as never,
        actor(c),
      ),
    ),
  );

  /**
   * Send.
   *
   * The body carries a body and an idempotency key — never a recipient, a
   * sender or a subject. Those are built in Admin Core from the thread, so a
   * tampered request cannot redirect a reply to somebody else.
   */
  app.post("/api/support/threads/:id/reply", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.sendSupportReply(
        { ...(await body(c)), threadId: c.req.param("id") } as never,
        actor(c),
      ),
    ),
  );

  app.get("/api/support/threads/:id/draft", async (c) =>
    respond(c, await c.env.ADMIN_CORE.getSupportDraft(c.req.param("id"))),
  );

  app.put("/api/support/threads/:id/draft", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.saveSupportDraft({
        ...(await body(c)),
        threadId: c.req.param("id"),
      } as never),
    ),
  );

  app.delete("/api/support/threads/:id/draft", async (c) =>
    respond(c, await c.env.ADMIN_CORE.deleteSupportDraft(c.req.param("id"))),
  );

  app.post("/api/support/threads/:id/apply-template", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.applyReplyTemplate({
        ...(await body(c)),
        threadId: c.req.param("id"),
      } as never),
    ),
  );

  app.get("/api/support/messages/:messageId/attachments/:attachmentId", async (c) =>
    proxyAttachment(
      c.env,
      INTERNAL_PATHS.supportAttachment(c.req.param("messageId"), c.req.param("attachmentId")),
    ),
  );

  // ---- reply templates --------------------------------------------------
  app.get("/api/support/templates", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.listReplyTemplates({
        forAppId: c.req.query("forAppId"),
        includeInactive: c.req.query("includeInactive") === "true",
      }),
    ),
  );

  app.post("/api/support/templates", async (c) =>
    respond(c, await c.env.ADMIN_CORE.createReplyTemplate((await body(c)) as never, actor(c))),
  );

  app.patch("/api/support/templates/:id", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.updateReplyTemplate(
        c.req.param("id"),
        (await body(c)) as never,
        actor(c),
      ),
    ),
  );

  app.post("/api/support/templates/:id/deactivate", async (c) =>
    respond(c, await c.env.ADMIN_CORE.deactivateReplyTemplate(c.req.param("id"), actor(c))),
  );

  app.get("/api/support/mail-settings", async (c) =>
    respond(c, await c.env.ADMIN_CORE.listAppMailSettings()),
  );

  app.put("/api/support/mail-settings", async (c) =>
    respond(c, await c.env.ADMIN_CORE.setAppMailSettings((await body(c)) as never, actor(c))),
  );

  // ---- apps -------------------------------------------------------------
  app.get("/api/apps", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.listApps({
        includeArchived: c.req.query("includeArchived") === "true",
      }),
    ),
  );

  app.post("/api/apps", async (c) =>
    respond(c, await c.env.ADMIN_CORE.createApp((await body(c)) as never, actor(c))),
  );

  app.get("/api/apps/:id", async (c) =>
    respond(c, await c.env.ADMIN_CORE.getApp(c.req.param("id"))),
  );

  app.patch("/api/apps/:id", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.updateApp(c.req.param("id"), (await body(c)) as never, actor(c)),
    ),
  );

  app.post("/api/apps/:id/archive", async (c) =>
    respond(c, await c.env.ADMIN_CORE.archiveApp(c.req.param("id"), actor(c))),
  );

  app.post("/api/apps/:id/restore", async (c) =>
    respond(c, await c.env.ADMIN_CORE.restoreApp(c.req.param("id"), actor(c))),
  );

  app.post("/api/apps/:id/links", async (c) =>
    respond(
      c,
      await c.env.ADMIN_CORE.addAppLink(
        { ...(await body(c)), appId: c.req.param("id") } as never,
        actor(c),
      ),
    ),
  );

  app.delete("/api/apps/links/:linkId", async (c) =>
    respond(c, await c.env.ADMIN_CORE.removeAppLink(c.req.param("linkId"), actor(c))),
  );

  app.all("/api/*", (c) =>
    failure(c, { code: "NOT_FOUND", message: "そのAPIはありません。" }, 404),
  );
}

/**
 * The request body, as whatever the route is about to pass on.
 *
 * The cast is the honest shape of this boundary: what arrives is arbitrary JSON
 * from a browser, and the types on `AdminCoreApi` describe what a *valid* call
 * looks like, not what this Worker can prove it has. Admin Core validates every
 * field with Zod before touching anything — see `validationFailure` — so
 * asserting the type here buys the interface's documentation value without
 * pretending a check happened that did not. A malformed body becomes `{}` and
 * comes back as a field-level validation error.
 */
async function body(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function numberParam(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Streams a private object out of Admin Core.
 *
 * The response headers Admin Core chose — content type, and `inline` vs
 * `attachment` — are passed through unchanged, because it is Admin Core that
 * decided which types are safe to render. Nothing here re-derives them from a
 * filename.
 */
async function proxyAttachment(env: AdminWebEnv, path: string): Promise<Response> {
  const upstream = await env.ADMIN_CORE.fetch(`${INTERNAL_ORIGIN}${path}`);
  if (!upstream.ok) {
    return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition": upstream.headers.get("Content-Disposition") ?? "attachment",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
