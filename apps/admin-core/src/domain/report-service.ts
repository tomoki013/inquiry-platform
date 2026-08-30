import type {
  ActorRef,
  CreateReportResult,
  ReportDetail,
  ReportListPage,
  Result,
} from "@tomokichi/admin-contracts";
import {
  addReportNoteInputSchema,
  canTransitionReport,
  changeReportStatusInputSchema,
  createReportInputSchema,
  fail,
  listReportsInputSchema,
  newId,
  nowIso,
  ok,
  updateReportResolutionInputSchema,
} from "@tomokichi/admin-contracts";
import type { AppRepository } from "../db/apps";
import type { AuditRepository } from "../db/audit";
import type { ReportRepository } from "../db/reports";
import { internalFailure, notFound, validationFailure } from "./failures";
import { pseudonymise } from "./identity";

/**
 * Moderation, as far as the Studio is concerned.
 *
 * The status machine is enforced here rather than in the UI: the browser
 * disables the buttons that would be illegal, and this refuses them anyway,
 * because the UI is not the only thing that can call Admin Core and a disabled
 * button is a hint, not a rule.
 */
export class ReportService {
  constructor(
    private readonly db: D1Database,
    private readonly reports: ReportRepository,
    private readonly apps: AppRepository,
    private readonly audit: AuditRepository,
    private readonly hashPepper: string | undefined,
  ) {}

  /**
   * Records a report from an app backend.
   *
   * Idempotent on `externalReportId`, and deliberately *not* an error when it
   * repeats: a phone that retried on a flaky connection pressed the button
   * once, and answering the retry with a 409 would make the app show a failure
   * for a report that arrived. The existing id comes back instead.
   */
  async create(raw: unknown, actor: ActorRef): Promise<Result<CreateReportResult>> {
    const parsed = createReportInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      const existing = await this.reports.findByExternalId(input.externalReportId);
      if (existing) return ok({ reportId: existing.id, duplicate: true });

      const app = await this.apps.findBySlug(input.appSlug);
      if (!app) return fail("NOT_FOUND", `アプリ "${input.appSlug}" は登録されていません。`);

      const id = newId();
      const createdAt = input.reportedAt ?? nowIso();
      const [reporterRefHash, authorRefHash] = await Promise.all([
        input.reporterRefHash
          ? pseudonymise(input.reporterRefHash, this.hashPepper)
          : Promise.resolve(undefined),
        input.authorRefHash
          ? pseudonymise(input.authorRefHash, this.hashPepper)
          : Promise.resolve(undefined),
      ]);

      // The row, its first history entry and the audit line go together or not
      // at all. D1's `batch` rolls the whole sequence back on a failure, which
      // is the only transaction available here and is enough for this.
      await this.db.batch([
        this.reports.insertStatement(input, {
          id,
          appId: app.id,
          reporterRefHash,
          authorRefHash,
          createdAt,
        }),
        this.reports.eventStatement({ reportId: id, eventType: "created", toStatus: "open" }),
        this.audit.statement({
          actor,
          action: "report.created",
          targetType: "report",
          targetId: id,
          metadata: {
            appSlug: input.appSlug,
            reasonCode: input.reasonCode,
            contentType: input.contentType,
          },
        }),
      ]);

      return ok({ reportId: id, duplicate: false });
    } catch (error) {
      // A racing duplicate loses the UNIQUE index rather than the check above.
      // Same answer either way: the report exists, and that is a success.
      const existing = await this.reports
        .findByExternalId(input.externalReportId)
        .catch(() => null);
      if (existing) return ok({ reportId: existing.id, duplicate: true });
      return internalFailure("report.create", error);
    }
  }

  async list(raw: unknown): Promise<Result<ReportListPage>> {
    const parsed = listReportsInputSchema.safeParse(raw ?? {});
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      return ok(await this.reports.list(parsed.data));
    } catch (error) {
      return internalFailure("report.list", error);
    }
  }

  async detail(reportId: string): Promise<Result<ReportDetail>> {
    try {
      const found = await this.reports.detail(reportId);
      return found ? ok(found) : notFound("通報");
    } catch (error) {
      return internalFailure("report.detail", error);
    }
  }

  /**
   * The only way a report's status changes.
   *
   * Update, history entry and audit line share one batch, so a partially
   * applied move cannot leave a report whose timeline disagrees with its
   * status.
   */
  async changeStatus(raw: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    const parsed = changeReportStatusInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      const row = await this.reports.findRow(input.reportId);
      if (!row) return notFound("通報");
      const from = row.status as ReportDetail["status"];
      if (from === input.to) {
        return fail("INVALID_STATUS_TRANSITION", `すでに「${input.to}」です。`);
      }
      if (!canTransitionReport(from, input.to)) {
        return fail(
          "INVALID_STATUS_TRANSITION",
          `「${from}」から「${input.to}」へは変更できません。`,
        );
      }

      const reopened = from === "closed" && input.to === "reviewing";
      await this.db.batch([
        this.reports.statusStatement(input.reportId, input.to),
        this.reports.eventStatement({
          reportId: input.reportId,
          eventType: reopened ? "reopened" : "status_changed",
          fromStatus: from,
          toStatus: input.to,
          actorId: actor.id,
          note: input.note,
        }),
        this.audit.statement({
          actor,
          action: reopened ? "report.reopened" : "report.status_changed",
          targetType: "report",
          targetId: input.reportId,
          // Statuses, not the note: the note is a person's words and belongs in
          // the timeline, which is where an operator reads it.
          metadata: { from, to: input.to, noteAdded: Boolean(input.note) },
        }),
      ]);

      return await this.detail(input.reportId);
    } catch (error) {
      return internalFailure("report.changeStatus", error);
    }
  }

  async addNote(raw: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    const parsed = addReportNoteInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      const row = await this.reports.findRow(input.reportId);
      if (!row) return notFound("通報");
      await this.db.batch([
        this.reports.eventStatement({
          reportId: input.reportId,
          eventType: "note_added",
          actorId: actor.id,
          note: input.note,
        }),
        this.reports.touchStatement(input.reportId),
        this.audit.statement({
          actor,
          action: "report.note_added",
          targetType: "report",
          targetId: input.reportId,
          metadata: { length: input.note.length },
        }),
      ]);
      return await this.detail(input.reportId);
    } catch (error) {
      return internalFailure("report.addNote", error);
    }
  }

  async updateResolution(raw: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    const parsed = updateReportResolutionInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      const row = await this.reports.findRow(input.reportId);
      if (!row) return notFound("通報");
      await this.db.batch([
        this.reports.resolutionStatement(
          input.reportId,
          input.resolutionCode,
          input.resolutionNote,
        ),
        this.reports.eventStatement({
          reportId: input.reportId,
          eventType: "resolution_updated",
          actorId: actor.id,
          note: input.resolutionNote,
        }),
        this.audit.statement({
          actor,
          action: "report.resolution_updated",
          targetType: "report",
          targetId: input.reportId,
          metadata: { resolutionCode: input.resolutionCode },
        }),
      ]);
      return await this.detail(input.reportId);
    } catch (error) {
      return internalFailure("report.updateResolution", error);
    }
  }
}
