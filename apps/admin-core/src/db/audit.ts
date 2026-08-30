import type {
  ActorRef,
  AuditActorType,
  AuditEntry,
  AuditTargetType,
  ListAuditInput,
} from "@tomokichi/admin-contracts";
import { assertSafeAuditMetadata, newId, nowIso } from "@tomokichi/admin-contracts";

export interface AuditWrite {
  actor: ActorRef;
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  metadata?: Record<string, string | number | boolean>;
}

interface AuditRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  metadata_json: string;
  created_at: string;
}

export class AuditRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Returns a statement rather than running one, so the caller can put it in
   * the same `db.batch()` as the change it describes. An audit row that lands
   * without its change — or a change without its audit row — is worse than
   * either failing.
   */
  statement(write: AuditWrite): D1PreparedStatement {
    const metadata = write.metadata ?? {};
    // Throws rather than sanitising: a call site trying to log a message body
    // is a bug to fix, not a value to quietly drop.
    assertSafeAuditMetadata(metadata);
    return this.db
      .prepare(
        `INSERT INTO audit_logs
           (id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        write.actor.type,
        write.actor.id ?? null,
        write.action,
        write.targetType,
        write.targetId,
        JSON.stringify(metadata),
        nowIso(),
      );
  }

  async list(input: ListAuditInput): Promise<AuditEntry[]> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (input.targetType) {
      where.push("target_type = ?");
      values.push(input.targetType);
    }
    if (input.targetId) {
      where.push("target_id = ?");
      values.push(input.targetId);
    }
    if (input.appId) {
      // Everything belonging to one app: its own row, plus every report and
      // thread that points at it. The joins live here because Admin Core is the
      // only thing that knows them — an "activity" table duplicating this would
      // be a second source of truth to keep in step.
      where.push(`(
        (target_type = 'app' AND target_id = ?)
        OR (target_type = 'report' AND target_id IN (SELECT id FROM reports WHERE app_id = ?))
        OR (target_type = 'support_thread'
            AND target_id IN (SELECT id FROM support_threads WHERE app_id = ?))
      )`);
      values.push(input.appId, input.appId, input.appId);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const { results } = await this.db
      .prepare(
        `SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...values, input.limit, input.offset)
      .all<AuditRow>();

    return results.map((row) => ({
      id: row.id,
      actorType: row.actor_type as AuditActorType,
      actorId: row.actor_id ?? undefined,
      action: row.action,
      targetType: row.target_type as AuditTargetType,
      targetId: row.target_id,
      metadata: safeParse(row.metadata_json),
      createdAt: row.created_at,
    }));
  }
}

function safeParse(json: string): Record<string, string | number | boolean> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string | number | boolean>)
      : {};
  } catch {
    return {};
  }
}
