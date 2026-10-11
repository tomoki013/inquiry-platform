import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActorRef,
  OperatorAppliedTemplate,
  OperatorProject,
  OperatorRef,
  OperatorReply,
  OperatorReplyTemplate,
  OperatorTemplateChange,
  OperatorTemplateInput,
  OperatorTicketChange,
  OperatorTicketDetail,
  OperatorTicketPage,
  OperatorTicketQuery,
  OperatorTicketSummary,
  ProjectOperatorApi,
  ProjectOperatorProps,
  ReplyTemplate,
  Result,
  Ticket,
  TicketDetail,
} from "@inquiry-platform/core";
import {
  projectOperatorPropsSchema,
  ticketTransitions,
  toPublicType,
} from "@inquiry-platform/core";
import { z } from "zod";
import { AppRepository, type AppRow } from "./db/apps";
import { internalFailure, validationFailure } from "./domain/failures";
import { TicketService } from "./domain/ticket-service";
import type { AdminCoreEnv } from "./env";
import { buildServices } from "./services";

const forbidden = {
  ok: false as const,
  error: { code: "FORBIDDEN" as const, message: "Not allowed for this binding." },
};
/** One answer for "another project's" and "does not exist". */
const notFound = {
  ok: false as const,
  error: { code: "NOT_FOUND" as const, message: "見つかりません。" },
};

const operatorSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(96)
    // No "@": an operator id is opaque, and an address is not.
    .regex(/^[A-Za-z0-9._:+-]+$/),
});
const querySchema = z
  .object({
    status: z.string().optional(),
    query: z.string().trim().max(200).optional(),
    sources: z
      .array(z.enum(["email", "web_form", "internal", "report"]))
      .min(1)
      .max(4)
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(100000).optional(),
  })
  .strict();
const changeSchema = z
  .object({
    revision: z.number().int().min(0),
    status: z.string().optional(),
    resolution: z.string().optional(),
    nextAction: z.string().max(4000).nullable().optional(),
    nextActionAt: z.string().nullable().optional(),
  })
  .strict();
const noteSchema = z.object({ body: z.string(), idempotencyKey: z.string() }).strict();
const replySchema = z
  .object({
    body: z.string(),
    idempotencyKey: z.string(),
    reopenIfResolved: z.boolean().optional(),
    templateId: z.string().min(1).max(200).optional(),
  })
  .strict();
const templateInputSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    subject: z.string().nullable().optional(),
    body: z.string(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().optional(),
  })
  .strict();
const templateChangeSchema = z
  .object({
    name: z.string().optional(),
    subject: z.string().nullable().optional(),
    body: z.string().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().optional(),
  })
  .strict();
const listTemplatesSchema = z.object({ includeInactive: z.boolean().optional() }).strict();
const signatureSchema = z.string().max(2000);
const TICKET_NUMBER = /^TK-\d{1,12}$/;

/**
 * A project's own console, working its own tickets.
 *
 * The platform's gateway (`apps/admin`) serves operators the deployment
 * trusts through Cloudflare Access; this entrypoint serves a project that
 * runs its own admin and has already decided who may use it. Which projects a
 * binding may operate is fixed in the binding (`props` in the project's
 * wrangler config), so nothing has to be added to the gateway or its Access
 * application for a project to manage its tickets.
 *
 * Every rule stays in Core: the state machine, SLA, audit, reply guards and
 * templates are the same services the gateway uses. What this adds is scope —
 * a list is always filtered to the project, and a ticket of any other project
 * answers `NOT_FOUND` exactly as a missing one does.
 */
export class ProjectOperator extends WorkerEntrypoint<AdminCoreEnv> implements ProjectOperatorApi {
  private cached?: ReturnType<typeof buildServices>;

  private get services() {
    this.cached ??= buildServices(this.env, (work) => this.ctx.waitUntil(work));
    return this.cached;
  }

  private get tickets() {
    return new TicketService(this.env.DB, this.services.moderation);
  }

  private grant(): ProjectOperatorProps | null {
    const parsed = projectOperatorPropsSchema.safeParse((this.ctx as { props?: unknown }).props);
    return parsed.success ? parsed.data : null;
  }

  /** The project, if this binding may operate it and the platform knows it. */
  private async scope(
    projectSlug: string,
  ): Promise<
    { ok: true; grant: ProjectOperatorProps; app: AppRow } | typeof forbidden | typeof notFound
  > {
    const grant = this.grant();
    if (!grant || typeof projectSlug !== "string" || !grant.projects.includes(projectSlug)) {
      return forbidden;
    }
    const app = await new AppRepository(this.env.DB).findBySlug(projectSlug);
    return app ? { ok: true, grant, app } : notFound;
  }

  /** The acting app and, when given, the person inside it — opaque, never an address. */
  private actor(grant: ProjectOperatorProps, raw: unknown): ActorRef | null {
    const operator = operatorSchema.safeParse(raw);
    return operator.success ? { type: "app", id: `${grant.caller}:${operator.data.id}` } : null;
  }

  /** A ticket of this project, by id or number, or `null` for anything else. */
  private async ticket(app: AppRow, ref: string): Promise<Ticket | null> {
    if (typeof ref !== "string" || ref.length === 0 || ref.length > 200) return null;
    let row = await this.tickets.row(ref);
    if (!row && TICKET_NUMBER.test(ref)) {
      const found = await this.env.DB.prepare("SELECT id FROM tickets WHERE ticket_number = ?")
        .bind(ref)
        .first<{ id: string }>();
      row = found ? await this.tickets.row(found.id) : null;
    }
    return row && row.service_id === app.id ? row : null;
  }

  private async detail(id: string, offset = 0): Promise<Result<OperatorTicketDetail>> {
    const detail = await this.tickets.detail(id, offset);
    if (!detail.ok) return detail;
    return { ok: true, value: await this.view(detail.value) };
  }

  private async view(detail: TicketDetail): Promise<OperatorTicketDetail> {
    const grant = this.grant();
    const assignees = grant ? await this.assignees(grant, [detail.ticket.id]) : new Map();
    return toDetail(
      detail,
      await this.receiptId(detail.ticket),
      assignees.get(detail.ticket.id) ?? null,
      (actorId) => (grant ? ownOperator(grant, actorId) : null),
    );
  }

  /** Per ticket, the console operator who last moved it to ACKNOWLEDGED. */
  private async assignees(
    grant: ProjectOperatorProps,
    ids: string[],
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (ids.length === 0) return found;
    const { results } = await this.env.DB.prepare(
      `SELECT ticket_id, actor_id FROM ticket_events
        WHERE event_type = 'ACKNOWLEDGED' AND ticket_id IN (${ids.map(() => "?").join(",")})
        ORDER BY created_at, id`,
    )
      .bind(...ids)
      .all<{ ticket_id: string; actor_id: string | null }>();
    for (const row of results) {
      const who = ownOperator(grant, row.actor_id);
      if (who) found.set(row.ticket_id, who);
    }
    return found;
  }

  /** The reference the person holds: a report's own id, else the conversation's. */
  private async receiptId(ticket: Ticket): Promise<string | null> {
    if (ticket.report_id) {
      const row = await this.env.DB.prepare("SELECT external_report_id FROM reports WHERE id = ?")
        .bind(ticket.report_id)
        .first<{ external_report_id: string }>();
      return row?.external_report_id ?? null;
    }
    return ticket.thread_id;
  }

  async project(projectSlug: string): Promise<Result<OperatorProject>> {
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      return { ok: true, value: await this.projectView(scoped.app) };
    } catch (error) {
      return internalFailure("operator.project", error);
    }
  }

  async listTickets(
    projectSlug: string,
    raw: OperatorTicketQuery = {},
  ): Promise<Result<OperatorTicketPage>> {
    const parsed = querySchema.safeParse(raw ?? {});
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const { status, ...rest } = parsed.data;
      const page = await this.tickets.list({
        ...rest,
        // Always this project, whatever the caller would like to see.
        service_id: scoped.app.id,
        ...(status === "open" ? { queue: "OPEN" } : status ? { status } : {}),
      });
      if (!page.ok) return page;
      const assignees = await this.assignees(
        scoped.grant,
        page.value.items.map((ticket) => ticket.id),
      );
      return {
        ok: true,
        value: {
          items: page.value.items.map((ticket) =>
            toSummary(ticket, assignees.get(ticket.id) ?? null),
          ),
          total: page.value.total,
        },
      };
    } catch (error) {
      return internalFailure("operator.listTickets", error);
    }
  }

  async getTicket(
    projectSlug: string,
    ref: string,
    offset = 0,
  ): Promise<Result<OperatorTicketDetail>> {
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const ticket = await this.ticket(scoped.app, ref);
      if (!ticket) return notFound;
      const at = Number.isInteger(offset) && offset >= 0 ? offset : 0;
      return await this.detail(ticket.id, at);
    } catch (error) {
      return internalFailure("operator.getTicket", error);
    }
  }

  async changeTicket(
    projectSlug: string,
    ticketId: string,
    raw: OperatorTicketChange,
    operator: OperatorRef,
  ): Promise<Result<OperatorTicketDetail>> {
    const parsed = changeSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const actor = this.actor(scoped.grant, operator);
      if (!actor) return forbidden;
      const ticket = await this.ticket(scoped.app, ticketId);
      if (!ticket) return notFound;
      const change = parsed.data;
      // Rebuilt field by field: no project, owner or priority override
      // reaches Core from here, only what a project console decides.
      const result = await this.tickets.change(
        {
          id: ticket.id,
          revision: change.revision,
          ...(change.status !== undefined ? { status: change.status } : {}),
          ...(change.resolution !== undefined ? { resolution: change.resolution } : {}),
          ...(change.nextAction !== undefined ? { next_action: change.nextAction } : {}),
          ...(change.nextActionAt !== undefined ? { next_action_at: change.nextActionAt } : {}),
        },
        actor,
      );
      return result.ok ? { ok: true, value: await this.view(result.value) } : result;
    } catch (error) {
      return internalFailure("operator.changeTicket", error);
    }
  }

  async addNote(
    projectSlug: string,
    ticketId: string,
    raw: { body: string; idempotencyKey: string },
    operator: OperatorRef,
  ): Promise<Result<OperatorTicketDetail>> {
    const parsed = noteSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const actor = this.actor(scoped.grant, operator);
      if (!actor) return forbidden;
      const ticket = await this.ticket(scoped.app, ticketId);
      if (!ticket) return notFound;
      const result = await this.tickets.note({ id: ticket.id, ...parsed.data }, actor);
      return result.ok ? { ok: true, value: await this.view(result.value) } : result;
    } catch (error) {
      return internalFailure("operator.addNote", error);
    }
  }

  async reply(
    projectSlug: string,
    ticketId: string,
    raw: OperatorReply,
    operator: OperatorRef,
  ): Promise<Result<OperatorTicketDetail>> {
    const parsed = replySchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const actor = this.actor(scoped.grant, operator);
      if (!actor) return forbidden;
      const ticket = await this.ticket(scoped.app, ticketId);
      if (!ticket) return notFound;
      if (!ticket.thread_id || !ticket.requester_email) {
        return {
          ok: false,
          error: { code: "CONFLICT", message: "返信先のメール会話がありません。" },
        };
      }
      const templateId = parsed.data.templateId;
      if (templateId && !(await this.ownTemplate(scoped.app, templateId))) return notFound;
      const sent = await this.services.reply.send(
        {
          threadId: ticket.thread_id,
          bodyText: parsed.data.body,
          idempotencyKey: parsed.data.idempotencyKey,
          reopenIfResolved: parsed.data.reopenIfResolved ?? false,
          ...(templateId ? { templateId } : {}),
        },
        actor,
      );
      if (!sent.ok) return sent;
      return await this.detail(ticket.id);
    } catch (error) {
      return internalFailure("operator.reply", error);
    }
  }

  async setSignature(
    projectSlug: string,
    signature: string,
    operator: OperatorRef,
  ): Promise<Result<OperatorProject>> {
    const parsed = signatureSchema.safeParse(signature);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const actor = this.actor(scoped.grant, operator);
      if (!actor) return forbidden;
      const saved = await this.services.reply.setSettings(
        { appId: scoped.app.id, signatureText: parsed.data.trim() },
        actor,
      );
      if (!saved.ok) return saved;
      return { ok: true, value: await this.projectView(scoped.app) };
    } catch (error) {
      return internalFailure("operator.setSignature", error);
    }
  }

  async listTemplates(
    projectSlug: string,
    raw: { includeInactive?: boolean } = {},
  ): Promise<Result<OperatorReplyTemplate[]>> {
    const parsed = listTemplatesSchema.safeParse(raw ?? {});
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const listed = await this.services.reply.listTemplates({
        forAppId: scoped.app.id,
        includeInactive: parsed.data.includeInactive ?? false,
      });
      if (!listed.ok) return listed;
      // `forAppId` also returns the deployment's shared templates; a project
      // console neither sees nor edits those.
      return {
        ok: true,
        value: listed.value.filter((row) => row.appId === scoped.app.id).map(toTemplate),
      };
    } catch (error) {
      return internalFailure("operator.listTemplates", error);
    }
  }

  async createTemplate(
    projectSlug: string,
    raw: OperatorTemplateInput,
    operator: OperatorRef,
  ): Promise<Result<OperatorReplyTemplate>> {
    const parsed = templateInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const actor = this.actor(scoped.grant, operator);
      if (!actor) return forbidden;
      const { subject, ...rest } = parsed.data;
      const created = await this.services.reply.createTemplate(
        {
          ...rest,
          ...(subject ? { subject } : {}),
          category: "general",
          // Always this project's: a console cannot write a shared template.
          appId: scoped.app.id,
        },
        actor,
      );
      return created.ok ? { ok: true, value: toTemplate(created.value) } : created;
    } catch (error) {
      return internalFailure("operator.createTemplate", error);
    }
  }

  async updateTemplate(
    projectSlug: string,
    templateId: string,
    raw: OperatorTemplateChange,
    operator: OperatorRef,
  ): Promise<Result<OperatorReplyTemplate>> {
    const parsed = templateChangeSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const actor = this.actor(scoped.grant, operator);
      if (!actor) return forbidden;
      if (!(await this.ownTemplate(scoped.app, templateId))) return notFound;
      const updated = await this.services.reply.updateTemplate(templateId, parsed.data, actor);
      return updated.ok ? { ok: true, value: toTemplate(updated.value) } : updated;
    } catch (error) {
      return internalFailure("operator.updateTemplate", error);
    }
  }

  async applyTemplate(
    projectSlug: string,
    ticketRef: string,
    templateId: string,
  ): Promise<Result<OperatorAppliedTemplate>> {
    try {
      const scoped = await this.scope(projectSlug);
      if (!scoped.ok) return scoped;
      const ticket = await this.ticket(scoped.app, ticketRef);
      if (!ticket || !(await this.ownTemplate(scoped.app, templateId))) return notFound;
      if (!ticket.thread_id) {
        return {
          ok: false,
          error: { code: "CONFLICT", message: "返信先のメール会話がありません。" },
        };
      }
      const applied = await this.services.reply.applyTemplate({
        threadId: ticket.thread_id,
        templateId,
      });
      if (!applied.ok) return applied;
      return {
        ok: true,
        value: {
          body: applied.value.bodyText,
          unresolved: applied.value.unresolved,
          subject: applied.value.subject,
        },
      };
    } catch (error) {
      return internalFailure("operator.applyTemplate", error);
    }
  }

  /** A template of this project, or `null` for a shared one, another
   * project's, or none. */
  private async ownTemplate(app: AppRow, templateId: unknown): Promise<ReplyTemplate | null> {
    if (typeof templateId !== "string" || templateId.length === 0 || templateId.length > 200) {
      return null;
    }
    const found = await this.services.reply.getTemplate(templateId);
    return found.ok && found.value.appId === app.id ? found.value : null;
  }

  private async projectView(app: AppRow): Promise<OperatorProject> {
    const settings = await this.services.reply.listSettings();
    const own = settings.ok ? settings.value.find((row) => row.appId === app.id) : undefined;
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      mailConfigured: this.services.reply.mailConfiguredForApp(app.id),
      signature: own?.signatureText ?? "",
    };
  }
}

function toTemplate(template: ReplyTemplate): OperatorReplyTemplate {
  return {
    id: template.id,
    key: template.key,
    name: template.name,
    subject: template.subject ?? null,
    body: template.body,
    isActive: template.isActive,
    sortOrder: template.sortOrder,
    updatedAt: template.updatedAt,
  };
}

/** An actor recorded as `<caller>:<operator id>` by this binding, as the
 * project knows it; anything recorded by someone else stays hidden. */
function ownOperator(
  grant: ProjectOperatorProps,
  actorId: string | null | undefined,
): string | null {
  const prefix = `${grant.caller}:`;
  return actorId?.startsWith(prefix) ? actorId.slice(prefix.length) || null : null;
}

function toSummary(ticket: Ticket, assignee: string | null): OperatorTicketSummary {
  return {
    id: ticket.id,
    number: ticket.ticket_number,
    status: ticket.status,
    type: toPublicType(ticket.type),
    source: ticket.operator_source ?? (ticket.report_id ? "report" : "internal"),
    resolution: ticket.resolution,
    priority: ticket.priority,
    subject: ticket.subject,
    requesterEmail: ticket.requester_email,
    slaState: ticket.sla_state,
    nextAction: ticket.next_action,
    nextActionAt: ticket.next_action_at,
    assignee,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
  };
}

function toDetail(
  detail: TicketDetail,
  receiptId: string | null,
  assignee: string | null,
  by: (actorId: string | null) => string | null,
): OperatorTicketDetail {
  const { ticket } = detail;
  return {
    ...toSummary(ticket, assignee),
    receiptId,
    revision: ticket.revision,
    acknowledgedAt: ticket.acknowledged_at,
    resolvedAt: ticket.resolved_at,
    closedAt: ticket.closed_at,
    allowedStatuses: [...(ticketTransitions[ticket.status] ?? [])],
    canReply: ticket.thread_id !== null && ticket.requester_email !== null,
    timeline: detail.timeline.map((item) =>
      item.kind === "message"
        ? {
            kind: "message" as const,
            id: item.value.id,
            direction:
              item.value.visibility === "INTERNAL"
                ? ("note" as const)
                : item.value.direction === "INBOUND"
                  ? ("inbound" as const)
                  : ("outbound" as const),
            sender: item.value.sender,
            body: item.value.body,
            createdAt: item.value.created_at,
          }
        : {
            kind: "event" as const,
            id: item.value.id,
            type: item.value.event_type,
            by: by(item.value.actor_id),
            createdAt: item.value.created_at,
          },
    ),
    totalTimeline: detail.totalTimeline,
  };
}
