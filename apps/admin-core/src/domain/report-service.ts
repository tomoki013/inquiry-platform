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
  type ModerationProposal,
  newId,
  nowIso,
  ok,
  type RemeetModerationApi,
  reportDecisionSchema,
  updateReportResolutionInputSchema,
} from "@tomokichi/admin-contracts";
import { z } from "zod";
import type { AppRepository } from "../db/apps";
import type { AuditRepository } from "../db/audit";
import type { ReportRepository } from "../db/reports";
import type { SupportRepository } from "../db/support";
import { internalFailure, notFound, validationFailure } from "./failures";
import { pseudonymise } from "./identity";
import type { NotificationHook } from "./notification-service";
import type { ReplyService } from "./reply-service";
import { reportMailSubject } from "./report-threading";

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
    private readonly support: SupportRepository,
    private readonly reply: ReplyService,
    private readonly moderation?: RemeetModerationApi,
    /** See `SupportService`: an id and a kind, after the batch committed. */
    private readonly notify?: NotificationHook,
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
      if (existing) {
        await this.sendReceipt(existing.id);
        return ok({ reportId: existing.id, duplicate: true });
      }

      const app = await this.apps.findBySlug(input.appSlug);
      if (!app) return fail("NOT_FOUND", `アプリ "${input.appSlug}" は登録されていません。`);

      const id = newId();
      const threadId = newId();
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
        this.support.insertThreadStatement({
          id: threadId,
          appId: app.id,
          source: "email",
          requesterEmail: input.reporterEmail,
          subject: reportMailSubject(app.name, input.externalReportId),
          at: createdAt,
        }),
        this.support.insertMessageStatement({
          id: newId(),
          threadId,
          direction: "internal_note",
          bodyText: `通報を受け付けました。受付ID: ${input.externalReportId}`,
          at: createdAt,
        }),
        this.reports.insertStatement(input, {
          id,
          appId: app.id,
          reporterRefHash,
          authorRefHash,
          createdAt,
        }),
        this.db.prepare("UPDATE reports SET support_thread_id = ? WHERE id = ?").bind(threadId, id),
        this.reports.eventStatement({ reportId: id, eventType: "created", toStatus: "open" }),
        ...(input.evidenceExpected
          ? [this.reports.eventStatement({ reportId: id, eventType: "attachment_pending" })]
          : []),
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

      // The ticket is the thread's row: `ticket_report_insert` retyped it.
      this.notify?.({ ticketId: threadId, category: "report" });
      await this.sendReceipt(id);
      return ok({ reportId: id, duplicate: false });
    } catch (error) {
      // A racing duplicate loses the UNIQUE index rather than the check above.
      // Same answer either way: the report exists, and that is a success.
      const existing = await this.reports
        .findByExternalId(input.externalReportId)
        .catch(() => null);
      if (existing) {
        await this.sendReceipt(existing.id);
        return ok({ reportId: existing.id, duplicate: true });
      }
      return internalFailure("report.create", error);
    }
  }

  async prepareDecision(raw: unknown, actor: ActorRef): Promise<Result<ModerationProposal>> {
    const parsed = reportDecisionSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const row = await this.reports.findRow(parsed.data.reportId);
      if (!row) return notFound("通報");
      if (!this.moderation || row.app_slug !== "remeet" || !row.content_external_id) {
        return fail("CONFLICT", "このアプリのコンテンツ操作は設定されていません。");
      }
      const ticket = await this.db
        .prepare(
          "SELECT t.status,t.merged_into FROM tickets t JOIN ticket_sources s ON s.ticket_id=t.id WHERE s.source_type='report' AND s.source_id=?",
        )
        .bind(row.id)
        .first<{ status: string; merged_into: string | null }>();
      if (
        ticket
          ? ticket.merged_into || ["CLOSED", "RESOLVED"].includes(ticket.status)
          : !["open", "reviewing"].includes(row.status)
      )
        return fail("CONFLICT", "Ticketを再開してから操作してください。");
      const proposal = await this.moderation.prepare({
        reportId: row.external_report_id,
        contentId: row.content_external_id,
        contentType: row.content_type,
        reunionId: row.context_external_id ?? undefined,
        reason: row.reason_code,
        decision: parsed.data.decision,
        actorId: actor.id ?? "admin",
      });
      await this.db
        .prepare("INSERT INTO report_operations (id,report_id,decision) VALUES (?,?,?)")
        .bind(proposal.id, row.id, parsed.data.decision)
        .run();
      return ok(proposal);
    } catch (error) {
      return internalFailure("report.prepareDecision", error);
    }
  }

  async completeDecision(raw: unknown, actor: ActorRef): Promise<Result<ReportDetail>> {
    const parsed = z
      .object({
        reportId: z.string().min(1),
        operationId: z.string().min(1),
        envelope: z.string().max(4 * 1024 * 1024),
      })
      .safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;
    try {
      const operation = await this.db
        .prepare("SELECT * FROM report_operations WHERE id=? AND report_id=?")
        .bind(input.operationId, input.reportId)
        .first<{ decision: "delete" | "dismiss"; completed_at: string | null }>();
      if (!operation) return notFound("操作");
      if (operation.completed_at) return this.detail(input.reportId);
      if (!this.moderation) return fail("CONFLICT", "コンテンツ操作は設定されていません。");
      const row = await this.reports.findRow(input.reportId);
      if (!row) return notFound("通報");
      const published = await this.moderation.complete(input.operationId, input.envelope);
      const status = operation.decision === "delete" ? "actioned" : "closed";
      const code = operation.decision === "delete" ? "content_deleted" : "no_action";
      const note =
        operation.decision === "delete"
          ? `削除指示を公開しました（revision ${published.revision}）。アプリが受信した際に削除されます。`
          : `対応なしでクローズしました（revision ${published.revision}）。アプリが受信した際にこの通報による非表示を解除します。`;
      await this.db.batch([
        // RPC completions can arrive out of order. Only the newest published
        // decision may change the current report state.
        this.db
          .prepare(`UPDATE reports SET status=?, resolution_code=?, resolution_note=?,
            updated_at=?, resolved_at=?, moderation_revision=?
            WHERE id=? AND moderation_revision < ?`)
          .bind(
            status,
            code,
            note,
            nowIso(),
            nowIso(),
            published.revision,
            input.reportId,
            published.revision,
          ),
        this.reports.eventStatement({
          reportId: input.reportId,
          eventType: "resolution_updated",
          fromStatus: row.status as ReportDetail["status"],
          toStatus: status,
          actorId: actor.id,
          note,
        }),
        this.audit.statement({
          actor,
          action: "report.resolution_updated",
          targetType: "report",
          targetId: input.reportId,
          metadata: { resolutionCode: code, revision: published.revision },
        }),
        this.db
          .prepare("UPDATE report_operations SET completed_at=? WHERE id=?")
          .bind(nowIso(), input.operationId),
      ]);
      return this.detail(input.reportId);
    } catch (error) {
      return internalFailure("report.completeDecision", error);
    }
  }

  async sendReceipt(reportId: string): Promise<void> {
    try {
      const row = await this.reports.findRow(reportId);
      if (!row?.support_thread_id) return;
      const thread = await this.support.findThread(row.support_thread_id);
      if (!thread?.requester_email) return;
      await this.reply.send(
        {
          threadId: thread.id,
          bodyText: `通報を受け付けました。お知らせいただきありがとうございます。\n\n受付ID: ${row.external_report_id}\n\n運営で内容を確認し、必要な対応を行います。追加の情報がある場合は、このメールにご返信ください。\n\n間違って通報した場合は、このメールにそのまま返信してお知らせください。アプリで内容を「表示に戻す」にしても通報は取り消されません。また、内容を削除しても通報は取り消されず、削除した内容は元に戻せませんので、削除せずにこのメールへご返信ください。`,
          idempotencyKey: `report-receipt-${reportId}`,
        },
        { type: "system", id: "report-receipt" },
        { preserveDraft: true, initialMessage: true },
      );
    } catch (error) {
      // The report is durable even if receipt lookup or delivery fails.
      internalFailure("report.sendReceipt", error);
    }
  }

  async retryReceipts(): Promise<void> {
    const { results } = await this.db
      .prepare(`SELECT r.id FROM reports r
      JOIN support_threads t ON t.id = r.support_thread_id
      WHERE t.requester_email <> '' AND t.status = 'open'
      AND NOT EXISTS (SELECT 1 FROM support_reply_sends s WHERE s.idempotency_key = 'report-receipt-' || r.id)
      ORDER BY r.created_at LIMIT 25`)
      .all<{ id: string }>();
    for (const row of results) await this.sendReceipt(row.id);
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
   * Non-moderation status changes.
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

      if (
        row.app_slug === "remeet" &&
        ((input.to === "closed" && from !== "actioned") || input.to === "actioned")
      ) {
        return fail(
          "CONFLICT",
          "コンテンツ操作から削除、または対応なしでクローズを選択してください。",
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
