import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActorRef,
  AdminCoreApi,
  AppDetail,
  AppliedTemplate,
  AppMailSettings,
  AppSummary,
  AuditEntry,
  CreateReportResult,
  DashboardSummary,
  IngestInboundEmailResult,
  ReplyTemplate,
  ReportDetail,
  ReportListPage,
  Result,
  SupportDraft,
  SupportThreadDetail,
  SupportThreadListPage,
} from "@tomokichi/admin-contracts";
import {
  ATTACHMENT_FILENAME_HEADER,
  listAuditInputSchema,
  MAX_ATTACHMENT_BYTES,
  newId,
  ok,
} from "@tomokichi/admin-contracts";
import type { MailProvider } from "@tomokichi/admin-mail";
import { ResendMailProvider, UnconfiguredMailProvider } from "@tomokichi/admin-mail";
import { AppRepository } from "./db/apps";
import { AuditRepository } from "./db/audit";
import { dispositionFor, FileStore } from "./db/files";
import { ReportRepository } from "./db/reports";
import { SupportRepository } from "./db/support";
import { TemplateRepository } from "./db/templates";
import { AppService } from "./domain/app-service";
import { DashboardService } from "./domain/dashboard-service";
import { internalFailure, validationFailure } from "./domain/failures";
import { sha256Hex } from "./domain/identity";
import { ReplyService } from "./domain/reply-service";
import { expireReportEvidence } from "./domain/report-retention";
import { ReportService } from "./domain/report-service";
import { SupportService } from "./domain/support-service";
import { TicketService } from "./domain/ticket-service";
import type { AdminCoreEnv } from "./env";

/**
 * Tomokichi Studio Admin Core.
 *
 * Not on the internet. `workers_dev` is off and there is no route, so the only
 * ways to reach this Worker are the Service Bindings declared by Admin Web, the
 * mail Worker and `tomokichi-api`. That is what lets the D1 and R2 bindings
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
 */
export default class AdminCore extends WorkerEntrypoint<AdminCoreEnv> implements AdminCoreApi {
  private cached?: ReturnType<typeof buildServices>;

  private get services() {
    this.cached ??= buildServices(this.env);
    return this.cached;
  }

  async ticketReplyContext(id: string): Promise<Result<SupportThreadDetail>> {
    try {
      const ticket = await this.tickets.row(id);
      if (!ticket?.thread_id)
        return { ok: false, error: { code: "NOT_FOUND", message: "メール会話がありません。" } };
      const thread = await new SupportRepository(this.env.DB).detail(ticket.thread_id, false);
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
    return new TicketService(this.env.DB);
  }
  listTickets(input: unknown) {
    return this.tickets.list(input);
  }
  getTicket(id: string, offset = 0) {
    return this.tickets.detail(id, offset);
  }
  ticketSource(kind: string, id: string) {
    return this.tickets.source(kind, id);
  }
  createTicket(input: unknown, actor: ActorRef) {
    return this.tickets.create(input, actor);
  }
  changeTicket(input: unknown, actor: ActorRef) {
    return this.tickets.change(input, actor);
  }
  acknowledgeTicket(id: string, actor: ActorRef) {
    return this.tickets.ack(id, actor);
  }
  addTicketNote(input: unknown, actor: ActorRef) {
    return this.tickets.note(input, actor);
  }
  relateTickets(input: unknown, actor: ActorRef) {
    return this.tickets.relation(input, actor);
  }
  mergeTickets(input: unknown, actor: ActorRef) {
    return this.tickets.merge(input, actor);
  }
  ticketMasters() {
    return this.tickets.masters();
  }
  saveTicketMaster(input: unknown, actor: ActorRef) {
    return this.tickets.saveMaster(input, actor);
  }
  ticketDashboard() {
    return this.tickets.dashboard();
  }

  prepareReportDecision(input: unknown, actor: ActorRef) {
    return this.services.reports.prepareDecision(input, actor);
  }
  completeReportDecision(input: unknown, actor: ActorRef) {
    return this.services.reports.completeDecision(input, actor);
  }

  // ---- Reports ----------------------------------------------------------

  createReport(input: unknown, actor: ActorRef): Promise<Result<CreateReportResult>> {
    return this.services.reports.create(input, actor);
  }
  listReports(input: unknown): Promise<Result<ReportListPage>> {
    return this.services.reports.list(input);
  }
  getReport(reportId: string): Promise<Result<ReportDetail>> {
    return this.services.reports.detail(reportId);
  }
  changeReportStatus(input: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    return this.services.reports.changeStatus(input, actor);
  }
  addReportNote(input: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    return this.services.reports.addNote(input, actor);
  }
  updateReportResolution(input: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    return this.services.reports.updateResolution(input, actor);
  }

  // ---- Support ----------------------------------------------------------

  async ingestInboundEmail(
    input: unknown,
    actor: ActorRef,
  ): Promise<Result<IngestInboundEmailResult>> {
    await this.services.reply.refreshMessageIds();
    return this.services.support.ingestInboundEmail(input, actor);
  }
  createSupportThread(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.services.support.createThread(input, actor);
  }
  addSupportMessage(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.services.support.addMessage(input, actor);
  }
  listSupportThreads(input: unknown): Promise<Result<SupportThreadListPage>> {
    return this.services.support.list(input);
  }
  getSupportThread(threadId: string): Promise<Result<SupportThreadDetail>> {
    return this.services.support.detail(threadId);
  }
  setSupportStatus(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.services.support.setStatus(input, actor);
  }
  assignSupportApp(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.services.support.assignApp(input, actor);
  }
  /** Routed to the service that has no mail provider. See `SupportService`. */
  addInternalNote(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.services.support.addInternalNote(input, actor);
  }
  sendSupportReply(input: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    return this.services.reply.send(input, actor);
  }
  mailProviderConfigured(): Promise<boolean> {
    return Promise.resolve(this.services.reply.mailConfigured);
  }

  // ---- Drafts and templates ---------------------------------------------

  getSupportDraft(threadId: string): Promise<Result<SupportDraft | null>> {
    return this.services.reply.getDraft(threadId);
  }
  saveSupportDraft(input: unknown): Promise<Result<SupportDraft>> {
    return this.services.reply.saveDraft(input);
  }
  deleteSupportDraft(threadId: string): Promise<Result<null>> {
    return this.services.reply.deleteDraft(threadId);
  }
  listReplyTemplates(input: unknown): Promise<Result<ReplyTemplate[]>> {
    return this.services.reply.listTemplates(input);
  }
  getReplyTemplate(templateId: string): Promise<Result<ReplyTemplate>> {
    return this.services.reply.getTemplate(templateId);
  }
  createReplyTemplate(input: unknown, actor: ActorRef): Promise<Result<ReplyTemplate>> {
    return this.services.reply.createTemplate(input, actor);
  }
  updateReplyTemplate(
    templateId: string,
    input: unknown,
    actor: ActorRef,
  ): Promise<Result<ReplyTemplate>> {
    return this.services.reply.updateTemplate(templateId, input, actor);
  }
  deactivateReplyTemplate(templateId: string, actor: ActorRef): Promise<Result<ReplyTemplate>> {
    return this.services.reply.deactivateTemplate(templateId, actor);
  }
  applyReplyTemplate(input: unknown): Promise<Result<AppliedTemplate>> {
    return this.services.reply.applyTemplate(input);
  }
  listAppMailSettings(): Promise<Result<AppMailSettings[]>> {
    return this.services.reply.listSettings();
  }
  setAppMailSettings(input: unknown, actor: ActorRef): Promise<Result<AppMailSettings>> {
    return this.services.reply.setSettings(input, actor);
  }

  // ---- Apps -------------------------------------------------------------

  listApps(input: unknown): Promise<Result<AppSummary[]>> {
    return this.services.apps.list(input);
  }
  getApp(appId: string): Promise<Result<AppDetail>> {
    return this.services.apps.detail(appId);
  }
  createApp(input: unknown, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.services.apps.create(input, actor);
  }
  updateApp(appId: string, input: unknown, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.services.apps.update(appId, input, actor);
  }
  archiveApp(appId: string, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.services.apps.setArchived(appId, true, actor);
  }
  restoreApp(appId: string, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.services.apps.setArchived(appId, false, actor);
  }
  addAppLink(input: unknown, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.services.apps.addLink(input, actor);
  }
  removeAppLink(linkId: string, actor: ActorRef): Promise<Result<AppDetail>> {
    return this.services.apps.removeLink(linkId, actor);
  }

  // ---- Cross-cutting ----------------------------------------------------

  async listActivity(input: unknown): Promise<Result<AuditEntry[]>> {
    const parsed = listAuditInputSchema.safeParse(input ?? {});
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      return ok(await this.services.audit.list(parsed.data));
    } catch (error) {
      return internalFailure("audit.list", error);
    }
  }

  getDashboard(): Promise<Result<DashboardSummary>> {
    return this.services.dashboard.summary();
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
  async scheduled(): Promise<void> {
    await this.services.reports.retryReceipts();
    await this.services.reply.refreshMessageIds();
    await expireReportEvidence(this.env);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const files = new FileStore(this.env.PRIVATE_FILES);
    const reports = new ReportRepository(this.env.DB);
    const support = new SupportRepository(this.env.DB);

    const reportUpload = /^\/internal\/reports\/([^/]+)\/attachments$/.exec(url.pathname);
    if (reportUpload && request.method === "PUT") {
      const reportId = decodeURIComponent(reportUpload[1] as string);
      if (!(await reports.findRow(reportId))) return json({ error: "NOT_FOUND" }, 404);
      const body = await readBounded(request);
      if (!body) return json({ error: "TOO_LARGE" }, 413);

      const suppliedDate = request.headers.get("X-Evidence-Created-At");
      const created = suppliedDate ? Date.parse(suppliedDate) : Date.now();
      if (!Number.isFinite(created) || created > Date.now())
        return json({ error: "INVALID_DATE" }, 400);
      if (Date.now() >= created + 30 * 86400_000) return json({ error: "EXPIRED" }, 410);
      const attachmentId = await sha256Hex(
        new TextEncoder().encode(`${reportId}:${await sha256Hex(body)}`),
      );
      const existing = await reports.findAttachment(reportId, attachmentId);
      if (existing)
        return json({ attachmentId, sha256: existing.sha256, byteSize: existing.byte_size }, 200);
      const key = FileStore.reportKey(reportId, attachmentId);
      const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
      const filename = request.headers.get(ATTACHMENT_FILENAME_HEADER) ?? undefined;
      const stored = await files.put(key, body, contentType);

      await this.env.DB.batch([
        reports.attachmentStatement({
          id: attachmentId,
          reportId,
          r2Key: key,
          contentType,
          originalFilename: filename,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          createdAt: new Date(created).toISOString(),
        }),
        reports.eventStatement({ reportId, eventType: "attachment_added" }),
      ]);
      return json({ attachmentId, sha256: stored.sha256, byteSize: stored.byteSize }, 201);
    }

    const reportDownload = /^\/internal\/reports\/([^/]+)\/attachments\/([^/]+)$/.exec(
      url.pathname,
    );
    if (reportDownload && request.method === "GET") {
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
      const key = FileStore.supportKey(threadId, messageId, attachmentId);
      const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
      const filename = request.headers.get(ATTACHMENT_FILENAME_HEADER) ?? undefined;
      const stored = await files.put(key, body, contentType);

      await this.env.DB.batch([
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
      return json({ ok: true, service: "tomokichi-admin-core" }, 200);
    }
    return json({ error: "NOT_FOUND" }, 404);
  }
}

function buildServices(env: AdminCoreEnv) {
  const apps = new AppRepository(env.DB);
  const reports = new ReportRepository(env.DB);
  const support = new SupportRepository(env.DB);
  const templates = new TemplateRepository(env.DB);
  const audit = new AuditRepository(env.DB);

  // One decision, made once: with no key, every send refuses and every other
  // part of the support screen still works.
  const mail: MailProvider = env.MAIL_API_KEY
    ? new ResendMailProvider(env.MAIL_API_KEY)
    : new UnconfiguredMailProvider();

  const supportService = new SupportService(env.DB, support, apps, audit);

  const replyService = new ReplyService(
    env.DB,
    support,
    supportService,
    templates,
    apps,
    audit,
    mail,
    {
      supportEmail: env.SUPPORT_EMAIL,
      fromName: env.SUPPORT_FROM_NAME,
      defaultSupportUrl: env.DEFAULT_SUPPORT_URL,
    },
  );

  return {
    apps: new AppService(env.DB, apps, audit),
    reports: new ReportService(
      env.DB,
      reports,
      apps,
      audit,
      env.HASH_PEPPER,
      support,
      replyService,
      env.REMEET_MODERATION,
    ),
    support: supportService,
    reply: replyService,
    dashboard: new DashboardService(reports, support, apps, audit),
    audit,
  };
}

/** Reads the body only if it is small enough, so an oversized upload cannot be
 * buffered into memory before being rejected. */
async function readBounded(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_ATTACHMENT_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > MAX_ATTACHMENT_BYTES ? null : bytes;
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

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export { AdminCore, sha256Hex };
