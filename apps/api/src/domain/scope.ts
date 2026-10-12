import { adminCorePropsSchema } from "@inquiry-platform/core";

/**
 * The service a support thread is filed under: its app, else the deployment's
 * default service, else `unassigned` — the same rule the ticket trigger uses
 * (migration 0010), so a thread and its ticket are always in the same scope.
 * Expects the thread as `t`.
 */
export const THREAD_SERVICE =
  "COALESCE(t.app_id,(SELECT value FROM platform_settings WHERE key='default_service_id'),'unassigned')";

/**
 * Which services an `AdminCore` caller may see and change.
 *
 * Decided by the deployment, in the binding's `props` (`adminCorePropsSchema`),
 * never by a request. `Scope.all` is a binding without a scope: the whole
 * deployment, which is every binding that existed before scopes did. A scope
 * that is present but malformed resolves to nothing rather than to everything.
 *
 * Out-of-scope records are reported as missing, not forbidden, so a scoped
 * console cannot learn that another service's ticket number exists.
 */
export class Scope {
  static readonly all = new Scope(null);
  static service(id: string): Scope {
    return new Scope(new Set([id]));
  }

  private constructor(private readonly ids: ReadonlySet<string> | null) {}

  static async resolve(db: D1Database, props: unknown): Promise<Scope> {
    const parsed = adminCorePropsSchema.safeParse(props ?? {});
    if (!parsed.success) return new Scope(new Set());
    const slugs = parsed.data.scope?.services;
    if (!slugs) return Scope.all;
    const { results } = await db
      .prepare(`SELECT id FROM services WHERE slug IN (${slugs.map(() => "?").join(",")})`)
      .bind(...slugs)
      .all<{ id: string }>();
    return new Scope(new Set(results.map((row) => row.id)));
  }

  /** True when this caller is limited to some services. */
  get limited(): boolean {
    return this.ids !== null;
  }

  has(serviceId: string | null | undefined): boolean {
    if (this.ids === null) return true;
    return typeof serviceId === "string" && this.ids.has(serviceId);
  }

  /** `expression IN (…)` for a SQL filter, or `null` when nothing is filtered. */
  where(expression: string): { sql: string; values: string[] } | null {
    if (this.ids === null) return null;
    if (this.ids.size === 0) return { sql: "0", values: [] };
    const values = [...this.ids];
    return { sql: `${expression} IN (${values.map(() => "?").join(",")})`, values };
  }

  // ---- Ownership, for the records a request names by id --------------------

  async ticket(db: D1Database, ref: string): Promise<boolean> {
    if (!this.limited) return true;
    const row = await db
      .prepare("SELECT service_id FROM tickets WHERE id=? OR ticket_number=?")
      .bind(ref, ref)
      .first<{ service_id: string }>();
    return this.has(row?.service_id);
  }

  async report(db: D1Database, reportId: string): Promise<boolean> {
    if (!this.limited) return true;
    const row = await db
      .prepare("SELECT app_id FROM reports WHERE id=?")
      .bind(reportId)
      .first<{ app_id: string }>();
    return this.has(row?.app_id);
  }

  /** Follows a redirect the way `SupportRepository.detail` does. */
  async thread(db: D1Database, threadId: string): Promise<boolean> {
    if (!this.limited) return true;
    const row = await db
      .prepare(
        `SELECT ${THREAD_SERVICE} AS service_id FROM support_threads t
          WHERE t.id=COALESCE((SELECT target_thread_id FROM support_thread_redirects WHERE source_thread_id=?),?)`,
      )
      .bind(threadId, threadId)
      .first<{ service_id: string }>();
    return this.has(row?.service_id);
  }

  async message(db: D1Database, messageId: string): Promise<boolean> {
    if (!this.limited) return true;
    const row = await db
      .prepare("SELECT thread_id FROM support_messages WHERE id=?")
      .bind(messageId)
      .first<{ thread_id: string }>();
    return row ? this.thread(db, row.thread_id) : false;
  }

  /** A deployment-wide template (no app) is visible to every scope, but only
   * an unscoped caller may change it. */
  async template(db: D1Database, templateId: string, write: boolean): Promise<boolean> {
    if (!this.limited) return true;
    const row = await db
      .prepare("SELECT app_id FROM reply_templates WHERE id=?")
      .bind(templateId)
      .first<{ app_id: string | null }>();
    if (!row) return false;
    return row.app_id === null ? !write : this.has(row.app_id);
  }

  async link(db: D1Database, linkId: string): Promise<boolean> {
    if (!this.limited) return true;
    const row = await db
      .prepare("SELECT app_id FROM app_links WHERE id=?")
      .bind(linkId)
      .first<{ app_id: string }>();
    return this.has(row?.app_id);
  }
}
