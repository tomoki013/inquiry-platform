import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActorRef,
  OperatorProject,
  OperatorRef,
  OperatorTicketChange,
  OperatorTicketDetail,
  OperatorTicketPage,
  OperatorTicketQuery,
  OperatorTicketSummary,
  ProjectOperatorApi,
  ProjectOperatorProps,
  Result,
  Ticket,
  TicketDetail,
} from "@inquiry-platform/core";
import { projectOperatorPropsSchema, ticketTransitions } from "@inquiry-platform/core";
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
  })
  .strict();
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
    return detail.ok ? { ok: true, value: toDetail(detail.value) } : detail;
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
      return {
        ok: true,
        value: { items: page.value.items.map(toSummary), total: page.value.total },
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
      return result.ok ? { ok: true, value: toDetail(result.value) } : result;
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
      return result.ok ? { ok: true, value: toDetail(result.value) } : result;
    } catch (error) {
      return internalFailure("operator.addNote", error);
    }
  }

  async reply(
    projectSlug: string,
    ticketId: string,
    raw: { body: string; idempotencyKey: string; reopenIfResolved?: boolean },
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
      const sent = await this.services.reply.send(
        {
          threadId: ticket.thread_id,
          bodyText: parsed.data.body,
          idempotencyKey: parsed.data.idempotencyKey,
          reopenIfResolved: parsed.data.reopenIfResolved ?? false,
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

  private async projectView(app: AppRow): Promise<OperatorProject> {
    const settings = await this.services.reply.listSettings();
    const own = settings.ok ? settings.value.find((row) => row.appId === app.id) : undefined;
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      mailConfigured: this.services.reply.mailConfigured,
      signature: own?.signatureText ?? "",
    };
  }
}

function toSummary(ticket: Ticket): OperatorTicketSummary {
  return {
    id: ticket.id,
    number: ticket.ticket_number,
    status: ticket.status,
    resolution: ticket.resolution,
    priority: ticket.priority,
    subject: ticket.subject,
    requesterEmail: ticket.requester_email,
    slaState: ticket.sla_state,
    nextAction: ticket.next_action,
    nextActionAt: ticket.next_action_at,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
  };
}

function toDetail(detail: TicketDetail): OperatorTicketDetail {
  const { ticket } = detail;
  return {
    ...toSummary(ticket),
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
            createdAt: item.value.created_at,
          },
    ),
    totalTimeline: detail.totalTimeline,
  };
}
