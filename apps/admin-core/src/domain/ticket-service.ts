import {
  type ActorRef,
  createTicketSchema,
  fail,
  newId,
  nowIso,
  ok,
  type Result,
  type SlaGoal,
  type Ticket,
  type TicketDashboard,
  type TicketDetail,
  type TicketEvent,
  type TicketMaster,
  type TicketMasters,
  type TicketMessage,
  type TicketPage,
  type TicketPriority,
  type TicketRelation,
  ticketChangeSchema,
  ticketListSchema,
  ticketMergeSchema,
  ticketNoteSchema,
  ticketPriorities,
  ticketPriority,
  ticketRelationSchema,
  ticketTransitions,
  ticketTypes,
} from "@tomokichi/admin-contracts";
import { z } from "zod";
import { SupportRepository } from "../db/support";
import { internalFailure, notFound, validationFailure } from "./failures";

// SQL computes SLA before filtering/pagination, so no tickets disappear between pages.
function clockExpression(column: string, minutes: string, threshold: number) {
  return `(t.${minutes} IS NOT NULL AND (julianday(COALESCE(t.${column},t.closed_at,?))-julianday(t.created_at))*1440 >= t.${minutes}*${threshold})`;
}
const breached = [
  "acknowledged_at:sla_ack_minutes",
  "first_response_at:sla_response_minutes",
  "resolved_at:sla_resolution_minutes",
]
  .map((s) => {
    const [c, m] = s.split(":") as [string, string];
    return clockExpression(c, m, 1);
  })
  .join(" OR ");
const atRisk = [
  "acknowledged_at:sla_ack_minutes",
  "first_response_at:sla_response_minutes",
  "resolved_at:sla_resolution_minutes",
]
  .map((s) => {
    const [c, m] = s.split(":") as [string, string];
    return `(t.${c} IS NULL AND t.closed_at IS NULL AND ${clockExpression(c, m, 0.8)})`;
  })
  .join(" OR ");
const SELECT = `SELECT t.*,s.name AS service_name,CASE WHEN ${breached} THEN 'BREACHED' WHEN ${atRisk} THEN 'AT_RISK' ELSE 'OK' END AS sla_state,
 (SELECT source_id FROM ticket_sources WHERE ticket_id=t.id AND source_type='report' LIMIT 1) AS report_id,
 COALESCE((SELECT source_id FROM ticket_sources WHERE ticket_id=t.id AND source_type='support' AND source_id=t.id),(SELECT source_id FROM ticket_sources WHERE ticket_id=t.id AND source_type='support' LIMIT 1)) AS thread_id
 FROM tickets t JOIN services s ON s.id=t.service_id`;
const clockBindings = (at: string) => Array(6).fill(at) as string[];

/** Operations only. No mail provider: notes cannot send mail. */
export class TicketService {
  constructor(private readonly db: D1Database) {}
  private event(
    ticketId: string,
    eventType: string,
    actor: ActorRef,
    metadata: unknown,
    at: string,
    mutation?: string,
  ) {
    return this.db
      .prepare(`INSERT INTO ticket_events(id,ticket_id,event_type,actor_id,metadata,created_at)
      SELECT ?,id,?,?,?,? FROM tickets WHERE id=? ${mutation ? "AND mutation_id=?" : ""}`)
      .bind(
        newId(),
        eventType,
        actor.id ?? actor.type,
        JSON.stringify(metadata),
        at,
        ticketId,
        ...(mutation ? [mutation] : []),
      );
  }
  async row(id: string): Promise<Ticket | null> {
    const at = nowIso();
    return this.db
      .prepare(`${SELECT} WHERE t.id=? OR t.ticket_number=?`)
      .bind(...clockBindings(at), id, id)
      .first<Ticket>();
  }
  async source(kind: string, id: string): Promise<Result<{ id: string }>> {
    try {
      const row = await this.db
        .prepare("SELECT ticket_id AS id FROM ticket_sources WHERE source_type=? AND source_id=?")
        .bind(kind, id)
        .first<{ id: string }>();
      return row ? ok(row) : notFound("Ticket");
    } catch (e) {
      return internalFailure("ticket.source", e);
    }
  }
  async list(raw: unknown): Promise<Result<TicketPage>> {
    const parsed = ticketListSchema.safeParse(raw ?? {});
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data,
      at = nowIso(),
      where: string[] = [parsed.data.query ? "1=1" : "merged_into IS NULL"],
      values: unknown[] = [];
    for (const key of [
      "status",
      "priority",
      "type",
      "service_id",
      "component_id",
      "category_id",
      "assignee_id",
    ] as const) {
      if (input[key]) {
        if (key === "assignee_id" && input[key] === "unassigned") where.push("assignee_id IS NULL");
        else {
          where.push(`${key}=?`);
          values.push(input[key]);
        }
      }
    }
    if (input.queue) {
      where.push("status NOT IN ('RESOLVED','CLOSED')");
      if (input.queue === "UNACKNOWLEDGED") where.push("acknowledged_at IS NULL");
      if (input.queue === "URGENT") where.push("priority IN ('P1','P2')");
      if (input.queue === "SLA_RISK") where.push("sla_state<>'OK'");
    }
    if (input.sla) {
      where.push("sla_state=?");
      values.push(input.sla);
    }
    if (input.created_from) {
      where.push("created_at>=?");
      values.push(input.created_from);
    }
    if (input.created_to) {
      where.push("created_at<=?");
      values.push(input.created_to);
    }
    if (input.next) {
      const today = at.slice(0, 10);
      where.push(
        input.next === "OVERDUE"
          ? "next_action_at<?"
          : input.next === "TODAY"
            ? "substr(next_action_at,1,10)=?"
            : "next_action_at>=?",
      );
      values.push(input.next === "TODAY" ? today : at);
      where.push("status NOT IN ('RESOLVED','CLOSED')");
    }
    if (input.query) {
      where.push(
        "(ticket_number LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\' OR requester_email LIKE ? ESCAPE '\\' OR requester_id LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM ticket_messages m WHERE m.ticket_id=q.id AND m.body LIKE ? ESCAPE '\\'))",
      );
      const v = `%${input.query.replace(/[\\%_]/g, "\\$&")}%`;
      values.push(v, v, v, v, v);
    }
    try {
      const from = `FROM (${SELECT}) q WHERE ${where.join(" AND ")}`;
      const r = await this.db.batch([
        this.db
          .prepare(
            `SELECT * ${from} ORDER BY priority,CASE sla_state WHEN 'BREACHED' THEN 0 WHEN 'AT_RISK' THEN 1 ELSE 2 END,created_at,id LIMIT ? OFFSET ?`,
          )
          .bind(...clockBindings(at), ...values, input.limit, input.offset),
        this.db.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...clockBindings(at), ...values),
      ]);
      return ok({
        items: r[0]?.results as unknown as Ticket[],
        total: (r[1]?.results[0] as { total: number } | undefined)?.total ?? 0,
      });
    } catch (e) {
      return internalFailure("ticket.list", e);
    }
  }
  async detail(id: string, offset = 0): Promise<Result<TicketDetail>> {
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
      return fail("VALIDATION_ERROR", "履歴ページが不正です。");
    try {
      const ticket = await this.row(id);
      if (!ticket) return notFound("Ticket");
      // Keep message contents out of the list query. Timeline pages are bounded.
      const union =
        "SELECT id,created_at,'message' AS kind FROM ticket_messages WHERE ticket_id=? UNION ALL SELECT id,created_at,'event' AS kind FROM ticket_events WHERE ticket_id=?";
      const keys = await this.db
        .prepare(`SELECT * FROM (${union}) ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?`)
        .bind(ticket.id, ticket.id, offset)
        .all<{ id: string; kind: string }>();
      const timeline: TicketDetail["timeline"] = [];
      if (keys.results.length) {
        const ids = keys.results.map((k) => k.id),
          placeholders = ids.map(() => "?").join(",");
        const rows = await this.db.batch([
          this.db
            .prepare(`SELECT * FROM ticket_messages WHERE ticket_id=? AND id IN (${placeholders})`)
            .bind(ticket.id, ...ids),
          this.db
            .prepare(`SELECT * FROM ticket_events WHERE ticket_id=? AND id IN (${placeholders})`)
            .bind(ticket.id, ...ids),
          this.db
            .prepare(
              `SELECT a.id,a.message_id,a.original_filename FROM support_attachments a JOIN ticket_messages m ON m.legacy_message_id=a.message_id WHERE m.ticket_id=? AND m.id IN (${placeholders})`,
            )
            .bind(ticket.id, ...ids),
        ]);
        const messages = rows[0]?.results as unknown as TicketMessage[];
        const events = rows[1]?.results as unknown as TicketEvent[];
        const attachments = rows[2]?.results as Array<{
          id: string;
          message_id: string;
          original_filename: string | null;
        }>;
        for (const item of keys.results) {
          if (item.kind === "message") {
            const value = messages.find((m) => m.id === item.id);
            if (value)
              timeline.push({
                kind: "message",
                value: {
                  ...value,
                  attachments: attachments
                    .filter((a) => a.message_id === value.legacy_message_id)
                    .map((a) => ({ id: a.id, originalFilename: a.original_filename })),
                },
              });
          } else {
            const value = events.find((e) => e.id === item.id);
            if (value) timeline.push({ kind: "event", value });
          }
        }
      }
      const count = await this.db
        .prepare(`SELECT COUNT(*) AS n FROM (${union})`)
        .bind(ticket.id, ticket.id)
        .first<{ n: number }>();
      const relations = await this.db
        .prepare(
          "SELECT r.*,t.ticket_number FROM ticket_relations r JOIN tickets t ON t.id=CASE WHEN r.source_ticket_id=? THEN r.target_ticket_id ELSE r.source_ticket_id END WHERE r.source_ticket_id=? OR r.target_ticket_id=? ORDER BY r.created_at LIMIT 100",
        )
        .bind(ticket.id, ticket.id, ticket.id)
        .all<TicketRelation>();
      return ok({ ticket, timeline, totalTimeline: count?.n ?? 0, relations: relations.results });
    } catch (e) {
      return internalFailure("ticket.detail", e);
    }
  }
  async masters(): Promise<Result<TicketMasters>> {
    try {
      const tables = [
        "services",
        "service_components",
        "ticket_categories",
        "assignment_groups",
        "ticket_assignees",
      ];
      const rows = await this.db.batch(
        tables.map((t) => this.db.prepare(`SELECT * FROM ${t} ORDER BY name`)),
      );
      const sla = await this.db
        .prepare("SELECT * FROM ticket_sla_settings ORDER BY priority")
        .all<SlaGoal & { priority: TicketPriority }>();
      return ok({
        services: rows[0]?.results as unknown as TicketMaster[],
        components: rows[1]?.results as unknown as TicketMaster[],
        categories: rows[2]?.results as unknown as TicketMaster[],
        groups: rows[3]?.results as unknown as TicketMaster[],
        assignees: rows[4]?.results as unknown as TicketMaster[],
        sla: sla.results,
      });
    } catch (e) {
      return internalFailure("ticket.masters", e);
    }
  }
  async create(raw: unknown, actor: ActorRef): Promise<Result<TicketDetail>> {
    const p = createTicketSchema.safeParse(raw);
    if (!p.success) return validationFailure(p.error);
    try {
      const service = await this.db
        .prepare("SELECT id FROM services WHERE id=? AND is_active=1")
        .bind(p.data.service_id)
        .first();
      if (!service) return notFound("Service");
      const id = newId(),
        at = nowIso(),
        repo = new SupportRepository(this.db);
      const app = await this.db
        .prepare("SELECT id FROM apps WHERE id=?")
        .bind(p.data.service_id)
        .first<{ id: string }>();
      // Reuse the stable transport thread identity, without inventing an inbound customer message.
      await this.db.batch([
        repo.insertThreadStatement({
          id,
          appId: app?.id,
          source: "internal",
          requesterEmail: p.data.requester_email,
          subject: p.data.subject,
          at,
        }),
        this.db
          .prepare("UPDATE tickets SET type=?,service_id=?,summary=? WHERE id=?")
          .bind(p.data.type, p.data.service_id, p.data.summary ?? null, id),
        this.event(
          id,
          "DETAILS_CHANGED",
          actor,
          { createdInternally: true, type: p.data.type },
          at,
        ),
      ]);
      return this.detail(id);
    } catch (e) {
      return internalFailure("ticket.create", e);
    }
  }
  async change(raw: unknown, actor: ActorRef): Promise<Result<TicketDetail>> {
    const p = ticketChangeSchema.safeParse(raw);
    if (!p.success) return validationFailure(p.error);
    const input = p.data;
    try {
      const row = await this.row(input.id);
      if (!row) return notFound("Ticket");
      if (row.merged_into) return fail("CONFLICT", "統合先のTicketを操作してください。");
      if (row.revision !== input.revision)
        return fail("CONFLICT", "別の操作が反映されました。再読み込みしてください。");
      if (row.status === "CLOSED" && input.status !== "IN_PROGRESS")
        return fail("CONFLICT", "再開してから編集してください。");
      const changes: Record<string, unknown> = {},
        events: Array<[string, unknown]> = [],
        at = nowIso(),
        mutation = newId();
      const status = input.status ?? row.status;
      if (
        row.report_id &&
        input.status &&
        ["RESOLVED", "CLOSED"].includes(input.status) &&
        !["RESOLVED", "CLOSED"].includes(row.status)
      ) {
        const report = await this.db
          .prepare(
            "SELECT r.status,a.slug FROM reports r JOIN apps a ON a.id=r.app_id WHERE r.id=?",
          )
          .bind(row.report_id)
          .first<{ status: string; slug: string }>();
        if (report?.slug === "remeet" && ["open", "reviewing"].includes(report.status))
          return fail(
            "CONFLICT",
            "通報のコンテンツ操作から削除または対応なしを確定してください。非表示解除には署名付きの対応が必要です。",
          );
      }
      if (input.status && input.status !== row.status) {
        if (!ticketTransitions[row.status].includes(input.status))
          return fail("INVALID_STATUS_TRANSITION", "この状態には遷移できません。");
        if (["RESOLVED", "CLOSED"].includes(status) && !(input.resolution ?? row.resolution))
          return fail("VALIDATION_ERROR", "処理結果を選んでください。");
        changes.status = status;
        const reopening = ["CLOSED", "RESOLVED"].includes(row.status) && status === "IN_PROGRESS";
        events.push([
          reopening
            ? "REOPENED"
            : status === "ACKNOWLEDGED"
              ? "ACKNOWLEDGED"
              : status === "RESOLVED"
                ? "RESOLVED"
                : status === "CLOSED"
                  ? "CLOSED"
                  : "STATUS_CHANGED",
          { previousStatus: row.status, newStatus: status },
        ]);
        if (status === "ACKNOWLEDGED" && !row.acknowledged_at) changes.acknowledged_at = at;
        if (status === "RESOLVED") changes.resolved_at = at;
        if (status === "CLOSED") changes.closed_at = at;
        if (reopening) {
          changes.resolution = null;
          changes.resolved_at = null;
          changes.closed_at = null;
        }
      }
      if (input.resolution !== undefined) {
        if (!["RESOLVED", "CLOSED"].includes(status))
          return fail("VALIDATION_ERROR", "処理結果は解決・クローズ時に設定してください。");
        if (!input.resolution) return fail("VALIDATION_ERROR", "処理結果を選んでください。");
        changes.resolution = input.resolution;
        events.push([
          "DETAILS_CHANGED",
          { resolution: { from: row.resolution, to: input.resolution } },
        ]);
      }
      if (["RESOLVED", "CLOSED"].includes(status) && changes.resolution === undefined)
        changes.resolution = row.resolution;
      const type = input.type ?? row.type,
        service = input.service_id ?? row.service_id;
      for (const [field, table] of [
        ["service_id", "services"],
        ["component_id", "service_components"],
        ["category_id", "ticket_categories"],
        ["assignment_group_id", "assignment_groups"],
        ["assignee_id", "ticket_assignees"],
      ] as const) {
        const value = input[field];
        if (value) {
          const master = await this.db
            .prepare(`SELECT * FROM ${table} WHERE id=? AND is_active=1`)
            .bind(value)
            .first<TicketMaster>();
          if (!master) return fail("VALIDATION_ERROR", `${field} が見つかりません。`);
          if (field === "component_id" && master.service_id !== service)
            return fail("VALIDATION_ERROR", "Componentは選択中のServiceに属していません。");
          if (field === "category_id" && master.type !== type)
            return fail("VALIDATION_ERROR", "Categoryは選択中のTypeに属していません。");
        }
      }
      if (service !== row.service_id) changes.component_id = null;
      if (type !== row.type) changes.category_id = null;
      const eventFor: Record<string, string> = {
        type: "TYPE_CHANGED",
        service_id: "SERVICE_CHANGED",
        component_id: "SERVICE_CHANGED",
        category_id: "CATEGORY_CHANGED",
        assignment_group_id: "ASSIGNMENT_CHANGED",
        assignee_id: "ASSIGNMENT_CHANGED",
        next_action: "NEXT_ACTION_CHANGED",
        next_action_at: "NEXT_ACTION_CHANGED",
      };
      for (const field of [
        "type",
        "service_id",
        "component_id",
        "category_id",
        "assignment_group_id",
        "assignee_id",
        "subject",
        "summary",
        "next_action",
        "next_action_at",
      ] as const) {
        if (input[field] !== undefined && input[field] !== row[field]) {
          changes[field] = input[field];
          events.push([
            eventFor[field] ?? "DETAILS_CHANGED",
            { field, from: row[field], to: input[field] },
          ]);
        }
      }
      if (input.next_action_at && !(input.next_action ?? row.next_action))
        return fail("VALIDATION_ERROR", "期限には次のアクションを設定してください。");
      if (input.impact || input.urgency || input.priority || input.override_reason !== undefined) {
        const impact = input.impact ?? row.impact,
          urgency = input.urgency ?? row.urgency,
          calculated = ticketPriority(impact, urgency);
        const priority = input.priority ?? calculated;
        if (priority !== calculated && !input.override_reason)
          return fail("VALIDATION_ERROR", "優先度を上書きする理由が必要です。");
        Object.assign(changes, {
          impact,
          urgency,
          priority,
          priority_override: priority === calculated ? null : input.override_reason,
        });
        const goal = await this.db
          .prepare("SELECT * FROM ticket_sla_settings WHERE priority=?")
          .bind(priority)
          .first<SlaGoal>();
        if (!goal) return notFound("SLA設定");
        Object.assign(changes, {
          sla_ack_minutes: goal.ack,
          sla_response_minutes: goal.response,
          sla_resolution_minutes: goal.resolution,
        });
        events.push([
          "PRIORITY_CHANGED",
          {
            from: row.priority,
            to: priority,
            impact,
            urgency,
            reason: input.override_reason ?? null,
          },
        ]);
      }
      if (!Object.keys(changes).length) return this.detail(row.id);
      Object.assign(changes, { updated_at: at, mutation_id: mutation });
      const batch = await this.db.batch([
        this.db
          .prepare(
            `UPDATE tickets SET ${Object.keys(changes)
              .map((k) => `${k}=?`)
              .join(",")},revision=revision+1 WHERE id=? AND revision=?`,
          )
          .bind(...Object.values(changes), row.id, input.revision),
        ...events.map(([type, data]) => this.event(row.id, type, actor, data, at, mutation)),
        this.db
          .prepare(
            `UPDATE support_threads SET status=(SELECT CASE WHEN resolution='SPAM' AND status='CLOSED' THEN 'spam' WHEN status IN ('CLOSED','RESOLVED') THEN 'resolved' WHEN status='WAITING_CUSTOMER' THEN 'pending_user' ELSE 'open' END FROM tickets WHERE id=?), updated_at=? WHERE id IN (SELECT source_id FROM ticket_sources WHERE ticket_id=? AND source_type='support') AND EXISTS(SELECT 1 FROM tickets WHERE id=? AND mutation_id=?)`,
          )
          .bind(row.id, at, row.id, row.id, mutation),
        // Keep the moderation adapter operable after a Ticket reopen, without publishing an action.
        this.db
          .prepare(
            "UPDATE reports SET status='reviewing' WHERE id=? AND status IN ('closed','actioned') AND EXISTS(SELECT 1 FROM tickets WHERE id=? AND mutation_id=? AND status='IN_PROGRESS')",
          )
          .bind(row.report_id, row.id, mutation),
      ]);
      if (!batch[0]?.meta.changes)
        return fail("CONFLICT", "同時更新を検出しました。再読み込みしてください。");
      return this.detail(row.id);
    } catch (e) {
      return internalFailure("ticket.change", e);
    }
  }
  async ack(id: string, actor: ActorRef): Promise<Result<TicketDetail>> {
    try {
      const row = await this.row(id);
      if (!row) return notFound("Ticket");
      if (row.acknowledged_at) return this.detail(id);
      if (!["NEW", "TRIAGE"].includes(row.status))
        return fail("INVALID_STATUS_TRANSITION", "新規・分類中のTicketをACKできます。");
      return this.change({ id, revision: row.revision, status: "ACKNOWLEDGED" }, actor);
    } catch (e) {
      return internalFailure("ticket.ack", e);
    }
  }
  async note(raw: unknown, actor: ActorRef): Promise<Result<TicketDetail>> {
    const p = ticketNoteSchema.safeParse(raw);
    if (!p.success) return validationFailure(p.error);
    try {
      const row = await this.row(p.data.id);
      if (!row) return notFound("Ticket");
      if (row.status === "CLOSED" || row.merged_into)
        return fail("CONFLICT", "再開してからメモを追加してください。");
      const at = nowIso(),
        id = `note:${p.data.id}:${p.data.idempotencyKey}`;
      await this.db.batch([
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ticket_messages(id,ticket_id,direction,visibility,sender,body,created_at) SELECT ?,id,'OUTBOUND','INTERNAL',?,?,? FROM tickets WHERE id=? AND status<>'CLOSED' AND merged_into IS NULL",
          )
          .bind(id, actor.id ?? actor.type, p.data.body, at, row.id),
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ticket_events(id,ticket_id,event_type,actor_id,metadata,created_at) SELECT ?,ticket_id,'INTERNAL_NOTE_ADDED',?,json_object('messageId',id),created_at FROM ticket_messages WHERE id=?",
          )
          .bind(id, actor.id ?? actor.type, id),
        this.db
          .prepare("UPDATE tickets SET updated_at=?,revision=revision+1 WHERE id=? AND changes()>0")
          .bind(at, row.id),
      ]);
      const saved = await this.db
        .prepare("SELECT id FROM ticket_messages WHERE id=?")
        .bind(id)
        .first();
      if (!saved) return fail("CONFLICT", "Ticketの状態が変わりました。再読み込みしてください。");
      return this.detail(row.id);
    } catch (e) {
      return internalFailure("ticket.note", e);
    }
  }
  async relation(raw: unknown, actor: ActorRef): Promise<Result<TicketDetail>> {
    const p = ticketRelationSchema.safeParse(raw);
    if (!p.success) return validationFailure(p.error);
    try {
      const source = await this.row(p.data.id),
        target = await this.row(p.data.target_id);
      if (!source || !target) return notFound("Ticket");
      if (source.id === target.id || source.merged_into || source.status === "CLOSED")
        return fail("CONFLICT", "このTicketには関連を追加できません。");
      const at = nowIso(),
        id = newId();
      await this.db.batch([
        this.db
          .prepare("INSERT OR IGNORE INTO ticket_relations VALUES(?,?,?,?,?)")
          .bind(id, source.id, target.id, p.data.relation_type, at),
        this.db
          .prepare(
            "INSERT INTO ticket_events SELECT ?,source_ticket_id,'RELATION_ADDED',?,json_object('target',target_ticket_id,'type',relation_type),created_at FROM ticket_relations WHERE id=?",
          )
          .bind(newId(), actor.id ?? actor.type, id),
      ]);
      return this.detail(source.id);
    } catch (e) {
      return internalFailure("ticket.relation", e);
    }
  }
  async merge(raw: unknown, actor: ActorRef): Promise<Result<TicketDetail>> {
    const p = ticketMergeSchema.safeParse(raw);
    if (!p.success) return validationFailure(p.error);
    try {
      const a = await this.row(p.data.id),
        b = await this.row(p.data.target_id);
      if (!a || !b) return notFound("Ticket");
      if (
        a.id === b.id ||
        a.merged_into ||
        b.merged_into ||
        ["CLOSED", "RESOLVED"].includes(b.status)
      )
        return fail("CONFLICT", "統合先は未完了の別Ticketを指定してください。");
      if (a.revision !== p.data.revision || b.revision !== p.data.target_revision)
        return fail("CONFLICT", "Ticketが更新されました。再読み込みしてください。");
      if ((a.requester_email ?? "").toLowerCase() !== (b.requester_email ?? "").toLowerCase())
        return fail("CONFLICT", "異なる依頼者のTicketは統合せず、関連付けを使ってください。");
      if (a.report_id) {
        const pending = await this.db
          .prepare("SELECT status FROM reports WHERE id=?")
          .bind(a.report_id)
          .first<{ status: string }>();
        if (pending && ["open", "reviewing"].includes(pending.status))
          return fail(
            "CONFLICT",
            "通報対象への対応を完了してから統合してください。関連付けは先に追加できます。",
          );
      }
      const at = nowIso(),
        token = newId();
      const results = await this.db.batch([
        this.db
          .prepare(
            "UPDATE tickets SET mutation_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND merged_into IS NULL AND status NOT IN ('CLOSED','RESOLVED') AND EXISTS(SELECT 1 FROM tickets WHERE id=? AND revision=? AND merged_into IS NULL)",
          )
          .bind(token, at, b.id, b.revision, a.id, a.revision),
        this.db
          .prepare(
            "UPDATE tickets SET status='CLOSED',resolution='DUPLICATE',merged_into=?,closed_at=?,updated_at=?,revision=revision+1,mutation_id=? WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM tickets WHERE id=? AND mutation_id=?)",
          )
          .bind(b.id, at, at, token, a.id, a.revision, b.id, token),
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ticket_relations SELECT ?,id,?,'DUPLICATE',? FROM tickets WHERE id=? AND mutation_id=?",
          )
          .bind(newId(), b.id, at, a.id, token),
        this.db
          .prepare(
            "UPDATE ticket_sources SET ticket_id=? WHERE source_type='support' AND ticket_id=? AND EXISTS(SELECT 1 FROM tickets WHERE id=? AND mutation_id=?)",
          )
          .bind(b.id, a.id, a.id, token),
        this.event(
          a.id,
          "MERGED",
          actor,
          { target: b.id, previousStatus: a.status, newStatus: "CLOSED", resolution: "DUPLICATE" },
          at,
          token,
        ),
        this.event(b.id, "MERGED", actor, { source: a.id }, at, token),
      ]);
      if (!results[1]?.meta.changes) return fail("CONFLICT", "同時更新を検出しました。");
      // Original messages stay with the source. The target timeline links the retained source.
      return this.detail(a.id);
    } catch (e) {
      return internalFailure("ticket.merge", e);
    }
  }
  async dashboard(): Promise<Result<TicketDashboard>> {
    try {
      const at = nowIso(),
        sql = `FROM (${SELECT}) q WHERE merged_into IS NULL AND status NOT IN ('RESOLVED','CLOSED')`;
      const counts = await this.db
        .prepare(
          `SELECT COUNT(*) AS open,SUM(acknowledged_at IS NULL) AS unacknowledged,SUM(priority IN ('P1','P2')) AS urgent,SUM(sla_state<>'OK') AS slaRisk,SUM(next_action_at<?) AS overdue,SUM(status='WAITING_CUSTOMER') AS waitingCustomer ${sql}`,
        )
        .bind(at, ...clockBindings(at))
        .first<Record<string, number>>();
      const queue = await this.db
        .prepare(
          `SELECT * ${sql} ORDER BY priority,CASE sla_state WHEN 'BREACHED' THEN 0 WHEN 'AT_RISK' THEN 1 ELSE 2 END,created_at LIMIT 10`,
        )
        .bind(...clockBindings(at))
        .all<Ticket>();
      const attention = await this.db
        .prepare(
          `SELECT * ${sql} AND (sla_state<>'OK' OR next_action_at<? OR assignee_id IS NULL OR (status IN ('WAITING_CUSTOMER','WAITING_INTERNAL') AND updated_at<?)) ORDER BY priority,created_at LIMIT 10`,
        )
        .bind(...clockBindings(at), at, new Date(Date.now() - 3 * 86400000).toISOString())
        .all<Ticket>();
      return ok({
        open: counts?.open ?? 0,
        unacknowledged: counts?.unacknowledged ?? 0,
        urgent: counts?.urgent ?? 0,
        slaRisk: counts?.slaRisk ?? 0,
        overdue: counts?.overdue ?? 0,
        waitingCustomer: counts?.waitingCustomer ?? 0,
        priorityQueue: queue.results,
        needsAttention: attention.results,
      });
    } catch (e) {
      return internalFailure("ticket.dashboard", e);
    }
  }
  async saveMaster(raw: unknown, actor: ActorRef): Promise<Result<TicketMasters>> {
    const p = z
      .object({
        kind: z.enum(["service", "component", "category", "group", "assignee", "sla"]),
        id: z.string().min(1).max(200),
        name: z.string().trim().min(1).max(100).optional(),
        slug: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(64)
          .optional(),
        service_id: z.string().optional(),
        type: z.enum(ticketTypes).optional(),
        is_active: z.boolean().default(true),
        ack: z.number().int().positive().max(5256000).optional(),
        response: z.number().int().positive().max(5256000).optional(),
        resolution: z.number().int().positive().max(5256000).nullable().optional(),
      })
      .safeParse(raw);
    if (!p.success) return validationFailure(p.error);
    const i = p.data;
    if (i.kind === "assignee" && i.id === "self") i.id = actor.id ?? "admin";
    try {
      let statement: D1PreparedStatement;
      if (i.kind === "sla") {
        if (
          !ticketPriorities.some((priority) => priority === i.id) ||
          !i.ack ||
          !i.response ||
          i.resolution === undefined
        )
          return fail("VALIDATION_ERROR", "SLA値を入力してください。");
        statement = this.db
          .prepare("UPDATE ticket_sla_settings SET ack=?,response=?,resolution=? WHERE priority=?")
          .bind(i.ack, i.response, i.resolution, i.id);
      } else {
        if (!i.name) return fail("VALIDATION_ERROR", "名前を入力してください。");
        const table = {
          service: "services",
          component: "service_components",
          category: "ticket_categories",
          group: "assignment_groups",
          assignee: "ticket_assignees",
        }[i.kind];
        if (i.kind === "component" || i.kind === "category") {
          const field = i.kind === "component" ? "component_id" : "category_id";
          const scope = i.kind === "component" ? "service_id" : "type";
          const scoped = i.kind === "component" ? i.service_id : i.type;
          const linked = await this.db
            .prepare(`SELECT id FROM tickets WHERE ${field}=? AND ${scope}<>? LIMIT 1`)
            .bind(i.id, scoped ?? "")
            .first();
          if (linked) return fail("CONFLICT", "使用中のマスタの所属は変更できません。");
        }
        const fields: Record<string, unknown> = {
          id: i.id,
          name: i.name,
          is_active: i.is_active ? 1 : 0,
        };
        if (["service", "component", "category"].includes(i.kind)) {
          if (!i.slug) return fail("VALIDATION_ERROR", "slugを入力してください。");
          fields.slug = i.slug;
        }
        if (i.kind === "component") {
          if (!i.service_id) return fail("VALIDATION_ERROR", "Serviceを選んでください。");
          fields.service_id = i.service_id;
        }
        if (i.kind === "category") {
          if (!i.type) return fail("VALIDATION_ERROR", "Typeを選んでください。");
          fields.type = i.type;
        }
        statement = this.db
          .prepare(
            `INSERT INTO ${table}(${Object.keys(fields).join(",")}) VALUES(${Object.keys(fields)
              .map(() => "?")
              .join(",")}) ON CONFLICT(id) DO UPDATE SET ${Object.keys(fields)
              .filter((k) => k !== "id")
              .map((k) => `${k}=excluded.${k}`)
              .join(",")}`,
          )
          .bind(...Object.values(fields));
      }
      await this.db.batch([
        statement,
        this.db
          .prepare(
            "INSERT INTO audit_logs VALUES(?, 'admin',?,'ticket.settings_updated','system',?,?,?)",
          )
          .bind(newId(), actor.id ?? "admin", i.id, JSON.stringify({ kind: i.kind }), nowIso()),
      ]);
      return this.masters();
    } catch (e) {
      return internalFailure("ticket.saveMaster", e);
    }
  }
}
