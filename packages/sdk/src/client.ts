import type {
  ContactReceipt,
  ContactSubmission,
  EvidenceReceipt,
  IntakeBinding,
  IntakeResult,
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
