import type { ActorRef, AppDetail, AppSummary, Result } from "@tomokichi/admin-contracts";
import {
  createAppInputSchema,
  createAppLinkInputSchema,
  fail,
  listAppsInputSchema,
  ok,
  updateAppInputSchema,
} from "@tomokichi/admin-contracts";
import type { AppRepository } from "../db/apps";
import type { AuditRepository } from "../db/audit";
import { internalFailure, notFound, validationFailure } from "./failures";

/**
 * The Studio's registry of its own apps.
 *
 * Nothing here changes how an app behaves — there is no flag an operator can
 * flip that reaches a phone. That is a deliberate limit: a管理画面 that can
 * change what a shipped app does is one compromised session away from changing
 * it for everybody, and Phase 1–3 has no need for it.
 */
export class AppService {
  constructor(
    private readonly db: D1Database,
    private readonly apps: AppRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(raw: unknown): Promise<Result<AppSummary[]>> {
    const parsed = listAppsInputSchema.safeParse(raw ?? {});
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      return ok(await this.apps.listSummaries(parsed.data.includeArchived));
    } catch (error) {
      return internalFailure("app.list", error);
    }
  }

  async detail(appId: string): Promise<Result<AppDetail>> {
    try {
      const found = await this.apps.detail(appId);
      return found ? ok(found) : notFound("アプリ");
    } catch (error) {
      return internalFailure("app.detail", error);
    }
  }

  async create(raw: unknown, actor: ActorRef): Promise<Result<AppDetail>> {
    const parsed = createAppInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      if (await this.apps.findBySlug(input.slug)) {
        return fail("CONFLICT", `slug "${input.slug}" はすでに使われています。`);
      }
      const id = this.apps.newId();
      await this.db.batch([
        this.apps.insertStatement(input, id),
        this.audit.statement({
          actor,
          action: "app.created",
          targetType: "app",
          targetId: id,
          metadata: { slug: input.slug, status: input.status },
        }),
      ]);
      return await this.detail(id);
    } catch (error) {
      return internalFailure("app.create", error);
    }
  }

  async update(appId: string, raw: unknown, actor: ActorRef): Promise<Result<AppDetail>> {
    const parsed = updateAppInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);

    try {
      const existing = await this.apps.findById(appId);
      if (!existing) return notFound("アプリ");
      const statement = this.apps.updateStatement(appId, parsed.data);
      if (!statement) return await this.detail(appId);

      await this.db.batch([
        statement,
        this.audit.statement({
          actor,
          action: "app.updated",
          targetType: "app",
          targetId: appId,
          // Which fields moved, not what they moved to: a description is prose.
          metadata: { fields: Object.keys(parsed.data).sort().join(",") || "none" },
        }),
      ]);
      return await this.detail(appId);
    } catch (error) {
      return internalFailure("app.update", error);
    }
  }

  /**
   * Archive, not delete.
   *
   * Reports and support threads hold a foreign key to `apps`, and an app that
   * shipped and was withdrawn still has a moderation history somebody may need
   * to answer for. Archived apps drop out of the default list and come back
   * with a filter.
   */
  async setArchived(appId: string, archived: boolean, actor: ActorRef): Promise<Result<AppDetail>> {
    try {
      const existing = await this.apps.findById(appId);
      if (!existing) return notFound("アプリ");
      if (Boolean(existing.archived_at) === archived) return await this.detail(appId);

      await this.db.batch([
        this.apps.archiveStatement(appId, archived),
        this.audit.statement({
          actor,
          action: archived ? "app.archived" : "app.restored",
          targetType: "app",
          targetId: appId,
          metadata: { slug: existing.slug },
        }),
      ]);
      return await this.detail(appId);
    } catch (error) {
      return internalFailure("app.setArchived", error);
    }
  }

  async addLink(raw: unknown, actor: ActorRef): Promise<Result<AppDetail>> {
    const parsed = createAppLinkInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      if (!(await this.apps.findById(input.appId))) return notFound("アプリ");
      const id = this.apps.newId();
      await this.db.batch([
        this.apps.insertLinkStatement(input, id),
        this.audit.statement({
          actor,
          action: "app.link_added",
          targetType: "app",
          targetId: input.appId,
          metadata: { linkId: id, type: input.type },
        }),
      ]);
      return await this.detail(input.appId);
    } catch (error) {
      return internalFailure("app.addLink", error);
    }
  }

  async removeLink(linkId: string, actor: ActorRef): Promise<Result<AppDetail>> {
    try {
      const link = await this.apps.findLink(linkId);
      if (!link) return notFound("リンク");
      await this.db.batch([
        this.apps.deleteLinkStatement(linkId),
        this.audit.statement({
          actor,
          action: "app.link_removed",
          targetType: "app",
          targetId: link.app_id,
          metadata: { linkId, type: link.type },
        }),
      ]);
      return await this.detail(link.app_id);
    } catch (error) {
      return internalFailure("app.removeLink", error);
    }
  }
}
