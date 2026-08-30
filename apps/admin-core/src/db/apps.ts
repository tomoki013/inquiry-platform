import type {
  AppDetail,
  AppLink,
  AppLinkType,
  AppPlatform,
  AppStatus,
  AppSummary,
  CreateAppInput,
  CreateAppLinkInput,
  UpdateAppInput,
} from "@tomokichi/admin-contracts";
import { newId, nowIso } from "@tomokichi/admin-contracts";

/**
 * Every statement that touches `apps` or `app_links`.
 *
 * SQL lives only in this directory. A route handler or a React component that
 * could write a query would be a route handler that could write the wrong one,
 * and the whole point of Admin Core is that callers never learn the schema.
 */
interface AppRow {
  id: string;
  slug: string;
  name: string;
  platform: string;
  status: string;
  description: string | null;
  bundle_id: string | null;
  public_url: string | null;
  support_url: string | null;
  app_store_url: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface AppLinkRow {
  id: string;
  app_id: string;
  type: string;
  label: string;
  url: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const text = (value: string | null): string | undefined => value ?? undefined;

function toLink(row: AppLinkRow): AppLink {
  return {
    id: row.id,
    appId: row.app_id,
    type: row.type as AppLinkType,
    label: row.label,
    url: row.url,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AppRepository {
  constructor(private readonly db: D1Database) {}

  async findById(id: string): Promise<AppRow | null> {
    return await this.db.prepare("SELECT * FROM apps WHERE id = ?").bind(id).first<AppRow>();
  }

  async findBySlug(slug: string): Promise<AppRow | null> {
    return await this.db.prepare("SELECT * FROM apps WHERE slug = ?").bind(slug).first<AppRow>();
  }

  /**
   * The list the Apps page and the Dashboard both read.
   *
   * The two counts are subqueries rather than a second round trip per app: at
   * this size that is one statement instead of `2n + 1`, and the numbers are
   * consistent with each other because they came from one snapshot.
   */
  async listSummaries(includeArchived: boolean): Promise<AppSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.*,
                (SELECT COUNT(*) FROM reports r
                  WHERE r.app_id = a.id AND r.status IN ('open','reviewing')) AS open_reports,
                (SELECT COUNT(*) FROM support_threads s
                  WHERE s.app_id = a.id AND s.status IN ('open','pending_user')) AS open_support
           FROM apps a
          WHERE (? = 1 OR a.archived_at IS NULL)
          ORDER BY a.archived_at IS NOT NULL, a.name COLLATE NOCASE`,
      )
      .bind(includeArchived ? 1 : 0)
      .all<AppRow & { open_reports: number; open_support: number }>();

    return results.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      platform: row.platform as AppPlatform,
      status: row.status as AppStatus,
      openReports: row.open_reports,
      openSupport: row.open_support,
      updatedAt: row.updated_at,
      archivedAt: text(row.archived_at),
    }));
  }

  async links(appId: string): Promise<AppLink[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM app_links WHERE app_id = ? ORDER BY sort_order, label COLLATE NOCASE")
      .bind(appId)
      .all<AppLinkRow>();
    return results.map(toLink);
  }

  async detail(id: string): Promise<AppDetail | null> {
    const row = await this.db
      .prepare(
        `SELECT a.*,
                (SELECT COUNT(*) FROM reports r
                  WHERE r.app_id = a.id AND r.status IN ('open','reviewing')) AS open_reports,
                (SELECT COUNT(*) FROM support_threads s
                  WHERE s.app_id = a.id AND s.status IN ('open','pending_user')) AS open_support
           FROM apps a WHERE a.id = ?`,
      )
      .bind(id)
      .first<AppRow & { open_reports: number; open_support: number }>();
    if (!row) return null;

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      platform: row.platform as AppPlatform,
      status: row.status as AppStatus,
      description: text(row.description),
      bundleId: text(row.bundle_id),
      publicUrl: text(row.public_url),
      supportUrl: text(row.support_url),
      appStoreUrl: text(row.app_store_url),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: text(row.archived_at),
      openReports: row.open_reports,
      openSupport: row.open_support,
      links: await this.links(id),
    };
  }

  insertStatement(input: CreateAppInput, id: string): D1PreparedStatement {
    const at = nowIso();
    return this.db
      .prepare(
        `INSERT INTO apps
           (id, slug, name, platform, status, description, bundle_id,
            public_url, support_url, app_store_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.slug,
        input.name,
        input.platform,
        input.status,
        input.description ?? null,
        input.bundleId ?? null,
        input.publicUrl ?? null,
        input.supportUrl ?? null,
        input.appStoreUrl ?? null,
        at,
        at,
      );
  }

  /**
   * A partial update, built from the keys the caller actually sent.
   *
   * `undefined` means "leave alone" and is dropped here; a caller that wants to
   * clear a field sends an empty string, which the contract's schema has
   * already turned into `undefined`… so clearing goes through the same path and
   * writes NULL. That is the one asymmetry worth knowing about, and it is why
   * `slug` is not updatable at all.
   */
  updateStatement(id: string, input: UpdateAppInput): D1PreparedStatement | null {
    const columns: Record<string, unknown> = {
      name: input.name,
      platform: input.platform,
      status: input.status,
      description: input.description ?? null,
      bundle_id: input.bundleId ?? null,
      public_url: input.publicUrl ?? null,
      support_url: input.supportUrl ?? null,
      app_store_url: input.appStoreUrl ?? null,
    };
    const provided = new Set(Object.keys(input));
    const columnFor: Record<string, string> = {
      name: "name",
      platform: "platform",
      status: "status",
      description: "description",
      bundleId: "bundle_id",
      publicUrl: "public_url",
      supportUrl: "support_url",
      appStoreUrl: "app_store_url",
    };
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columnFor)) {
      if (!provided.has(key)) continue;
      assignments.push(`${column} = ?`);
      values.push(columns[column] ?? null);
    }
    if (assignments.length === 0) return null;
    assignments.push("updated_at = ?");
    values.push(nowIso(), id);
    return this.db
      .prepare(`UPDATE apps SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values);
  }

  archiveStatement(id: string, archived: boolean): D1PreparedStatement {
    const at = nowIso();
    return this.db
      .prepare("UPDATE apps SET archived_at = ?, updated_at = ? WHERE id = ?")
      .bind(archived ? at : null, at, id);
  }

  insertLinkStatement(input: CreateAppLinkInput, id: string): D1PreparedStatement {
    const at = nowIso();
    return this.db
      .prepare(
        `INSERT INTO app_links (id, app_id, type, label, url, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.appId, input.type, input.label, input.url, input.sortOrder, at, at);
  }

  async findLink(id: string): Promise<AppLinkRow | null> {
    return await this.db
      .prepare("SELECT * FROM app_links WHERE id = ?")
      .bind(id)
      .first<AppLinkRow>();
  }

  /**
   * The only `DELETE` in this codebase, and it is for a row an operator typed
   * by hand a moment ago. Apps, reports and threads are archived or closed
   * instead — see the deletion policy in the design.
   */
  deleteLinkStatement(id: string): D1PreparedStatement {
    return this.db.prepare("DELETE FROM app_links WHERE id = ?").bind(id);
  }

  newId(): string {
    return newId();
  }
}
