import type { AdminIdentity } from "@inquiry-platform/core";
import {
  INTERNAL_ORIGIN,
  INTERNAL_PATHS,
  permissionsForRole,
  platformApiDescriptor,
} from "@inquiry-platform/core";
import type { Hono } from "hono";
import type { AdminWebEnv } from "../env";
import { failure, requestId, respond } from "../http";
import { actorFor } from "../identity";

type Variables = { identity: AdminIdentity; core: AdminWebEnv["ADMIN_CORE"] };
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

  // Machine-readable discovery for every consumer. This is deliberately a
  // contract descriptor, not a UI/session bootstrap response.
  app.get("/api", (c) =>
    c.json({ ok: true, data: platformApiDescriptor, requestId: requestId(c) }),
  );

  app.get("/api/deliveries", async (c) => respond(c, await c.get("core").listDeliveryJobs()));
  app.post("/api/deliveries/:id/retry", async (c) =>
    respond(c, await c.get("core").retryDeliveryJob(c.req.param("id"), actor(c))),
  );

  app.get("/api/tickets", async (c) =>
    respond(c, await c.get("core").listTickets({ ...c.req.query() })),
  );
  app.get("/api/tickets/masters", async (c) => respond(c, await c.get("core").ticketMasters()));
  app.post("/api/tickets/masters", async (c) =>
    respond(c, await c.get("core").saveTicketMaster(await body(c), actor(c))),
  );
  app.get("/api/tickets/dashboard", async (c) => respond(c, await c.get("core").ticketDashboard()));
  app.get("/api/tickets/source/:kind/:id", async (c) =>
    respond(c, await c.get("core").ticketSource(c.req.param("kind"), c.req.param("id"))),
  );
  app.get("/api/tickets/:id/reply-context", async (c) =>
    respond(c, await c.get("core").ticketReplyContext(c.req.param("id"))),
  );
  app.get("/api/tickets/:id", async (c) =>
    respond(
      c,
      await c.get("core").getTicket(c.req.param("id"), numberParam(c.req.query("offset"), 0)),
    ),
  );
  app.post("/api/tickets", async (c) =>
    respond(c, await c.get("core").createTicket(await body(c), actor(c))),
  );
  app.patch("/api/tickets/:id", async (c) =>
    respond(
      c,
      await c.get("core").changeTicket({ ...(await body(c)), id: c.req.param("id") }, actor(c)),
    ),
  );
  app.post("/api/tickets/:id/ack", async (c) =>
    respond(c, await c.get("core").acknowledgeTicket(c.req.param("id"), actor(c))),
  );
  app.post("/api/tickets/:id/notes", async (c) =>
    respond(
      c,
      await c.get("core").addTicketNote({ ...(await body(c)), id: c.req.param("id") }, actor(c)),
    ),
  );
  app.post("/api/tickets/:id/relations", async (c) =>
    respond(
      c,
      await c.get("core").relateTickets({ ...(await body(c)), id: c.req.param("id") }, actor(c)),
    ),
  );
  app.post("/api/tickets/:id/merge", async (c) =>
    respond(
      c,
      await c.get("core").mergeTickets({ ...(await body(c)), id: c.req.param("id") }, actor(c)),
    ),
  );

  // Support lifecycle compatibility endpoints remain disabled. Moderation
  // has its own lifecycle and is handled below.
  for (const path of [
    "/api/support/threads/:id/status",
    "/api/support/threads/:id/app",
    "/api/support/threads/:id/notes",
  ]) {
    app.post(path, (c) =>
      failure(c, { code: "CONFLICT", message: "Ticket API の標準操作を使用してください。" }, 409),
    );
  }

  // ---- session ----------------------------------------------------------
  app.get("/api/session", async (c) => {
    const identity = c.get("identity");
    return c.json({
      ok: true,
      data: {
        email: identity.email,
        role: identity.role,
        permissions: permissionsForRole(identity.role),
        // Drives the composer: with no provider the send button is disabled and
        // says why, and everything else on the screen still works.
        mailConfigured: await c.get("core").mailProviderConfigured(),
        // What the console calls itself and whom it replies as. From the
        // deployment's branding, via Core.
        profile: await c.get("core").consoleProfile(),
      },
    });
  });

  app.get("/api/dashboard", async (c) => respond(c, await c.get("core").getDashboard()));

  app.get("/api/activity", async (c) =>
    respond(
      c,
      await c.get("core").listActivity({
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
      await c.get("core").listReports({
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

  app.post("/api/reports/:id/review", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .changeReportStatus({ reportId: c.req.param("id"), to: "reviewing" }, actor(c)),
    ),
  );

  app.post("/api/reports/:id/decision/prepare", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .prepareReportDecision({ ...(await body(c)), reportId: c.req.param("id") }, actor(c)),
    ),
  );
  app.post("/api/reports/:id/decision/complete", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .completeReportDecision({ ...(await body(c)), reportId: c.req.param("id") }, actor(c)),
    ),
  );

  app.get("/api/reports/:id", async (c) =>
    respond(c, await c.get("core").getReport(c.req.param("id"))),
  );

  app.post("/api/reports/:id/status", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .changeReportStatus({ ...(await body(c)), reportId: c.req.param("id") } as never, actor(c)),
    ),
  );

  app.post("/api/reports/:id/notes", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .addReportNote({ ...(await body(c)), reportId: c.req.param("id") } as never, actor(c)),
    ),
  );

  app.post("/api/reports/:id/resolution", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .updateReportResolution(
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
      c.get("core"),
      INTERNAL_PATHS.reportAttachment(c.req.param("id"), c.req.param("attachmentId")),
    ),
  );

  // ---- support ----------------------------------------------------------
  app.get("/api/support/threads", async (c) =>
    respond(
      c,
      await c.get("core").listSupportThreads({
        appId: c.req.query("appId"),
        status: c.req.query("status") as never,
        query: c.req.query("query"),
        limit: numberParam(c.req.query("limit"), 50),
        offset: numberParam(c.req.query("offset"), 0),
      }),
    ),
  );

  app.get("/api/support/threads/:id", async (c) =>
    respond(c, await c.get("core").getSupportThread(c.req.param("id"))),
  );

  app.post("/api/support/threads/:id/status", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .setSupportStatus({ ...(await body(c)), threadId: c.req.param("id") } as never, actor(c)),
    ),
  );

  app.post("/api/support/threads/:id/app", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .assignSupportApp({ ...(await body(c)), threadId: c.req.param("id") } as never, actor(c)),
    ),
  );

  /** An internal note. A different Admin Core method from a reply, reaching a
   * different service, which does not have a mail provider. */
  app.post("/api/support/threads/:id/notes", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .addInternalNote({ ...(await body(c)), threadId: c.req.param("id") } as never, actor(c)),
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
      await c
        .get("core")
        .sendSupportReply({ ...(await body(c)), threadId: c.req.param("id") } as never, actor(c)),
    ),
  );

  app.get("/api/support/threads/:id/draft", async (c) =>
    respond(c, await c.get("core").getSupportDraft(c.req.param("id"))),
  );

  app.put("/api/support/threads/:id/draft", async (c) =>
    respond(
      c,
      await c.get("core").saveSupportDraft({
        ...(await body(c)),
        threadId: c.req.param("id"),
      } as never),
    ),
  );

  app.delete("/api/support/threads/:id/draft", async (c) =>
    respond(c, await c.get("core").deleteSupportDraft(c.req.param("id"))),
  );

  app.post("/api/support/threads/:id/apply-template", async (c) =>
    respond(
      c,
      await c.get("core").applyReplyTemplate({
        ...(await body(c)),
        threadId: c.req.param("id"),
      } as never),
    ),
  );

  app.get("/api/support/messages/:messageId/attachments/:attachmentId", async (c) =>
    proxyAttachment(
      c.get("core"),
      INTERNAL_PATHS.supportAttachment(c.req.param("messageId"), c.req.param("attachmentId")),
    ),
  );

  // ---- reply templates --------------------------------------------------
  app.get("/api/support/templates", async (c) =>
    respond(
      c,
      await c.get("core").listReplyTemplates({
        forAppId: c.req.query("forAppId"),
        includeInactive: c.req.query("includeInactive") === "true",
      }),
    ),
  );

  app.post("/api/support/templates", async (c) =>
    respond(c, await c.get("core").createReplyTemplate((await body(c)) as never, actor(c))),
  );

  app.patch("/api/support/templates/:id", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .updateReplyTemplate(c.req.param("id"), (await body(c)) as never, actor(c)),
    ),
  );

  app.post("/api/support/templates/:id/deactivate", async (c) =>
    respond(c, await c.get("core").deactivateReplyTemplate(c.req.param("id"), actor(c))),
  );

  app.get("/api/support/mail-settings", async (c) =>
    respond(c, await c.get("core").listAppMailSettings()),
  );

  app.put("/api/support/mail-settings", async (c) =>
    respond(c, await c.get("core").setAppMailSettings((await body(c)) as never, actor(c))),
  );

  // ---- notifications ----------------------------------------------------
  //
  // Everything here is scoped to the signed-in operator by Admin Core, which
  // takes the actor and looks up only that actor's rows. The browser never
  // receives an endpoint or a key back; it only ever sends its own.
  app.get("/api/notifications", async (c) =>
    respond(c, await c.get("core").notificationOverview(actor(c))),
  );
  app.put("/api/notifications/settings", async (c) =>
    respond(c, await c.get("core").saveNotificationSettings((await body(c)) as never, actor(c))),
  );
  app.post("/api/notifications/push/subscriptions", async (c) =>
    respond(
      c,
      await c.get("core").registerPushSubscription(
        {
          ...(await body(c)),
          // From the request, so a body cannot claim to be a different device.
          userAgent: c.req.header("User-Agent")?.slice(0, 300),
        } as never,
        actor(c),
      ),
    ),
  );
  /** "This device": the browser names its own endpoint. */
  app.post("/api/notifications/push/unsubscribe", async (c) =>
    respond(c, await c.get("core").revokePushSubscription((await body(c)) as never, actor(c))),
  );
  /** Another of the operator's devices, from the list. */
  app.delete("/api/notifications/push/subscriptions/:id", async (c) =>
    respond(c, await c.get("core").revokePushSubscription({ id: c.req.param("id") }, actor(c))),
  );

  // ---- apps -------------------------------------------------------------
  app.get("/api/apps", async (c) =>
    respond(
      c,
      await c.get("core").listApps({
        includeArchived: c.req.query("includeArchived") === "true",
      }),
    ),
  );

  app.post("/api/apps", async (c) =>
    respond(c, await c.get("core").createApp((await body(c)) as never, actor(c))),
  );

  app.get("/api/apps/:id", async (c) => respond(c, await c.get("core").getApp(c.req.param("id"))));

  app.patch("/api/apps/:id", async (c) =>
    respond(
      c,
      await c.get("core").updateApp(c.req.param("id"), (await body(c)) as never, actor(c)),
    ),
  );

  app.post("/api/apps/:id/archive", async (c) =>
    respond(c, await c.get("core").archiveApp(c.req.param("id"), actor(c))),
  );

  app.post("/api/apps/:id/restore", async (c) =>
    respond(c, await c.get("core").restoreApp(c.req.param("id"), actor(c))),
  );

  app.post("/api/apps/:id/links", async (c) =>
    respond(
      c,
      await c
        .get("core")
        .addAppLink({ ...(await body(c)), appId: c.req.param("id") } as never, actor(c)),
    ),
  );

  app.delete("/api/apps/links/:linkId", async (c) =>
    respond(c, await c.get("core").removeAppLink(c.req.param("linkId"), actor(c))),
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
async function proxyAttachment(core: AdminWebEnv["ADMIN_CORE"], path: string): Promise<Response> {
  const upstream = await core.fetch(`${INTERNAL_ORIGIN}${path}`);
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
