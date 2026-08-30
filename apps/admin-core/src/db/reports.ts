import type {
  CreateReportInput,
  ListReportsInput,
  ReportAttachmentMeta,
  ReportDetail,
  ReportEvent,
  ReportEventType,
  ReportListPage,
  ReportPriority,
  ReportStatus,
  ReportSummary,
} from "@tomokichi/admin-contracts";
import { newId, nowIso } from "@tomokichi/admin-contracts";

interface ReportRow {
  id: string;
  app_id: string;
  external_report_id: string;
  context_external_id: string | null;
  content_type: string;
  content_external_id: string | null;
  reporter_ref_hash: string | null;
  author_ref_hash: string | null;
  reason_code: string;
  detail: string | null;
  snapshot_text: string | null;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_code: string | null;
  resolution_note: string | null;
  app_slug: string;
  app_name: string;
}

interface EventRow {
  id: string;
  report_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_id: string | null;
  note: string | null;
  created_at: string;
}

interface AttachmentRow {
  id: string;
  report_id: string;
  r2_key: string;
  content_type: string;
  original_filename: string | null;
  byte_size: number;
  sha256: string;
  created_at: string;
}

const SELECT_WITH_APP = `
  SELECT r.*, a.slug AS app_slug, a.name AS app_name
    FROM reports r JOIN apps a ON a.id = r.app_id`;

function toSummary(row: ReportRow): ReportSummary {
  return {
    id: row.id,
    appId: row.app_id,
    appSlug: row.app_slug,
    appName: row.app_name,
    externalReportId: row.external_report_id,
    contentType: row.content_type,
    reasonCode: row.reason_code,
    status: row.status as ReportStatus,
    priority: row.priority as ReportPriority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ReportRepository {
  constructor(private readonly db: D1Database) {}

  async findByExternalId(externalReportId: string): Promise<{ id: string } | null> {
    return await this.db
      .prepare("SELECT id FROM reports WHERE external_report_id = ?")
      .bind(externalReportId)
      .first<{ id: string }>();
  }

  async findRow(id: string): Promise<ReportRow | null> {
    return await this.db.prepare(`${SELECT_WITH_APP} WHERE r.id = ?`).bind(id).first<ReportRow>();
  }

  insertStatement(
    input: CreateReportInput,
    values: {
      id: string;
      appId: string;
      reporterRefHash?: string;
      authorRefHash?: string;
      createdAt: string;
    },
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO reports
           (id, app_id, external_report_id, context_external_id, content_type,
            content_external_id, reporter_ref_hash, author_ref_hash, reason_code,
            detail, snapshot_text, status, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.appId,
        input.externalReportId,
        input.contextExternalId ?? null,
        input.contentType,
        input.contentExternalId ?? null,
        values.reporterRefHash ?? null,
        values.authorRefHash ?? null,
        input.reasonCode,
        input.detail ?? null,
        input.snapshotText ?? null,
        input.priority,
        values.createdAt,
        values.createdAt,
      );
  }

  eventStatement(event: {
    reportId: string;
    eventType: ReportEventType;
    fromStatus?: ReportStatus;
    toStatus?: ReportStatus;
    actorId?: string;
    note?: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO report_events
           (id, report_id, event_type, from_status, to_status, actor_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        event.reportId,
        event.eventType,
        event.fromStatus ?? null,
        event.toStatus ?? null,
        event.actorId ?? null,
        event.note ?? null,
        nowIso(),
      );
  }

  statusStatement(id: string, to: ReportStatus): D1PreparedStatement {
    const at = nowIso();
    // `resolved_at` is set when the report leaves the queue and cleared when it
    // comes back, so "when was this finished" never answers about a report that
    // is open again.
    const resolved = to === "closed" || to === "actioned";
    return this.db
      .prepare("UPDATE reports SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?")
      .bind(to, at, resolved ? at : null, id);
  }

  resolutionStatement(id: string, code: string, note: string | undefined): D1PreparedStatement {
    return this.db
      .prepare(
        "UPDATE reports SET resolution_code = ?, resolution_note = ?, updated_at = ? WHERE id = ?",
      )
      .bind(code, note ?? null, nowIso(), id);
  }

  touchStatement(id: string): D1PreparedStatement {
    return this.db.prepare("UPDATE reports SET updated_at = ? WHERE id = ?").bind(nowIso(), id);
  }

  attachmentStatement(values: {
    id: string;
    reportId: string;
    r2Key: string;
    contentType: string;
    originalFilename?: string;
    byteSize: number;
    sha256: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO report_attachments
           (id, report_id, r2_key, content_type, original_filename, byte_size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.reportId,
        values.r2Key,
        values.contentType,
        values.originalFilename ?? null,
        values.byteSize,
        values.sha256,
        nowIso(),
      );
  }

  async findAttachment(reportId: string, attachmentId: string): Promise<AttachmentRow | null> {
    return await this.db
      .prepare("SELECT * FROM report_attachments WHERE id = ? AND report_id = ?")
      .bind(attachmentId, reportId)
      .first<AttachmentRow>();
  }

  /**
   * Filter, search and page in one statement plus one count.
   *
   * `query` matches an external id or an Admin id exactly rather than with
   * `LIKE %…%`: the search box in the Reports screen is for pasting an id out
   * of a mail, and a prefix scan over a growing table is a slow answer to a
   * question nobody asked.
   */
  async list(input: ListReportsInput): Promise<ReportListPage> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (input.appId) {
      where.push("r.app_id = ?");
      values.push(input.appId);
    }
    if (input.appSlug) {
      where.push("a.slug = ?");
      values.push(input.appSlug);
    }
    if (input.status) {
      where.push("r.status = ?");
      values.push(input.status);
    }
    if (input.reasonCode) {
      where.push("r.reason_code = ?");
      values.push(input.reasonCode);
    }
    if (input.contentType) {
      where.push("r.content_type = ?");
      values.push(input.contentType);
    }
    if (input.query) {
      where.push("(r.external_report_id = ? OR r.id = ?)");
      values.push(input.query, input.query);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const batched = await this.db.batch<ReportRow | { total: number }>([
      this.db
        .prepare(
          `${SELECT_WITH_APP} ${clause} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
        )
        .bind(...values, input.limit, input.offset),
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM reports r JOIN apps a ON a.id = r.app_id ${clause}`)
        .bind(...values),
    ]);

    return {
      items: ((batched[0]?.results ?? []) as ReportRow[]).map(toSummary),
      total: ((batched[1]?.results ?? []) as { total: number }[])[0]?.total ?? 0,
    };
  }

  async detail(id: string): Promise<ReportDetail | null> {
    const row = await this.findRow(id);
    if (!row) return null;

    const related = await this.db.batch<EventRow | AttachmentRow>([
      this.db
        .prepare("SELECT * FROM report_events WHERE report_id = ? ORDER BY created_at, id")
        .bind(id),
      this.db
        .prepare("SELECT * FROM report_attachments WHERE report_id = ? ORDER BY created_at")
        .bind(id),
    ]);

    return {
      ...toSummary(row),
      contextExternalId: row.context_external_id ?? undefined,
      contentExternalId: row.content_external_id ?? undefined,
      reporterRefHash: row.reporter_ref_hash ?? undefined,
      authorRefHash: row.author_ref_hash ?? undefined,
      detail: row.detail ?? undefined,
      snapshotText: row.snapshot_text ?? undefined,
      resolvedAt: row.resolved_at ?? undefined,
      resolutionCode: row.resolution_code ?? undefined,
      resolutionNote: row.resolution_note ?? undefined,
      events: ((related[0]?.results ?? []) as EventRow[]).map(
        (event): ReportEvent => ({
          id: event.id,
          reportId: event.report_id,
          eventType: event.event_type as ReportEventType,
          fromStatus: (event.from_status as ReportStatus | null) ?? undefined,
          toStatus: (event.to_status as ReportStatus | null) ?? undefined,
          actorId: event.actor_id ?? undefined,
          note: event.note ?? undefined,
          createdAt: event.created_at,
        }),
      ),
      attachments: ((related[1]?.results ?? []) as AttachmentRow[]).map(
        (attachment): ReportAttachmentMeta => ({
          id: attachment.id,
          reportId: attachment.report_id,
          contentType: attachment.content_type,
          originalFilename: attachment.original_filename ?? undefined,
          byteSize: attachment.byte_size,
          sha256: attachment.sha256,
          createdAt: attachment.created_at,
        }),
      ),
    };
  }

  async countByStatus(status: ReportStatus): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS total FROM reports WHERE status = ?")
      .bind(status)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }
}
