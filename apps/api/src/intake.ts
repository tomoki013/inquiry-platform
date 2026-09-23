import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActorRef,
  ContactReceipt,
  ContactSubmission,
  IntakeApi,
  IntakeProps,
  ReportReceipt,
  ReportSubmission,
  Result,
} from "@inquiry-platform/core";
import {
  contactSubmissionSchema,
  intakePropsSchema,
  reportSubmissionSchema,
  toPublicStatus,
} from "@inquiry-platform/core";
import { AppRepository } from "./db/apps";
import { ReportRepository } from "./db/reports";
import { SupportRepository } from "./db/support";
import { internalFailure, validationFailure } from "./domain/failures";
import { TicketService } from "./domain/ticket-service";
import type { AdminCoreEnv } from "./env";
import { putReportEvidence } from "./evidence";
import { json } from "./http";
import { buildServices } from "./services";

const forbidden = {
  ok: false as const,
  error: { code: "FORBIDDEN" as const, message: "Not allowed for this binding." },
};
const unknownProject = {
  ok: false as const,
  error: { code: "NOT_FOUND" as const, message: "This project is not registered." },
};
/** One answer for "someone else's" and "does not exist", so a caller cannot
 * learn that another project used an id. */
const taken = {
  ok: false as const,
  error: { code: "CONFLICT" as const, message: "This id is already in use." },
};

/**
 * The door a project uses: submit a contact, submit a report, attach evidence.
 * Nothing else — no reads, no notes, no status changes.
 *
 * `AdminCore` is the platform's own entrypoint and can do everything; a
 * project binds to this one instead. Which projects a binding may submit for
 * is fixed in the binding itself (`props` in the project's `wrangler.jsonc`),
 * so a project's Worker cannot file into, or learn about, another project's
 * tickets by choosing a different slug. A binding without valid props is
 * refused outright.
 */
export class Intake extends WorkerEntrypoint<AdminCoreEnv> implements IntakeApi {
  private cached?: ReturnType<typeof buildServices>;

  private get services() {
    this.cached ??= buildServices(this.env, (work) => this.ctx.waitUntil(work));
    return this.cached;
  }

  private grant(): IntakeProps | null {
    const parsed = intakePropsSchema.safeParse((this.ctx as { props?: unknown }).props);
    return parsed.success ? parsed.data : null;
  }

  private actor(grant: IntakeProps): ActorRef {
    return { type: "app", id: grant.caller };
  }

  async submitContact(raw: ContactSubmission): Promise<Result<ContactReceipt>> {
    const grant = this.grant();
    if (!grant) return forbidden;
    const parsed = contactSubmissionSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;
    if (input.projectSlug ? !grant.projects.includes(input.projectSlug) : !grant.allowUnassigned) {
      return forbidden;
    }

    try {
      // The same key the support form has always used, so a retry that
      // straddles the switch to this entrypoint is still one ticket.
      const providerMessageId = `form-${input.idempotencyKey}`;
      const seen = await new SupportRepository(this.env.DB).messageExists(providerMessageId);
      if (seen) {
        const existing = await this.services.support.detail(seen.thread_id);
        if (!existing.ok) return existing;
        if ((existing.value.appSlug ?? undefined) !== input.projectSlug) return taken;
        return {
          ok: true,
          value: { ...(await this.receipt("support", existing.value.id)), duplicate: true },
        };
      }
      // A granted slug that is not registered would otherwise become an
      // unassigned ticket. Refuse before anything is written.
      if (
        input.projectSlug &&
        !(await new AppRepository(this.env.DB).findBySlug(input.projectSlug))
      ) {
        return unknownProject;
      }

      const created = await this.services.support.createThread(
        {
          appSlug: input.projectSlug,
          source: "web_form",
          requesterEmail: input.email,
          requesterName: input.name,
          subject: input.subject,
          bodyText: input.message,
          providerMessageId,
          sender: input.email,
        },
        this.actor(grant),
      );
      if (!created.ok) return created;
      return {
        ok: true,
        value: { ...(await this.receipt("support", created.value.id)), duplicate: false },
      };
    } catch (error) {
      return internalFailure("intake.submitContact", error);
    }
  }

  async submitReport(raw: ReportSubmission): Promise<Result<ReportReceipt>> {
    const grant = this.grant();
    if (!grant) return forbidden;
    const parsed = reportSubmissionSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;
    if (!grant.projects.includes(input.projectSlug)) return forbidden;

    try {
      const reports = new ReportRepository(this.env.DB);
      const existing = await reports.findByExternalId(input.externalReportId.trim());
      if (existing && (await reports.findRow(existing.id))?.app_slug !== input.projectSlug) {
        return taken;
      }
      const created = await this.services.reports.create(
        {
          appSlug: input.projectSlug,
          externalReportId: input.externalReportId,
          contextExternalId: input.contextId,
          contentType: input.targetType,
          contentExternalId: input.targetId,
          // Raw ids; `ReportService` pseudonymises them with the pepper only
          // this Worker holds.
          reporterRefHash: input.reporterId,
          authorRefHash: input.targetOwnerId,
          reasonCode: input.reason,
          reporterEmail: input.reporterEmail,
          detail: input.description,
          snapshotText: input.snapshotText,
          priority: input.priority ?? "normal",
          evidenceExpected: input.evidenceExpected,
          reportedAt: input.reportedAt,
        },
        this.actor(grant),
      );
      if (!created.ok) return created;
      return {
        ok: true,
        value: {
          reportId: created.value.reportId,
          ...(await this.receipt("report", created.value.reportId)),
          duplicate: created.value.duplicate,
        },
      };
    } catch (error) {
      return internalFailure("intake.submitReport", error);
    }
  }

  /** Evidence bytes, for a report of one of this binding's projects. */
  override async fetch(request: Request): Promise<Response> {
    const grant = this.grant();
    if (!grant) return json({ error: "FORBIDDEN" }, 403);
    const match = /^\/internal\/reports\/([^/]+)\/attachments$/.exec(new URL(request.url).pathname);
    if (!match || request.method !== "PUT") return json({ error: "NOT_FOUND" }, 404);
    const reportId = decodeURIComponent(match[1] as string);
    const row = await new ReportRepository(this.env.DB).findRow(reportId);
    // Another project's report answers exactly like a missing one.
    if (!row || !grant.projects.includes(row.app_slug)) return json({ error: "NOT_FOUND" }, 404);
    return await putReportEvidence(this.env, reportId, request);
  }

  private async receipt(
    kind: "support" | "report",
    sourceId: string,
  ): Promise<{ ticketNumber: string | null; status: ContactReceipt["status"] }> {
    const tickets = new TicketService(this.env.DB, this.services.moderation);
    const source = await tickets.source(kind, sourceId);
    const ticket = source.ok ? await tickets.row(source.value.id) : null;
    return {
      ticketNumber: ticket?.ticket_number ?? null,
      status: ticket ? toPublicStatus(ticket.status) : "OPEN",
    };
  }
}
