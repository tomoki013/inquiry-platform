import type {
  AppMailSettings,
  CreateReplyTemplateInput,
  ListReplyTemplatesInput,
  ReplyTemplate,
  ReplyTemplateCategory,
  UpdateReplyTemplateInput,
} from "@tomokichi/admin-contracts";
import { newId, nowIso } from "@tomokichi/admin-contracts";

interface TemplateRow {
  id: string;
  key: string;
  name: string;
  category: string;
  app_id: string | null;
  body: string;
  include_signature: number;
  is_active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  app_slug: string | null;
}

function toTemplate(row: TemplateRow): ReplyTemplate {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    category: row.category as ReplyTemplateCategory,
    appId: row.app_id ?? undefined,
    appSlug: row.app_slug ?? undefined,
    body: row.body,
    includeSignature: row.include_signature === 1,
    isActive: row.is_active === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_TEMPLATE = `
  SELECT t.*, a.slug AS app_slug
    FROM reply_templates t LEFT JOIN apps a ON a.id = t.app_id`;

export class TemplateRepository {
  constructor(private readonly db: D1Database) {}

  async find(id: string): Promise<ReplyTemplate | null> {
    const row = await this.db
      .prepare(`${SELECT_TEMPLATE} WHERE t.id = ?`)
      .bind(id)
      .first<TemplateRow>();
    return row ? toTemplate(row) : null;
  }

  async findByKey(key: string): Promise<ReplyTemplate | null> {
    const row = await this.db
      .prepare(`${SELECT_TEMPLATE} WHERE t.key = ?`)
      .bind(key)
      .first<TemplateRow>();
    return row ? toTemplate(row) : null;
  }

  /**
   * What the composer offers while a thread is open: this app's templates and
   * the Studio-wide ones, app-specific first because the more specific answer is
   * usually the right one. Inactive templates are absent unless asked for.
   */
  async list(input: ListReplyTemplatesInput): Promise<ReplyTemplate[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (input.forAppId) {
      where.push("(t.app_id = ? OR t.app_id IS NULL)");
      values.push(input.forAppId);
    }
    if (!input.includeInactive) where.push("t.is_active = 1");
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const { results } = await this.db
      .prepare(
        `${SELECT_TEMPLATE} ${clause}
          ORDER BY t.app_id IS NULL, t.sort_order, t.name COLLATE NOCASE`,
      )
      .bind(...values)
      .all<TemplateRow>();
    return results.map(toTemplate);
  }

  async insert(input: CreateReplyTemplateInput): Promise<string> {
    const id = newId();
    const at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO reply_templates
           (id, key, name, category, app_id, body, include_signature,
            is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.key,
        input.name,
        input.category,
        input.appId ?? null,
        input.body,
        input.includeSignature ? 1 : 0,
        input.isActive ? 1 : 0,
        input.sortOrder,
        at,
        at,
      )
      .run();
    return id;
  }

  async update(id: string, input: UpdateReplyTemplateInput): Promise<void> {
    const columnFor: Record<string, string> = {
      name: "name",
      category: "category",
      appId: "app_id",
      body: "body",
      includeSignature: "include_signature",
      isActive: "is_active",
      sortOrder: "sort_order",
    };
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columnFor)) {
      if (!(key in input)) continue;
      const raw = (input as Record<string, unknown>)[key];
      assignments.push(`${column} = ?`);
      values.push(typeof raw === "boolean" ? (raw ? 1 : 0) : (raw ?? null));
    }
    if (assignments.length === 0) return;
    assignments.push("updated_at = ?");
    values.push(nowIso(), id);
    await this.db
      .prepare(`UPDATE reply_templates SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  /**
   * Deactivation, never deletion. A template that was used to write a reply
   * three months ago has nothing to do with that reply any more — the finished
   * text was stored on the message — but the operator's list of what exists is
   * still history worth keeping.
   */
  async deactivate(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE reply_templates SET is_active = 0, updated_at = ? WHERE id = ?")
      .bind(nowIso(), id)
      .run();
  }

  // ---- signatures --------------------------------------------------------

  async signature(appId: string | undefined): Promise<string | undefined> {
    if (appId) {
      const own = await this.db
        .prepare("SELECT signature_text FROM app_mail_settings WHERE app_id = ?")
        .bind(appId)
        .first<{ signature_text: string }>();
      if (own) return own.signature_text;
    }
    const fallback = await this.db
      .prepare("SELECT signature_text FROM app_mail_settings WHERE app_id IS NULL")
      .first<{ signature_text: string }>();
    return fallback?.signature_text;
  }

  async listSettings(): Promise<AppMailSettings[]> {
    const { results } = await this.db
      .prepare(
        "SELECT app_id, signature_text, updated_at FROM app_mail_settings ORDER BY app_id IS NULL DESC",
      )
      .all<{ app_id: string | null; signature_text: string; updated_at: string }>();
    return results.map((row) => ({
      appId: row.app_id ?? undefined,
      signatureText: row.signature_text,
      updatedAt: row.updated_at,
    }));
  }

  async setSettings(appId: string | null, signatureText: string): Promise<AppMailSettings> {
    const at = nowIso();
    // No `ON CONFLICT` target here: the uniqueness is an expression index over
    // `COALESCE(app_id, '')`, which SQLite cannot name as a conflict target, so
    // the update-then-insert is written out.
    const updated = await this.db
      .prepare(
        `UPDATE app_mail_settings SET signature_text = ?, updated_at = ?
          WHERE COALESCE(app_id, '') = COALESCE(?, '')`,
      )
      .bind(signatureText, at, appId)
      .run();
    if ((updated.meta.changes ?? 0) === 0) {
      await this.db
        .prepare(
          "INSERT INTO app_mail_settings (app_id, signature_text, updated_at) VALUES (?, ?, ?)",
        )
        .bind(appId, signatureText, at)
        .run();
    }
    return { appId: appId ?? undefined, signatureText, updatedAt: at };
  }
}
