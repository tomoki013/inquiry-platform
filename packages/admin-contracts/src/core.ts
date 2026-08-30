import type {
  AppDetail,
  AppSummary,
  CreateAppInput,
  CreateAppLinkInput,
  ListAppsInput,
  UpdateAppInput,
} from "./apps";
import type { AuditActorType, AuditEntry, ListAuditInput } from "./audit";
import type { DashboardSummary } from "./dashboard";
import type { Result } from "./errors";
import type {
  AppliedTemplate,
  ApplyTemplateInput,
  AppMailSettings,
  CreateReplyTemplateInput,
  ListReplyTemplatesInput,
  ReplyTemplate,
  SaveSupportDraftInput,
  SendSupportReplyInput,
  SetAppMailSettingsInput,
  SupportDraft,
  UpdateReplyTemplateInput,
} from "./reply";
import type {
  AddReportNoteInput,
  ChangeReportStatusInput,
  CreateReportInput,
  CreateReportResult,
  ListReportsInput,
  ReportDetail,
  ReportListPage,
  UpdateReportResolutionInput,
} from "./reports";
import type {
  AssignSupportAppInput,
  CreateSupportMessageInput,
  CreateSupportThreadInput,
  IngestInboundEmailInput,
  IngestInboundEmailResult,
  ListSupportThreadsInput,
  ReplySupportInput,
  SetSupportStatusInput,
  SupportThreadDetail,
  SupportThreadListPage,
} from "./support";

/**
 * Who is acting, as far as the audit log is concerned.
 *
 * Not a Cloudflare Access JWT and not an email address: Admin Web converts the
 * one into the other at its edge (`worker/identity.ts`) so that nothing below
 * that line knows what the identity provider is. Swapping Cloudflare for Google
 * Workspace changes that one file.
 */
export interface ActorRef {
  type: AuditActorType;
  /** Stable, opaque, and safe to keep forever — a subject id, a worker name.
   * Not a full address. */
  id?: string;
}

/** The single role Phase 1–3 has. The shape is a union already so that adding
 * `support` or `viewer` later is a change to this line and to the checks, not
 * to every call site. */
export type AdminRole = "owner";

export interface AdminIdentity {
  id: string;
  email?: string;
  role: AdminRole;
}

/**
 * Everything Admin Core will do for a caller.
 *
 * This interface *is* the boundary: no caller sees the D1 schema, and changing
 * a column is a change inside Admin Core alone. Every method resolves rather
 * than throws — see `errors.ts` for why.
 */
export interface AdminCoreApi {
  // ---- Reports ----------------------------------------------------------
  createReport(input: CreateReportInput, actor: ActorRef): Promise<Result<CreateReportResult>>;
  listReports(input: ListReportsInput): Promise<Result<ReportListPage>>;
  getReport(reportId: string): Promise<Result<ReportDetail>>;
  changeReportStatus(
    input: ChangeReportStatusInput,
    actor: ActorRef,
  ): Promise<Result<ReportDetail>>;
  addReportNote(input: AddReportNoteInput, actor: ActorRef): Promise<Result<ReportDetail>>;
  updateReportResolution(
    input: UpdateReportResolutionInput,
    actor: ActorRef,
  ): Promise<Result<ReportDetail>>;

  // ---- Support ----------------------------------------------------------
  ingestInboundEmail(
    input: IngestInboundEmailInput,
    actor: ActorRef,
  ): Promise<Result<IngestInboundEmailResult>>;
  createSupportThread(
    input: CreateSupportThreadInput,
    actor: ActorRef,
  ): Promise<Result<SupportThreadDetail>>;
  addSupportMessage(
    input: CreateSupportMessageInput,
    actor: ActorRef,
  ): Promise<Result<SupportThreadDetail>>;
  listSupportThreads(input: ListSupportThreadsInput): Promise<Result<SupportThreadListPage>>;
  getSupportThread(threadId: string): Promise<Result<SupportThreadDetail>>;
  setSupportStatus(
    input: SetSupportStatusInput,
    actor: ActorRef,
  ): Promise<Result<SupportThreadDetail>>;
  assignSupportApp(
    input: AssignSupportAppInput,
    actor: ActorRef,
  ): Promise<Result<SupportThreadDetail>>;
  /**
   * Sends a reply, and only then writes the outbound message and deletes the
   * draft. Fails with `MAIL_ERROR` when no provider is configured — the caller
   * disables the button rather than pretending the mail went.
   *
   * There is no `internal` flag here and there never will be. A private note
   * goes through {@link addInternalNote}, which cannot reach the mail provider
   * because it does not have it.
   */
  sendSupportReply(
    input: SendSupportReplyInput,
    actor: ActorRef,
  ): Promise<Result<SupportThreadDetail>>;
  /** Writes an `internal_note` message. Never sends anything. */
  addInternalNote(input: ReplySupportInput, actor: ActorRef): Promise<Result<SupportThreadDetail>>;
  /** Whether {@link sendSupportReply} can work at all in this environment. */
  mailProviderConfigured(): Promise<boolean>;

  // ---- Reply drafts and templates ---------------------------------------
  getSupportDraft(threadId: string): Promise<Result<SupportDraft | null>>;
  /** Autosaved, and deliberately not audited: a log line per debounced
   * keystroke would bury the entries that matter. The send is audited. */
  saveSupportDraft(input: SaveSupportDraftInput): Promise<Result<SupportDraft>>;
  deleteSupportDraft(threadId: string): Promise<Result<null>>;

  listReplyTemplates(input: ListReplyTemplatesInput): Promise<Result<ReplyTemplate[]>>;
  getReplyTemplate(templateId: string): Promise<Result<ReplyTemplate>>;
  createReplyTemplate(
    input: CreateReplyTemplateInput,
    actor: ActorRef,
  ): Promise<Result<ReplyTemplate>>;
  updateReplyTemplate(
    templateId: string,
    input: UpdateReplyTemplateInput,
    actor: ActorRef,
  ): Promise<Result<ReplyTemplate>>;
  deactivateReplyTemplate(templateId: string, actor: ActorRef): Promise<Result<ReplyTemplate>>;
  /** Renders a template against a thread. Does not send and does not touch the
   * draft — the composer puts the text in the box and a person decides. */
  applyReplyTemplate(input: ApplyTemplateInput): Promise<Result<AppliedTemplate>>;

  listAppMailSettings(): Promise<Result<AppMailSettings[]>>;
  setAppMailSettings(
    input: SetAppMailSettingsInput,
    actor: ActorRef,
  ): Promise<Result<AppMailSettings>>;

  // ---- Apps -------------------------------------------------------------
  listApps(input: ListAppsInput): Promise<Result<AppSummary[]>>;
  getApp(appId: string): Promise<Result<AppDetail>>;
  createApp(input: CreateAppInput, actor: ActorRef): Promise<Result<AppDetail>>;
  updateApp(appId: string, input: UpdateAppInput, actor: ActorRef): Promise<Result<AppDetail>>;
  archiveApp(appId: string, actor: ActorRef): Promise<Result<AppDetail>>;
  restoreApp(appId: string, actor: ActorRef): Promise<Result<AppDetail>>;
  addAppLink(input: CreateAppLinkInput, actor: ActorRef): Promise<Result<AppDetail>>;
  removeAppLink(linkId: string, actor: ActorRef): Promise<Result<AppDetail>>;

  // ---- Cross-cutting ----------------------------------------------------
  listActivity(input: ListAuditInput): Promise<Result<AuditEntry[]>>;
  getDashboard(): Promise<Result<DashboardSummary>>;
}

/**
 * How a caller sees the Admin Core binding.
 *
 * Deliberately the interface rather than Cloudflare's `Service<typeof AdminCore>`:
 * that helper needs the concrete class, which would make every calling Worker
 * import Admin Core's source and, with it, its D1 schema. The point of this
 * package is that they do not. What crosses the binding is exactly
 * {@link AdminCoreApi} plus a `fetch` for bytes.
 */
export type AdminCoreStub = AdminCoreApi & { fetch: typeof fetch };

/**
 * Paths on Admin Core's `fetch()` handler.
 *
 * Only bytes go over HTTP: RPC cannot stream a ten-megabyte photo, and
 * base64-in-JSON is exactly what the Remeet report route already refuses to do.
 * None of these is reachable from the internet — Admin Core has no route and no
 * `workers.dev` in production, so the only way in is a Service Binding.
 */
export const INTERNAL_PATHS = {
  reportAttachment: (reportId: string, attachmentId?: string) =>
    attachmentId
      ? `/internal/reports/${encodeURIComponent(reportId)}/attachments/${encodeURIComponent(attachmentId)}`
      : `/internal/reports/${encodeURIComponent(reportId)}/attachments`,
  supportAttachment: (messageId: string, attachmentId?: string) =>
    attachmentId
      ? `/internal/support/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
      : `/internal/support/messages/${encodeURIComponent(messageId)}/attachments`,
} as const;

/** Origin for internal `fetch()` calls over a Service Binding. Never resolved
 * by DNS; the binding delivers the request directly to the Worker. */
export const INTERNAL_ORIGIN = "https://admin-core.internal";

export const ATTACHMENT_FILENAME_HEADER = "X-Attachment-Filename";
/** One report photo, matching what Remeet already accepts. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
