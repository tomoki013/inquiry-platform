import type { OperatorDeliveryJob, OperatorDeliveryPage } from "./deliveries";
/**
 * The contract between a project and the platform.
 *
 * Zero dependencies on purpose: this package is what a project copies (or
 * installs) to talk to the platform, and it must not drag the platform's
 * schema or validation library along. The platform validates every field
 * again on its side; these types are the promise, not the enforcement.
 */

/** Every intake call resolves; a failure is data. Matches the platform's own
 * `Result`, so the two are interchangeable across the binding. */
export type IntakeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: IntakeErrorCode; message: string } };

export type IntakeErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATUS_TRANSITION"
  | "STORAGE_ERROR"
  | "MAIL_ERROR"
  | "INTERNAL_ERROR"
  /** Only from the client: no binding in this environment. */
  | "UNAVAILABLE";

/** The four statuses a project (and its users) ever see. The platform keeps a
 * finer set internally; see `toPublicStatus`. */
export type PublicTicketStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

export type PublicTicketType = "contact" | "report" | "bug" | "other";

/** Somebody writing in: a support form, an in-app contact screen. */
export interface ContactSubmission {
  /** The project's slug as registered in the platform. Omitted means "not
   * about any one project" and needs `allowUnassigned` on the binding. */
  projectSlug?: string;
  /** Unique per submission within the project. A retry with the same key
   * returns the first ticket instead of making a second. */
  idempotencyKey: string;
  subject: string;
  message: string;
  /** Where a reply can go. Omitted means the person asked for none. */
  email?: string;
  /** Only what the person typed. Never inferred. */
  name?: string;
  channel: "web_form" | "app";
  /** Widget response when the Project requires Turnstile for this intake. */
  turnstileToken?: string;
}

/**
 * A report about something inside a project.
 *
 * Identify the target by stable internal ids, never by a display name. The
 * platform pseudonymises `reporterId` and `targetOwnerId` before storing them.
 */
export interface ReportSubmission {
  projectSlug: string;
  /** The project's own id for this report. Idempotency key. */
  externalReportId: string;
  /** What kind of thing, in the project's words: `post`, `waitingMemory`. */
  targetType: string;
  targetId?: string;
  targetOwnerId?: string;
  /** The container the target lives in, if any (a group or a conversation, say). */
  contextId?: string;
  /** A slug: `harassment`, `spam`, `inappropriate_content`. */
  reason: string;
  description?: string;
  reporterId?: string;
  reporterEmail?: string;
  /** The reported text as it was at report time. */
  snapshotText?: string;
  /** Evidence will follow through `attachReportEvidence`. */
  evidenceExpected?: boolean;
  /** ISO 8601. Defaults to when the platform receives it. */
  reportedAt?: string;
  priority?: "low" | "normal" | "high";
  /** Widget response when the Project requires Turnstile for this intake. */
  turnstileToken?: string;
}

export interface ContactReceipt {
  /** The operator's number. Sequential: shows how many tickets exist, so
   * show the person `receiptId` instead. */
  ticketNumber: string | null;
  /** Opaque reference for the person who wrote in. A reply quoting
   * `受付ID: <receiptId>` from their address joins this conversation. */
  receiptId: string;
  status: PublicTicketStatus;
  duplicate: boolean;
}

export interface ReportReceipt {
  /** Needed for `attachReportEvidence`. Opaque. */
  reportId: string;
  ticketNumber: string | null;
  status: PublicTicketStatus;
  duplicate: boolean;
}

export interface EvidenceReceipt {
  attachmentId: string;
  sha256: string;
  byteSize: number;
}

/** What the platform's `Intake` entrypoint answers. */
export interface IntakeApi {
  submitContact(input: ContactSubmission): Promise<IntakeResult<ContactReceipt>>;
  submitReport(input: ReportSubmission): Promise<IntakeResult<ReportReceipt>>;
}

/** The Service Binding as a project Worker sees it. `fetch` carries evidence
 * bytes, which do not belong in an RPC argument. */
export type IntakeBinding = IntakeApi & { fetch: typeof fetch };

/**
 * What the binding's `props` must say (in the project's `wrangler.jsonc`).
 * The platform refuses a binding without them.
 */
export interface IntakeProps {
  /** Recorded in the audit log as the acting app. */
  caller: string;
  /** Project slugs this binding may submit for. */
  projects: string[];
  /** Whether a contact without `projectSlug` is accepted. */
  allowUnassigned?: boolean;
}

// ---- Moderation (projects that act on reported content themselves) -------

export interface ModerationRequest {
  reportId: string;
  contentId: string;
  contentType: string;
  reunionId?: string;
  reason: string;
  decision: "delete" | "dismiss";
  actorId: string;
}

export interface ModerationProposal {
  id: string;
  payload: string;
  keyID: string;
  decision: "delete" | "dismiss";
}

/** Implemented by a project that removes reported content itself. */
export interface ModerationAdapter {
  prepare(input: ModerationRequest): Promise<ModerationProposal>;
  complete(id: string, envelope: string): Promise<{ revision: number }>;
}

// ---- Project operator (a project's own console) --------------------------

/**
 * What a `ProjectOperator` binding's `props` must say. The same shape as
 * {@link IntakeProps} without `allowUnassigned`: an operator works on the
 * projects named here and cannot see any other.
 */
export interface ProjectOperatorProps {
  /** Recorded in the audit log as the acting app. */
  caller: string;
  /** Project slugs this binding may operate. */
  projects: string[];
  /** Lets this binding's replies name their own To, Cc and subject
   * (`OperatorReply.to` / `cc` / `subject`). Off unless set: a binding
   * without it gets `FORBIDDEN` for any of them. */
  allowReplyOverrides?: boolean;
}

/** Who, inside the project's own console, did something. An opaque, stable id
 * of the project's choosing (a hashed subject, a user id) — never an address. */
export interface OperatorRef {
  id: string;
}

export type OperatorTicketStatus =
  | "NEW"
  | "TRIAGE"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "WAITING_CUSTOMER"
  | "WAITING_INTERNAL"
  | "RESOLVED"
  | "CLOSED";

export type OperatorResolution =
  | "RESOLVED"
  | "NO_ACTION_REQUIRED"
  | "SPAM"
  | "DUPLICATE"
  | "INVALID"
  | "USER_WITHDREW"
  | "OTHER";

/** Where a project ticket first entered the platform. Reports have no support
 * thread, so they use their own source label. */
export type OperatorTicketSource = "email" | "web_form" | "internal" | "report";

export interface OperatorTicketSummary {
  id: string;
  /** Human-facing, e.g. `TK-000123`. */
  number: string;
  status: OperatorTicketStatus;
  type: PublicTicketType;
  source: OperatorTicketSource;
  resolution: string | null;
  priority: string;
  /** The ticket's heading: for a form submission its topic, for a mail the
   * subject it arrived with. Not necessarily what the mails say — see
   * `mailSubject`. */
  subject: string;
  /** The conversation's mail subject as it stands: that of its latest mail,
   * either way, an operator's own subject included. The next reply goes out as
   * `Re:` this (`previewReply` shows exactly what). For a mail inquiry nothing
   * has been sent on yet, the subject the person wrote; `null` for a form
   * submission before its receipt or first reply, and for a ticket with no
   * conversation. */
  mailSubject: string | null;
  /** Absent when the person asked for no reply. */
  requesterEmail: string | null;
  slaState: "OK" | "AT_RISK" | "BREACHED";
  nextAction: string | null;
  nextActionAt: string | null;
  /** Who took the ticket on: the `OperatorRef.id` of this project's console
   * that last moved it to `ACKNOWLEDGED`. `null` until then, or when it was
   * acknowledged from somewhere else. */
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OperatorTimelineItem =
  | {
      kind: "message";
      id: string;
      /** `note` is internal: never sent, never shown to the person. */
      direction: "inbound" | "outbound" | "note";
      sender: string | null;
      /** Who a mail went to, comma-separated, as the person saw it: the To,
       * then every Cc (with `OperatorReply.ccSelf`, the support address).
       * `null` for a note. */
      recipient: string | null;
      /** The subject the mail actually went out or came in with. `null` for a
       * note, a form submission, and mail recorded before subjects were kept. */
      subject: string | null;
      body: string;
      createdAt: string;
    }
  | {
      kind: "event";
      id: string;
      type: string;
      /** The `OperatorRef.id` that did it, when it was this project's console;
       * `null` for the platform, the person, or anyone else. */
      by: string | null;
      createdAt: string;
    };

export interface OperatorTicketDetail extends OperatorTicketSummary {
  /** What the person was given as their reference: the report's id for a
   * report, otherwise the conversation's. Opaque, unlike `number`. */
  receiptId: string | null;
  /** Optimistic lock: a change names the revision it was based on. */
  revision: number;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Where the platform's state machine allows this ticket to go next. */
  allowedStatuses: OperatorTicketStatus[];
  /** A reply needs a mail thread and an address to send to. */
  canReply: boolean;
  timeline: OperatorTimelineItem[];
  totalTimeline: number;
}

export interface OperatorTicketPage {
  items: OperatorTicketSummary[];
  total: number;
}

export interface OperatorTicketQuery {
  /** `open` is every status that still needs something. */
  status?: OperatorTicketStatus | "open";
  query?: string;
  /** Filter before pagination so a project can keep its inbox to selected
   * intake channels without skipping older tickets from those channels. */
  sources?: OperatorTicketSource[];
  limit?: number;
  offset?: number;
}

export interface OperatorTicketChange {
  revision: number;
  status?: OperatorTicketStatus;
  /** Required when moving to `RESOLVED` or `CLOSED` without one on record. */
  resolution?: OperatorResolution;
  nextAction?: string | null;
  nextActionAt?: string | null;
}

export interface OperatorProject {
  id: string;
  slug: string;
  name: string;
  /** Whether replies can be sent at all in this deployment. */
  mailConfigured: boolean;
  /** The project's own reply signature; empty means the deployment's is used. */
  signature: string;
}

/** A reply template owned by one project. Shared deployment templates are not
 * listed: a project's console only sees and edits its own. */
export interface OperatorReplyTemplate {
  id: string;
  /** Stable handle, lowercase words joined by underscores. Never changes. */
  key: string;
  name: string;
  /** Used only for a ticket with no mail subject of its own (a form submission). */
  subject: string | null;
  /** May contain `{{appName}}`, `{{userName}}`, `{{supportUrl}}` and free
   * placeholders. A reply still containing any `{{...}}` is refused. */
  body: string;
  isActive: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface OperatorTemplateInput {
  key: string;
  name: string;
  subject?: string | null;
  body: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface OperatorTemplateChange {
  name?: string;
  /** `null` clears it, which puts the default subject back. */
  subject?: string | null;
  body?: string;
  isActive?: boolean;
  sortOrder?: number;
}

/** A template rendered against one ticket. The signature is not included: it
 * is added when the reply is sent. */
export interface OperatorAppliedTemplate {
  body: string;
  /** Placeholders still standing. A non-empty list blocks sending. */
  unresolved: string[];
  /** The subject the reply goes out with if this template is named on send. */
  subject: string;
}

export interface OperatorReply {
  body: string;
  idempotencyKey: string;
  reopenIfResolved?: boolean;
  /** The project template the reply was written from, if any. Only its subject
   * is used, and only for a ticket without a mail subject of its own. */
  templateId?: string;
  /** Send the operator a copy of the mail as it went out. The person sees the
   * project's **support address** on Cc — never the operator's private one.
   * That copy comes back through mail-ingress, is recognised as ours, and is
   * forwarded to the operator's address (the project's notification recipient,
   * else the deployment's); it becomes neither a ticket nor a message. Neither
   * address is ever taken from the request. Whether it was added is in the
   * answer's `selfCopy`; no operator address does not stop the reply.
   *
   * Until SDK 0.11.0 this put the operator's own address on the Cc. */
  ccSelf?: boolean;
  /** The To, in place of the person who wrote in. 1–5 addresses. Needs the
   * binding's `allowReplyOverrides`. The support address is refused. */
  to?: string[];
  /** The reply-all Cc, in place of the one the platform works out
   * (`OperatorReplyPreview.cc`); `[]` sends none. Up to 10 addresses. The
   * operator's own copy is still `ccSelf`, added on top. Needs
   * `allowReplyOverrides`. The support address is refused. */
  cc?: string[];
  /** The subject, in place of `OperatorReplyPreview.subject`. At most 200
   * characters, one line. When the platform's subject carries the ticket
   * number (`[TK-000123]`) and this one does not, the number is added at the
   * end, so a reply that loses its headers still finds the ticket. Sent as
   * written — no `Re:` is added — and it becomes the conversation's subject:
   * the next reply is `Re:` this (`OperatorTicketSummary.mailSubject`). Needs
   * `allowReplyOverrides`. */
  subject?: string;
}

/** What a reply would go out with, if sent now without overrides. */
export interface OperatorReplyPreview {
  /** `Name <address>`. Not overridable. */
  from: string;
  /** The person who wrote in. */
  to: string[];
  /** Reply-all: everybody else on the person's latest mail. */
  cc: string[];
  /** The operator's copy (`OperatorReply.ccSelf`) and what asking for it would
   * do. `cc` is what the person would see added to the Cc — the support
   * address — and `forwardTo` where the copy then goes, which they never see.
   * `address` is the same as `forwardTo`, kept from the earlier shape. All
   * three are `null` when no operator address is configured. */
  self: {
    cc: string | null;
    forwardTo: string | null;
    address: string | null;
    outcome: OperatorSelfCopy;
  };
  subject: string;
  /** Whether this binding may send `to` / `cc` / `subject`. */
  overridesAllowed: boolean;
}

/** What became of `OperatorReply.ccSelf`.
 * - `copied`: the support address is on the Cc, and its copy is forwarded to
 *   the operator.
 * - `not_configured`: there is no operator address; the reply went without it.
 * - `is_recipient`: the operator's address is on the To or Cc already, so it
 *   receives the mail anyway; nothing was added. */
export type OperatorSelfCopy = "copied" | "not_configured" | "is_recipient";

/** The ticket after a reply. `selfCopy` is present only when the reply asked
 * for `ccSelf` and was sent by this call (a retried `idempotencyKey` answers
 * the ticket as it stands, without it). */
export interface OperatorReplyResult extends OperatorTicketDetail {
  selfCopy?: OperatorSelfCopy;
}

/**
 * What the platform's `ProjectOperator` entrypoint answers: a project's own
 * console working its own tickets. Every call names the project, the binding's
 * `props` decide whether it may, and a ticket of any other project answers
 * `NOT_FOUND` exactly as a missing one does.
 */
export interface ProjectOperatorApi {
  listDeliveryJobs(projectSlug: string): Promise<IntakeResult<OperatorDeliveryPage>>;
  retryDeliveryJob(
    projectSlug: string,
    jobId: string,
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorDeliveryJob>>;
  project(projectSlug: string): Promise<IntakeResult<OperatorProject>>;
  listTickets(
    projectSlug: string,
    query?: OperatorTicketQuery,
  ): Promise<IntakeResult<OperatorTicketPage>>;
  /** `ref` is a ticket id or its number (`TK-000123`), as a notification link carries. */
  getTicket(
    projectSlug: string,
    ref: string,
    offset?: number,
  ): Promise<IntakeResult<OperatorTicketDetail>>;
  changeTicket(
    projectSlug: string,
    ticketId: string,
    change: OperatorTicketChange,
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorTicketDetail>>;
  addNote(
    projectSlug: string,
    ticketId: string,
    note: { body: string; idempotencyKey: string },
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorTicketDetail>>;
  /** The From, To, Cc and subject a reply to this ticket would get.
   * `templateId` is the template the reply is written from, which may choose
   * the subject of a ticket with no mail subject of its own. */
  previewReply(
    projectSlug: string,
    ticketId: string,
    options?: { templateId?: string },
  ): Promise<IntakeResult<OperatorReplyPreview>>;
  /** Mails the person who wrote in. Recipient, sender and subject are decided
   * by the platform from the ticket's thread, unless the binding allows
   * overrides and the reply names its own `to` / `cc` / `subject`. */
  reply(
    projectSlug: string,
    ticketId: string,
    reply: OperatorReply,
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorReplyResult>>;
  setSignature(
    projectSlug: string,
    signature: string,
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorProject>>;
  listTemplates(
    projectSlug: string,
    options?: { includeInactive?: boolean },
  ): Promise<IntakeResult<OperatorReplyTemplate[]>>;
  createTemplate(
    projectSlug: string,
    input: OperatorTemplateInput,
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorReplyTemplate>>;
  updateTemplate(
    projectSlug: string,
    templateId: string,
    change: OperatorTemplateChange,
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorReplyTemplate>>;
  /** Renders a project template against a ticket: `{{userName}}` from the name
   * the person typed, `{{appName}}` and `{{supportUrl}}` from the project. */
  applyTemplate(
    projectSlug: string,
    ticketRef: string,
    templateId: string,
  ): Promise<IntakeResult<OperatorAppliedTemplate>>;
}
