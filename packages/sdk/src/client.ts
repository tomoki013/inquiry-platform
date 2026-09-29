import type {
  ContactReceipt,
  ContactSubmission,
  EvidenceReceipt,
  IntakeBinding,
  IntakeResult,
  OperatorProject,
  OperatorRef,
  OperatorTicketChange,
  OperatorTicketDetail,
  OperatorTicketPage,
  OperatorTicketQuery,
  ProjectOperatorApi,
  ReportReceipt,
  ReportSubmission,
} from "./types";

/** Path on the `Intake` entrypoint's `fetch` for report evidence. Never
 * resolved by DNS: the Service Binding delivers it. */
export function reportEvidencePath(reportId: string): string {
  return `/internal/reports/${encodeURIComponent(reportId)}/attachments`;
}
const ORIGIN = "https://intake.internal";

export interface Evidence {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  filename?: string;
  /** When the evidence was captured, ISO 8601. The platform refuses evidence
   * older than its retention window. */
  createdAt?: string;
}

export interface InquiryClient {
  createContact(input: ContactSubmission): Promise<IntakeResult<ContactReceipt>>;
  createReport(input: ReportSubmission): Promise<IntakeResult<ReportReceipt>>;
  attachReportEvidence(
    reportId: string,
    evidence: Evidence,
  ): Promise<IntakeResult<EvidenceReceipt>>;
}

/**
 * A project's handle on the platform.
 *
 * @param binding The Service Binding to the platform's `Intake` entrypoint,
 * or `undefined` in an environment without one — every call then resolves to
 * `UNAVAILABLE` rather than throwing, so a route can answer 502 plainly.
 */
export function createInquiryClient(binding: IntakeBinding | undefined): InquiryClient {
  const unavailable = {
    ok: false as const,
    error: { code: "UNAVAILABLE" as const, message: "The inquiry platform is not bound." },
  };
  return {
    async createContact(input) {
      if (!binding) return unavailable;
      return await binding.submitContact(input);
    },
    async createReport(input) {
      if (!binding) return unavailable;
      return await binding.submitReport(input);
    },
    async attachReportEvidence(reportId, evidence) {
      if (!binding) return unavailable;
      const response = await binding.fetch(`${ORIGIN}${reportEvidencePath(reportId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": evidence.contentType,
          "Content-Length": String(evidence.bytes.byteLength),
          "X-Attachment-Filename": evidence.filename ?? "evidence",
          ...(evidence.createdAt ? { "X-Evidence-Created-At": evidence.createdAt } : {}),
        },
        body: evidence.bytes,
      });
      if (response.ok) return { ok: true, value: (await response.json()) as EvidenceReceipt };
      const code =
        response.status === 403
          ? "FORBIDDEN"
          : response.status === 404
            ? "NOT_FOUND"
            : response.status >= 500
              ? "STORAGE_ERROR"
              : "VALIDATION_ERROR";
      return { ok: false, error: { code, message: `Evidence was refused (${response.status}).` } };
    },
  };
}

/** A project's handle on its own tickets, bound to one project slug. */
export interface ProjectOperatorClient {
  project(): Promise<IntakeResult<OperatorProject>>;
  listTickets(query?: OperatorTicketQuery): Promise<IntakeResult<OperatorTicketPage>>;
  getTicket(ref: string, offset?: number): Promise<IntakeResult<OperatorTicketDetail>>;
  changeTicket(
    ticketId: string,
    change: OperatorTicketChange,
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorTicketDetail>>;
  addNote(
    ticketId: string,
    note: { body: string; idempotencyKey: string },
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorTicketDetail>>;
  reply(
    ticketId: string,
    reply: { body: string; idempotencyKey: string; reopenIfResolved?: boolean },
    operator: OperatorRef,
  ): Promise<IntakeResult<OperatorTicketDetail>>;
  setSignature(signature: string, operator: OperatorRef): Promise<IntakeResult<OperatorProject>>;
}

/**
 * @param binding The Service Binding to the platform's `ProjectOperator`
 * entrypoint, or `undefined` where there is none — every call then resolves
 * to `UNAVAILABLE` rather than throwing.
 */
export function createProjectOperatorClient(
  binding: ProjectOperatorApi | undefined,
  projectSlug: string,
): ProjectOperatorClient {
  const unavailable = {
    ok: false as const,
    error: { code: "UNAVAILABLE" as const, message: "The inquiry platform is not bound." },
  };
  const call = async <T>(
    run: (api: ProjectOperatorApi) => Promise<IntakeResult<T>>,
  ): Promise<IntakeResult<T>> => (binding ? await run(binding) : unavailable);
  return {
    project: () => call((api) => api.project(projectSlug)),
    listTickets: (query) => call((api) => api.listTickets(projectSlug, query)),
    getTicket: (ref, offset) => call((api) => api.getTicket(projectSlug, ref, offset)),
    changeTicket: (ticketId, change, operator) =>
      call((api) => api.changeTicket(projectSlug, ticketId, change, operator)),
    addNote: (ticketId, note, operator) =>
      call((api) => api.addNote(projectSlug, ticketId, note, operator)),
    reply: (ticketId, reply, operator) =>
      call((api) => api.reply(projectSlug, ticketId, reply, operator)),
    setSignature: (signature, operator) =>
      call((api) => api.setSignature(projectSlug, signature, operator)),
  };
}
