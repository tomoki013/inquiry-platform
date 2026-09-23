import type {
  ContactSubmission,
  IntakeErrorCode,
  IntakeProps,
  InternalTicketStatus,
  ReportSubmission,
} from "@inquiry-platform/sdk";
import { z } from "zod";
import type { AdminErrorCode } from "./errors";
import type { TicketStatus } from "./tickets";

/**
 * The `Intake` entrypoint's validation of the SDK contract.
 *
 * Only the envelope is checked here. Each submission is then translated into
 * the platform's own input (`createSupportThread`, `createReport`), whose
 * schemas are the real validation, so a field is never judged by two rules.
 */
const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const intakePropsSchema = z.object({
  caller: z.string().trim().min(1).max(64),
  projects: z.array(slug).max(50),
  allowUnassigned: z.boolean().optional(),
}) satisfies z.ZodType<IntakeProps>;

export const contactSubmissionSchema = z.object({
  projectSlug: slug.optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  subject: z.string(),
  message: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
  channel: z.enum(["web_form", "app"]),
}) satisfies z.ZodType<ContactSubmission>;

export const reportSubmissionSchema = z.object({
  projectSlug: slug,
  externalReportId: z.string(),
  targetType: z.string(),
  targetId: z.string().optional(),
  targetOwnerId: z.string().optional(),
  contextId: z.string().optional(),
  reason: z.string(),
  description: z.string().optional(),
  reporterId: z.string().optional(),
  reporterEmail: z.string().optional(),
  snapshotText: z.string().optional(),
  evidenceExpected: z.boolean().optional(),
  reportedAt: z.string().optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
}) satisfies z.ZodType<ReportSubmission>;

/** Compile-time proof that the SDK's copy of the internal statuses is this
 * one: adding a status here without mapping it there fails `tsc`. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const statusVocabularyInSync: Same<TicketStatus, InternalTicketStatus> = true;

/** Every error the platform can return is one the SDK names. */
export const errorVocabularyInSync: [AdminErrorCode] extends [IntakeErrorCode] ? true : false =
  true;
