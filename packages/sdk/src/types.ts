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
  /** The container the target lives in, if any (a Remeet reunion, say). */
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
