import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActorRef,
  AdminCoreApi,
  AppDetail,
  AppliedTemplate,
  AppMailSettings,
  AppSummary,
  AuditEntry,
  ConsoleProfile,
  CreateReportResult,
  DashboardSummary,
  IngestInboundEmailResult,
  NotificationOverview,
  NotificationSettings,
  PushDeviceSummary,
  ReplyTemplate,
  ReportDetail,
  ReportListPage,
  Result,
  SupportDraft,
  SupportThreadDetail,
  SupportThreadListPage,
} from "@inquiry-platform/core";
import {
  ATTACHMENT_FILENAME_HEADER,
  fail,
  listAuditInputSchema,
  newId,
  ok,
} from "@inquiry-platform/core";
import { dispositionFor, FileStore } from "./db/files";
import { ReportRepository } from "./db/reports";
import { SupportRepository } from "./db/support";
import { internalFailure, notFound, validationFailure } from "./domain/failures";
import { sha256Hex } from "./domain/identity";
import { expireReportEvidence } from "./domain/report-retention";
import { Scope } from "./domain/scope";
import type { AdminCoreEnv } from "./env";
import { putReportEvidence } from "./evidence";
import { json, readBounded } from "./http";
import { privateCipher } from "./privacy/crypto";
import { privateBucket } from "./privacy/files";
import { migratePrivateStorage } from "./privacy/maintenance";
import { buildServices } from "./services";
import { namespacedSupportKey } from "./storage/files";

/**
 * The platform API: every ticket, report, reply and audit row.
 *
 * Not on the internet. `workers_dev` is off and there is no route, so the only
 * ways to reach this Worker are the Service Bindings declared by the API gateway,
 * console, the mail Worker and the projects' own public APIs. That is what lets the D1 and R2 bindings
 * live here and nowhere else: a bug in an internet-facing route handler cannot
 * reach a database it was never given.
 *
 * Two surfaces:
 *
 * - **RPC**, the methods below, for everything structured. They return
 *   `Result` rather than throwing, because an exception does not survive the
 *   binding intact and a caller has to be able to branch on *why*.
 * - **`fetch()`**, for bytes. A ten-megabyte photo cannot be an RPC argument
 *   and must not be base64 in JSON.
 *
 * A binding may carry a scope in its `props` (`adminCorePropsSchema`): a
 * console that operates some of the deployment's services. Every method that
 * names a record checks it belongs to the scope and answers NOT_FOUND when it
 * does not; every list and count is filtered; deployment-wide settings are
 * read-only. A binding without a scope sees everything, as before.
 */
export default class AdminCore extends WorkerEntrypoint<AdminCoreEnv> implements AdminCoreApi {
  private cached?: ReturnType<typeof buildServices>;

  private get services() {
    this.cached ??= buildServices(this.env, (work) => this.ctx.waitUntil(work), this.scope());
    return this.cached;
  }

  private resolved?: Promise<Scope>;

  /** This binding's scope, from its props — once per invocation. */
  private scope(): Promise<Scope> {
    this.resolved ??= Scope.resolve(this.env.DB, (this.ctx as { props?: unknown }).props);
    return this.resolved;
  }

  /** Runs `work` only when `allowed`; otherwise the record does not exist. */
  private async within<T>(
    allowed: Promise<boolean>,
    what: string,
    work: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    try {
      if (!(await allowed)) return notFound(what);
    } catch (error) {
      return internalFailure("scope.check", error);
    }
    return work();
  }

  private ticketIn(ref: unknown) {
    return this.scope().then((s) => typeof ref === "string" && s.ticket(this.services.db, ref));
  }
  private reportIn(id: unknown) {
    return this.scope().then((s) => typeof id === "string" && s.report(this.services.db, id));
  }
  private threadIn(id: unknown) {
    return this.scope().then((s) => typeof id === "string" && s.thread(this.services.db, id));
  }
  private appIn(id: unknown) {
    return this.scope().then((s) => typeof id === "string" && s.has(id));
  }
  /** A deployment-wide setting: changeable only without a scope. */
  private async unscoped<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    if ((await this.scope()).limited) {
      return fail("FORBIDDEN", "この管理画面からは変更できない共通設定です。");
    }
    return work();
  }

  async ticketReplyContext(id: string): Promise<Result<SupportThreadDetail>> {
    if (!(await this.ticketIn(id))) return notFound("Ticket");
    try {
      const ticket = await this.tickets.row(id);
      if (!ticket?.thread_id)
        return { ok: false, error: { code: "NOT_FOUND", message: "メール会話がありません。" } };
      const thread = await new SupportRepository(this.services.db).detail(ticket.thread_id, false);
      if (!thread)
        return { ok: false, error: { code: "NOT_FOUND", message: "メール会話がありません。" } };
      return {
        ok: true,
        value: {
          ...thread,
          status:
            ticket.status === "CLOSED" || ticket.status === "RESOLVED"
              ? "resolved"
              : ticket.status === "WAITING_CUSTOMER"
                ? "pending_user"
                : "open",
        },
      };
    } catch (error) {
      return internalFailure("ticket.replyContext", error);
    }
  }
  private get tickets() {
    return this.services.tickets;
  }
  async listTickets(input: unknown) {
    return this.tickets.list(input, await this.scope());
  }
  getTicket(id: string, offset = 0) {
    return this.within(this.ticketIn(id), "Ticket", () => this.tickets.detail(id, offset));
  }
  async ticketSource(kind: string, id: string) {
    const found = await this.tickets.source(kind, id);
    if (found.ok && !(await this.ticketIn(found.value.id)))
      return notFound<{ id: string }>("Ticket");
    return found;
  }
  createTicket(input: unknown, actor: ActorRef) {
    const service = (input as { service_id?: unknown } | null)?.service_id;
    return this.within(this.appIn(service), "サービス", () => this.tickets.create(input, actor));
  }
  changeTicket(input: unknown, actor: ActorRef) {
    const change = (input ?? {}) as { id?: unknown; service_id?: unknown };
    const allowed = Promise.all([
      this.ticketIn(change.id),
      change.service_id === undefined ? true : this.appIn(change.service_id),
    ]).then(([ticket, service]) => ticket && service);
    return this.within(allowed, "Ticket", () => this.tickets.change(input, actor));
  }
  acknowledgeTicket(id: string, actor: ActorRef) {
    return this.within(this.ticketIn(id), "Ticket", () => this.tickets.ack(id, actor));
  }
  addTicketNote(input: unknown, actor: ActorRef) {
    const id = (input as { id?: unknown } | null)?.id;
    return this.within(this.ticketIn(id), "Ticket", () => this.tickets.note(input, actor));
  }
  relateTickets(input: unknown, actor: ActorRef) {
    return this.within(this.bothTickets(input), "Ticket", () =>
      this.tickets.relation(input, actor),
    );
  }
  mergeTickets(input: unknown, actor: ActorRef) {
    return this.within(this.bothTickets(input), "Ticket", () => this.tickets.merge(input, actor));
  }
  private bothTickets(input: unknown) {
    const pair = (input ?? {}) as { id?: unknown; target_id?: unknown };
    return Promise.all([this.ticketIn(pair.id), this.ticketIn(pair.target_id)]).then(
      ([a, b]) => a && b,
    );
  }
  async ticketMasters() {
    return this.tickets.masters(await this.scope());
  }
  saveTicketMaster(input: unknown, actor: ActorRef) {
    return this.unscoped(() => this.tickets.saveMaster(input, actor));
  }
  async ticketDashboard() {
    return this.tickets.dashboard(await this.scope());
  }

  prepareReportDecision(input: unknown, actor: ActorRef) {
    return this.within(this.reportIn(reportIdOf(input)), "通報", () =>
      this.services.reports.prepareDecision(input, actor),
    );
  }
  completeReportDecision(input: unknown, actor: ActorRef) {
    return this.within(this.reportIn(reportIdOf(input)), "通報", () =>
      this.services.reports.completeDecision(input, actor),
    );
  }

  // ---- Reports ----------------------------------------------------------

  // Intake, for mail-ingress and the projects' public APIs; never a scoped console.
  createReport(input: unknown, actor: ActorRef): Promise<Result<CreateReportResult>> {
    return this.unscoped(() => this.services.reports.create(input, actor));
  }
  async listReports(input: unknown): Promise<Result<ReportListPage>> {
    return this.services.reports.list(input, await this.scope());
  }
  getReport(reportId: string): Promise<Result<ReportDetail>> {
    return this.within(this.reportIn(reportId), "通報", () =>
      this.services.reports.detail(reportId),
    );
  }
  changeReportStatus(input: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    return this.within(this.reportIn(reportIdOf(input)), "通報", () =>
      this.services.reports.changeStatus(input, actor),
    );
  }
  addReportNote(input: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    return this.within(this.reportIn(reportIdOf(input)), "通報", () =>
      this.services.reports.addNote(input, actor),
    );
  }
  updateReportResolution(input: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    return this.within(this.reportIn(reportIdOf(input)), "通報", () =>
      this.services.reports.updateResolution(input, actor),
    );
  }

  // ---- Support ----------------------------------------------------------

  async ingestInboundEmail(
    input: unknown,
    actor: ActorRef,
  ): Promise<Result<IngestInboundEmailResult>> {
    return this.unscoped(async () => {
      await this.services.reply.refreshMessageIds();
      return this.services.support.ingestInboundEmail(input, actor);
    });
  }
  createSupportThread(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.unscoped(() => this.services.support.createThread(input, actor));
  }
  addSupportMessage(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.unscoped(() => this.services.support.addMessage(input, actor));
  }
  async listSupportThreads(input: unknown): Promise<Result<SupportThreadListPage>> {
    return this.services.support.list(input, await this.scope());
  }
  getSupportThread(threadId: string): Promise<Result<SupportThreadDetail>> {
    return this.within(this.threadIn(threadId), "問い合わせ", () =>
      this.services.support.detail(threadId),
    );
  }
  setSupportStatus(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.within(this.threadIn(threadIdOf(input)), "問い合わせ", () =>
      this.services.support.setStatus(input, actor),
    );
  }
  assignSupportApp(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    const appId = (input as { appId?: unknown } | null)?.appId;
    const allowed = Promise.all([
      this.threadIn(threadIdOf(input)),
      // Unlinking files the thread under the default service, which may be
      // outside the scope too.
      this.scope().then((s) => !s.limited || (typeof appId === "string" && s.has(appId))),
    ]).then(([thread, app]) => thread && app);
    return this.within(allowed, "問い合わせ", () => this.services.support.assignApp(input, actor));
  }
  /** Routed to the service that has no mail provider. See `SupportService`. */
  addInternalNote(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.within(this.threadIn(threadIdOf(input)), "問い合わせ", () =>
      this.services.support.addInternalNote(input, actor),
    );
  }
  sendSupportReply(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.within(this.threadIn(threadIdOf(input)), "問い合わせ", () =>
      this.services.reply.send(input, actor),
    );
  }
  mailProviderConfigured(): Promise<boolean> {
    return Promise.resolve(this.services.reply.mailConfigured);
  }

  // ---- Drafts and templates ---------------------------------------------

  getSupportDraft(threadId: string): Promise<Result<SupportDraft | null>> {
    return this.within(this.threadIn(threadId), "問い合わせ", () =>
      this.services.reply.getDraft(threadId),
    );
  }
  saveSupportDraft(input: unknown): Promise<Result<SupportDraft>> {
    return this.within(this.threadIn(threadIdOf(input)), "問い合わせ", () =>
      this.services.reply.saveDraft(input),
    );
  }
  deleteSupportDraft(threadId: string): Promise<Result<null>> {
    return this.within(this.threadIn(threadId), "問い合わせ", () =>
      this.services.reply.deleteDraft(threadId),
    );
  }
  async listReplyTemplates(input: unknown): Promise<Result<ReplyTemplate[]>> {
    const scope = await this.scope();
    const listed = await this.services.reply.listTemplates(input);
    if (!listed.ok || !scope.limited) return listed;
    return ok(listed.value.filter((t) => t.appId === undefined || scope.has(t.appId)));
  }
  getReplyTemplate(templateId: string): Promise<Result<ReplyTemplate>> {
    return this.within(this.templateIn(templateId, false), "定型文", () =>
      this.services.reply.getTemplate(templateId),
    );
  }
  createReplyTemplate(input: unknown, actor: ActorRef): Promise<Result<ReplyTemplate>> {
    const appId = (input as { appId?: unknown } | null)?.appId;
    return this.within(this.ownApp(appId), "アプリ", () =>
      this.services.reply.createTemplate(input, actor),
    );
  }
  updateReplyTemplate(
    templateId: string,
    input: unknown,
    actor: ActorRef,
  ): Promise<Result<ReplyTemplate>> {
    const appId = (input as { appId?: unknown } | null)?.appId;
    const allowed = Promise.all([
      this.templateIn(templateId, true),
      appId === undefined ? true : this.ownApp(appId),
    ]).then(([template, app]) => template && app);
    return this.within(allowed, "定型文", () =>
      this.services.reply.updateTemplate(templateId, input, actor),
    );
  }
  deactivateReplyTemplate(templateId: string, actor: ActorRef): Promise<Result<ReplyTemplate>> {
    return this.within(this.templateIn(templateId, true), "定型文", () =>
      this.services.reply.deactivateTemplate(templateId, actor),
    );
  }
  applyReplyTemplate(input: unknown): Promise<Result<AppliedTemplate>> {
    const templateId = (input as { templateId?: unknown } | null)?.templateId;
    const allowed = Promise.all([
      this.threadIn(threadIdOf(input)),
      typeof templateId === "string" ? this.templateIn(templateId, false) : false,
    ]).then(([thread, template]) => thread && template);
    return this.within(allowed, "問い合わせ", () => this.services.reply.applyTemplate(input));
  }
  async listAppMailSettings(): Promise<Result<AppMailSettings[]>> {
    const scope = await this.scope();
    const listed = await this.services.reply.listSettings();
    if (!listed.ok || !scope.limited) return listed;
    return ok(listed.value.filter((row) => row.appId === undefined || scope.has(row.appId)));
  }
  setAppMailSettings(input: unknown, actor: ActorRef): Promise<Result<AppMailSettings>> {
    const appId = (input as { appId?: unknown } | null)?.appId;
    return this.within(this.ownApp(appId), "アプリ", () =>
      this.services.reply.setSettings(input, actor),
    );
  }
  private templateIn(templateId: string, write: boolean) {
    return this.scope().then((s) => s.template(this.services.db, templateId, write));
  }
  /** An app of this scope; `null`/absent (deployment-wide) only without one. */
  private ownApp(appId: unknown) {
    return this.scope().then((s) =>
      appId === null || appId === undefined
        ? !s.limited
        : typeof appId === "string" && s.has(appId),
    );
  }

  // ---- Apps -------------------------------------------------------------

  async listApps(input: unknown): Promise<Result<AppSummary[]>> {
    const scope = await this.scope();
    const listed = await this.services.apps.list(input);
    if (!listed.ok || !scope.limited) return listed;
    return ok(listed.value.filter((app) => scope.has(app.id)));
  }
  getApp(appId: string): Promise<Result<AppDetail>> {
    return this.within(this.appIn(appId), "アプリ", () => this.services.apps.detail(appId));
  }
  /** A new app would fall outside every scope, so only an unscoped console adds one. */
  createApp(input: unknown, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.unscoped(() => this.services.apps.create(input, actor));
  }
  updateApp(appId: string, input: unknown, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.within(this.appIn(appId), "アプリ", () =>
      this.services.apps.update(appId, input, actor),
    );
  }
  archiveApp(appId: string, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.within(this.appIn(appId), "アプリ", () =>
      this.services.apps.setArchived(appId, true, actor),
    );
  }
  restoreApp(appId: string, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.within(this.appIn(appId), "アプリ", () =>
      this.services.apps.setArchived(appId, false, actor),
    );
  }
  addAppLink(input: unknown, actor: ActorRef): Promise<Result<AppDetail>> {
    const appId = (input as { appId?: unknown } | null)?.appId;
    return this.within(this.appIn(appId), "アプリ", () => this.services.apps.addLink(input, actor));
  }
  removeAppLink(linkId: string, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.within(
      this.scope().then((s) => s.link(this.services.db, linkId)),
      "リンク",
      () => this.services.apps.removeLink(linkId, actor),
    );
  }

  // ---- Notifications ----------------------------------------------------

  notificationOverview(actor: ActorRef): Promise<Result<NotificationOverview>> {
    return this.services.notifications.overview(actor);
  }
  saveNotificationSettings(input: unknown, actor: ActorRef): Promise<Result<NotificationSettings>> {
    return this.services.notifications.saveSettings(input, actor);
  }
  registerPushSubscription(input: unknown, actor: ActorRef): Promise<Result<PushDeviceSummary>> {
    return this.services.notifications.register(input, actor);
  }
  revokePushSubscription(input: unknown, actor: ActorRef): Promise<Result<null>> {
    return this.services.notifications.revoke(input, actor);
  }

  // ---- Cross-cutting ----------------------------------------------------

  async consoleProfile(): Promise<ConsoleProfile> {
    const { branding } = this.services;
    return {
      consoleName: branding.consoleName,
      consoleShortName: branding.consoleShortName,
      replyFromAddress: this.env.SUPPORT_EMAIL,
      defaultSignature: branding.defaultSignature,
      defaultProjectId: branding.defaultProjectId,
    };
  }

  async listActivity(input: unknown): Promise<Result<AuditEntry[]>> {
    const parsed = listAuditInputSchema.safeParse(input ?? {});
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      return ok(await this.services.audit.list(parsed.data, await this.scope()));
    } catch (error) {
      return internalFailure("audit.list", error);
    }
  }

  async getDashboard(): Promise<Result<DashboardSummary>> {
    return this.services.dashboard.summary(await this.scope());
  }

  /**
   * Bytes in and bytes out.
   *
   * Reachable only over a Service Binding — see the class comment. There is no
   * authentication check here for the same reason there is no lock on the
   * inside of a safe: nothing outside the account can address this Worker at
   * all, and adding a shared secret between two Workers in one account would be
   * a second thing to rotate for no additional guarantee.
   */
  async listDeliveryJobs() {
    return this.services.jobs.list(await this.scope());
  }
  async retryDeliveryJob(id: string, actor: ActorRef) {
    const result = await this.services.jobs.retry(id, await this.scope(), actor);
    if (result.ok) this.ctx.waitUntil(this.services.jobs.run(id));
    return result;
  }

  async scheduled(): Promise<void> {
    await this.services.inbound
      .reconcile()
      .catch(() => console.log(JSON.stringify({ event: "delivery.reconcile_failed" })));
    await this.services.jobs
      .drain()
      .catch(() => console.log(JSON.stringify({ event: "delivery.drain_failed" })));
    await this.services.jobs
      .purge()
      .catch(() => console.log(JSON.stringify({ event: "delivery.purge_failed" })));
    await this.services.reports.retryReceipts();
    await this.services.reply.refreshMessageIds();
    await expireReportEvidence(this.env);
    await this.services.notifications.purgeRevoked();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/privacy/backfill" && request.method === "POST") {
      if ((await this.scope()).limited) return json({ error: "FORBIDDEN" }, 403);
      const input = (await request.json()) as { project?: unknown };
      if (typeof input.project !== "string") return json({ error: "INVALID_PROJECT" }, 400);
      return json(await migratePrivateStorage(this.env, input.project), 200);
    }
    const files = new FileStore(privateBucket(this.env.PRIVATE_FILES, privateCipher(this.env)));
    const ref = /\/internal\/reports\/([^/]+)/.exec(url.pathname)?.[1];
    const message = /\/internal\/support\/messages\/([^/]+)/.exec(url.pathname)?.[1];
    const ownerDb = ref
      ? await this.services.registry.forRecord(
          "report",
          decodeURIComponent(ref),
          await this.scope(),
        )
      : message
        ? await this.services.registry.forRecord(
            "message",
            decodeURIComponent(message),
            await this.scope(),
          )
        : null;
    const reports = new ReportRepository(ownerDb ?? this.services.db);
    const support = new SupportRepository(ownerDb ?? this.services.db);

    // Uploads come from intake and mail-ingress; a scoped console only reads.
    if (request.method !== "GET" && (await this.scope()).limited) {
      return json({ error: "NOT_FOUND" }, 404);
    }

    const reportUpload = /^\/internal\/reports\/([^/]+)\/attachments$/.exec(url.pathname);
    if (reportUpload && request.method === "PUT") {
      return await putReportEvidence(
        this.env,
        decodeURIComponent(reportUpload[1] as string),
        request,
      );
    }

    const reportDownload = /^\/internal\/reports\/([^/]+)\/attachments\/([^/]+)$/.exec(
      url.pathname,
    );
    if (reportDownload && request.method === "GET") {
      const scope = await this.scope();
      if (
        !(await scope.report(this.services.db, decodeURIComponent(reportDownload[1] as string)))
      ) {
        return json({ error: "NOT_FOUND" }, 404);
      }
      const attachment = await reports.findAttachment(
        decodeURIComponent(reportDownload[1] as string),
        decodeURIComponent(reportDownload[2] as string),
      );
      if (!attachment) return json({ error: "NOT_FOUND" }, 404);
      if (Date.now() >= Date.parse(attachment.created_at) + 30 * 86400_000) {
        return json({ error: "EXPIRED" }, 410);
      }
      return await stream(
        files,
        attachment.r2_key,
        attachment.content_type,
        attachment.original_filename,
      );
    }

    if (url.pathname === "/internal/mail-ingress/raw" && request.method === "PUT") {
      try {
        const response = await this.services.inbound.store(request);
        if (response.ok) this.ctx.waitUntil(this.services.jobs.drain());
        return response;
      } catch {
        return json({ error: "MAIL_QUEUE_UNAVAILABLE" }, 503);
      }
    }

    const supportUpload = /^\/internal\/support\/messages\/([^/]+)\/attachments$/.exec(
      url.pathname,
    );
    if (supportUpload && request.method === "PUT") {
      const messageId = decodeURIComponent(supportUpload[1] as string);
      const threadId = await support.messageThreadId(messageId);
      if (!threadId) return json({ error: "NOT_FOUND" }, 404);
      const body = await readBounded(request);
      if (!body) return json({ error: "TOO_LARGE" }, 413);

      const attachmentId = newId();
      const key = await namespacedSupportKey(
        this.services.registry,
        messageId,
        threadId,
        attachmentId,
      );
      const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
      const filename = request.headers.get(ATTACHMENT_FILENAME_HEADER) ?? undefined;
      const stored = await files.put(key, body, contentType);

      if (!ownerDb) return json({ error: "NOT_FOUND" }, 404);
      await ownerDb.batch([
        support.attachmentStatement({
          id: attachmentId,
          messageId,
          r2Key: key,
          contentType,
          originalFilename: filename,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
        }),
      ]);
      return json({ attachmentId, sha256: stored.sha256, byteSize: stored.byteSize }, 201);
    }

    const supportDownload = /^\/internal\/support\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(
      url.pathname,
    );
    if (supportDownload && request.method === "GET") {
      const scope = await this.scope();
      if (
        !(await scope.message(this.services.db, decodeURIComponent(supportDownload[1] as string)))
      ) {
        return json({ error: "NOT_FOUND" }, 404);
      }
      const attachment = await support.findAttachment(
        decodeURIComponent(supportDownload[1] as string),
        decodeURIComponent(supportDownload[2] as string),
      );
      if (!attachment) return json({ error: "NOT_FOUND" }, 404);
      return await stream(
        files,
        attachment.r2_key,
        attachment.content_type,
        attachment.original_filename,
      );
    }

    if (url.pathname === "/internal/health") {
      return json({ ok: true, service: "inquiry-platform-api" }, 200);
    }
    return json({ error: "NOT_FOUND" }, 404);
  }
}

function reportIdOf(input: unknown): unknown {
  return (input as { reportId?: unknown } | null)?.reportId;
}

function threadIdOf(input: unknown): unknown {
  return (input as { threadId?: unknown } | null)?.threadId;
}

async function stream(
  files: FileStore,
  key: string,
  contentType: string,
  filename: string | null,
): Promise<Response> {
  const object = await files.get(key);
  if (!object) return json({ error: "NOT_FOUND" }, 404);
  const { contentType: served, disposition } = dispositionFor(contentType, filename ?? undefined);
  return new Response(object.body, {
    headers: {
      "Content-Type": served,
      "Content-Disposition": disposition,
      // Belt and braces on top of the type allowlist: even a file served
      // inline cannot be sniffed into something executable.
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

export { Intake } from "./intake";
export { ProjectOperator } from "./project-operator";
export { AdminCore, sha256Hex };
