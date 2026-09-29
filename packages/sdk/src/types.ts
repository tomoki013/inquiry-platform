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
}

export interface ContactReceipt {
  /** Human-facing number, safe to show the person as a reference. */
  ticketNumber: string | null;
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

export interface OperatorTicketSummary {
  id: string;
  /** Human-facing, e.g. `TK-000123`. */
  number: string;
  status: OperatorTicketStatus;
  resolution: string | null;
  priority: string;
  subject: string;
  /** Absent when the person asked for no reply. */
  requesterEmail: string | null;
  slaState: "OK" | "AT_RISK" | "BREACHED";
  nextAction: string | null;
  nextActionAt: string | null;
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
      body: string;
      createdAt: string;
    }
  | { kind: "event"; id: string; type: string; createdAt: string };

export interface OperatorTicketDetail extends OperatorTicketSummary {
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

/**
 * What the platform's `ProjectOperator` entrypoint answers: a project's own
 * console working its own tickets. Every call names the project, the binding's
 * `props` decide whether it may, and a ticket of any other project answers
 * `NOT_FOUND` exactly as a missing one does.
 */
export interface ProjectOperatorApi {
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
  /** Mails the person who wrote in. Only a body goes up: recipient, sender and
   * subject are decided by the platform from the ticket's thread. */
  reply(
    projectSlug: string,
    ticketId: string,
    reply: { body: string; idempotencyKey: string; reopenIfResolved?: boolean },
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorTicketDetail>>;
  setSignature(
    projectSlug: string,
    signature: string,
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorProject>>;
}
