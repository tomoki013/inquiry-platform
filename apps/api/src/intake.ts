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
  fail,
  intakePropsSchema,
  ok,
  reportSubmissionSchema,
  toPublicStatus,
} from "@inquiry-platform/core";
import { AppRepository } from "./db/apps";
import { ReportRepository } from "./db/reports";
import { SupportRepository } from "./db/support";
import { internalFailure, validationFailure } from "./domain/failures";
import { Scope } from "./domain/scope";
import type { AdminCoreEnv } from "./env";
import { putReportEvidence } from "./evidence";
import { json } from "./http";
import { recordMailReceipt } from "./mail-receipts";
import type { Domain } from "./project-features";
import { buildServices } from "./services";
import { prepareVerification } from "./turnstile";

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
 * Provider delivery receipts also enter here. No reads, notes or status changes.
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
    this.cached ??= buildServices(this.env, (work) => this.ctx.waitUntil(work), this.accessScope());
    return this.cached;
  }

  private grant(): IntakeProps | null {
    const parsed = intakePropsSchema.safeParse((this.ctx as { props?: unknown }).props);
    return parsed.success ? parsed.data : null;
  }

  private async accessScope(): Promise<Scope> {
    const grant = this.grant();
    const projects = [...(grant?.projects ?? [])];
    if (grant?.allowUnassigned) {
      const row = await this.env.DB.prepare(
        "SELECT slug FROM services WHERE id=COALESCE((SELECT value FROM platform_settings WHERE key='default_service_id'),'unassigned')",
      ).first<{ slug: string }>();
      if (row) projects.push(row.slug);
    }
    return Scope.resolve(this.env.DB, { scope: { services: [...new Set(projects)] } });
  }

  private actor(grant: IntakeProps): ActorRef {
    return { type: "app", id: grant.caller };
  }

  private async verification(
    projectId: string,
    domain: Domain,
    caller: string,
    key: string,
    input: ContactSubmission | ReportSubmission,
  ) {
    const config = this.services.features(projectId, domain);
    if (!config.enabled) return fail("FORBIDDEN", "この受付は無効です。");
    if (!config.turnstile) return ok(null);
    const verification = await prepareVerification(
      this.env.DB,
      this.env,
      config.turnstile,
      { projectId, domain, caller, key },
      input,
    );
    const existing = await verification.existing();
    if (!existing.ok) return existing;
    if (!existing.value) {
      const checked = await verification.verify();
      if (!checked.ok) return checked;
    }
    return ok({ verification, sourceId: existing.value });
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
      const projectSlug = input.projectSlug;
      const projectId = projectSlug
        ? (await new AppRepository(this.env.DB).findBySlug(projectSlug))?.id
        : await this.env.DB.prepare(
            "SELECT COALESCE((SELECT value FROM platform_settings WHERE key='default_service_id'),'unassigned') AS id",
          ).first<string>("id");
      if (!projectId) return unknownProject;
      const verified = await this.verification(
        projectId,
        "inquiry",
        grant.caller,
        input.idempotencyKey,
        input,
      );
      if (!verified.ok) return verified;
      const protection = verified.value;
      if (protection?.sourceId)
        return ok({
          ...(await this.receipt("support", protection.sourceId)),
          receiptId: protection.sourceId,
          duplicate: true,
        });
      const projectDb = await this.services.registry.forSlug(projectSlug);
      // The same key the support form has always used, so a retry that
      // straddles the switch to this entrypoint is still one ticket.
      const providerMessageId = `form-${input.idempotencyKey}`;
      const seen = await new SupportRepository(projectDb).messageExists(providerMessageId);
      if (seen && !protection) {
        const owner = await new SupportRepository(projectDb).detail(seen.thread_id, false);
        if (owner && (owner.appSlug ?? undefined) !== projectSlug) return taken;
        const existing = await this.services.support.detail(seen.thread_id);
        if (!existing.ok) return existing;
        if ((existing.value.appSlug ?? undefined) !== projectSlug) return taken;
        return {
          ok: true,
          value: {
            ...(await this.receipt("support", existing.value.id)),
            receiptId: existing.value.id,
            duplicate: true,
          },
        };
      }

      let pendingId: string | undefined;
      const created = await this.services.support.createThread(
        {
          appSlug: projectSlug,
          source: "web_form",
          requesterEmail: input.email,
          requesterName: input.name,
          subject: input.subject,
          bodyText: input.message,
          providerMessageId,
          sender: input.email,
        },
        this.actor(grant),
        protection
          ? (db, id) => {
              pendingId = id;
              return protection.verification.statement(db, id);
            }
          : undefined,
      );
      if (protection) {
        const stored = await protection.verification.existing();
        if (!stored.ok) return stored;
        if (!stored.value)
          return (await protection.verification.tokenUsed())
            ? fail("VALIDATION_ERROR", "Turnstile をもう一度実行してください。")
            : created.ok
              ? taken
              : created;
        return ok({
          ...(await this.receipt("support", stored.value)),
          receiptId: stored.value,
          duplicate: pendingId !== stored.value,
        });
      }
      if (!created.ok) return created;
      return {
        ok: true,
        value: {
          ...(await this.receipt("support", created.value.id)),
          receiptId: created.value.id,
          duplicate: false,
        },
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
      const app = await new AppRepository(this.env.DB).findBySlug(input.projectSlug);
      if (!app) return unknownProject;
      const verified = await this.verification(
        app.id,
        "report",
        grant.caller,
        input.externalReportId.trim(),
        input,
      );
      if (!verified.ok) return verified;
      const protection = verified.value;
      if (protection?.sourceId)
        return ok({
          ...(await this.receipt("report", protection.sourceId)),
          reportId: protection.sourceId,
          duplicate: true,
        });
      const reports = new ReportRepository(await this.services.registry.forSlug(input.projectSlug));
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
        protection?.verification.statement,
      );
      if (protection) {
        const stored = await protection.verification.existing();
        if (!stored.ok) return stored;
        if (!stored.value)
          return (await protection.verification.tokenUsed())
            ? fail("VALIDATION_ERROR", "Turnstile をもう一度実行してください。")
            : created.ok
              ? taken
              : created;
        return ok({
          ...(await this.receipt("report", stored.value)),
          reportId: stored.value,
          duplicate: !created.ok || created.value.duplicate,
        });
      }
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
    const receipt = /^\/internal\/projects\/([a-z0-9-]{1,64})\/mail-receipts$/.exec(
      new URL(request.url).pathname,
    );
    if (receipt && request.method === "POST") {
      const slug = receipt[1] as string;
      if (!grant.projects.includes(slug)) return json({ error: "FORBIDDEN" }, 403);
      return recordMailReceipt(await this.services.registry.forSlug(slug), slug, request);
    }
    const match = /^\/internal\/reports\/([^/]+)\/attachments$/.exec(new URL(request.url).pathname);
    if (!match || request.method !== "PUT") return json({ error: "NOT_FOUND" }, 404);
    const reportId = decodeURIComponent(match[1] as string);
    const row = await new ReportRepository(this.services.db).findRow(reportId);
    // Another project's report answers exactly like a missing one.
    if (!row || !grant.projects.includes(row.app_slug)) return json({ error: "NOT_FOUND" }, 404);
    return await putReportEvidence(this.env, reportId, request);
  }

  private async receipt(
    kind: "support" | "report",
    sourceId: string,
  ): Promise<{ ticketNumber: string | null; status: ContactReceipt["status"] }> {
    const tickets = this.services.tickets;
    const source = await tickets.source(kind, sourceId);
    const ticket = source.ok ? await tickets.row(source.value.id) : null;
    return {
      ticketNumber: ticket?.ticket_number ?? null,
      status: ticket ? toPublicStatus(ticket.status) : "OPEN",
    };
  }
}
