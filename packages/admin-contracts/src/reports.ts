import { z } from "zod";

/**
 * Content reports, from any Studio app.
 *
 * The vocabulary here is deliberately wider than Remeet's: `reasonCode` and
 * `contentType` are validated as slugs rather than against Remeet's own enums,
 * because Colorvia and Yohaku will report different things and a shared table
 * that only accepts one app's words is a table the next app cannot use. The
 * app's own backend is where its enum is enforced.
 */
export const reportStatuses = ["open", "reviewing", "actioned", "closed"] as const;
export type ReportStatus = (typeof reportStatuses)[number];

export const reportPriorities = ["low", "normal", "high"] as const;
export type ReportPriority = (typeof reportPriorities)[number];

/**
 * Which moves are legal.
 *
 * `actioned` means *the operator recorded what they did*, not that anything was
 * deleted from the app — the two are different facts and conflating them would
 * make the log claim something nobody verified. `closed → reviewing` exists so
 * a report can be looked at again without inventing a fifth status.
 */
export const allowedReportTransitions: Record<ReportStatus, readonly ReportStatus[]> = {
  open: ["reviewing", "closed"],
  reviewing: ["actioned", "closed"],
  actioned: ["closed"],
  closed: ["reviewing"],
};

export function canTransitionReport(from: ReportStatus, to: ReportStatus): boolean {
  return allowedReportTransitions[from].includes(to);
}

export const reportEventTypes = [
  "created",
  "status_changed",
  "note_added",
  "attachment_added",
  "resolution_updated",
  "reopened",
] as const;
export type ReportEventType = (typeof reportEventTypes)[number];

const slugish = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "letters, digits, hyphen and underscore only");

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => {
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    })
    .optional();

/** Room for one long piece of writing, and no more. Anything past this is not a
 * report, it is somebody pasting a file into the endpoint. */
export const SNAPSHOT_LIMIT = 8000;
export const DETAIL_LIMIT = 2000;
export const NOTE_LIMIT = 4000;
export const RESOLUTION_NOTE_LIMIT = 2000;

export const createReportInputSchema = z.object({
  /** Slug, not id: the calling backend knows what it is called, not what row
   * Admin gave it. */
  appSlug: z.string().min(1).max(64),
  /** The id the reporting app minted. Unique — see `createReport`. */
  externalReportId: z.string().trim().min(1).max(200),
  /** The app's own container for the reported thing (a Remeet reunion, say).
   * Opaque here. */
  contextExternalId: optionalText(200),
  contentType: slugish,
  contentExternalId: optionalText(200),
  /** Already pseudonymised by the caller where it can be — see
   * `pseudonymise()` in Admin Core, which the app backends use. */
  reporterRefHash: optionalText(128),
  authorRefHash: optionalText(128),
  reasonCode: slugish,
  detail: optionalText(DETAIL_LIMIT),
  snapshotText: optionalText(SNAPSHOT_LIMIT),
  priority: z.enum(reportPriorities).default("normal"),
  /** When the person pressed the button, not when this row was written. */
  reportedAt: z.iso.datetime().optional(),
});
export type CreateReportInput = z.infer<typeof createReportInputSchema>;

export const changeReportStatusInputSchema = z.object({
  reportId: z.string().min(1),
  to: z.enum(reportStatuses),
  note: optionalText(NOTE_LIMIT),
});
export type ChangeReportStatusInput = z.infer<typeof changeReportStatusInputSchema>;

export const addReportNoteInputSchema = z.object({
  reportId: z.string().min(1),
  note: z.string().trim().min(1).max(NOTE_LIMIT),
});
export type AddReportNoteInput = z.infer<typeof addReportNoteInputSchema>;

export const updateReportResolutionInputSchema = z.object({
  reportId: z.string().min(1),
  resolutionCode: slugish,
  resolutionNote: optionalText(RESOLUTION_NOTE_LIMIT),
});
export type UpdateReportResolutionInput = z.infer<typeof updateReportResolutionInputSchema>;

export const listReportsInputSchema = z
  .object({
    appId: z.string().min(1).optional(),
    appSlug: z.string().min(1).optional(),
    status: z.enum(reportStatuses).optional(),
    reasonCode: slugish.optional(),
    contentType: slugish.optional(),
    /** Matches an external report id exactly, or an Admin report id. */
    query: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .default({ limit: 50, offset: 0 });
export type ListReportsInput = z.infer<typeof listReportsInputSchema>;

export interface ReportSummary {
  id: string;
  appId: string;
  appSlug: string;
  appName: string;
  externalReportId: string;
  contentType: string;
  reasonCode: string;
  status: ReportStatus;
  priority: ReportPriority;
  createdAt: string;
  updatedAt: string;
}

export interface ReportEvent {
  id: string;
  reportId: string;
  eventType: ReportEventType;
  fromStatus?: ReportStatus;
  toStatus?: ReportStatus;
  actorId?: string;
  note?: string;
  createdAt: string;
}

export interface ReportAttachmentMeta {
  id: string;
  reportId: string;
  contentType: string;
  originalFilename?: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

export interface ReportDetail extends ReportSummary {
  contextExternalId?: string;
  contentExternalId?: string;
  reporterRefHash?: string;
  authorRefHash?: string;
  detail?: string;
  snapshotText?: string;
  resolvedAt?: string;
  resolutionCode?: string;
  resolutionNote?: string;
  events: ReportEvent[];
  attachments: ReportAttachmentMeta[];
}

export interface ReportListPage {
  items: ReportSummary[];
  total: number;
}

/** What `createReport` gives back. `duplicate` is a success, not an error: a
 * phone that retried on a bad connection pressed the button once. */
export interface CreateReportResult {
  reportId: string;
  duplicate: boolean;
}
