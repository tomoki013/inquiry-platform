import type { Scope } from "../domain/scope";
import { type PrivateCipher, privateDatabase } from "../privacy/crypto";
import {
  ownerExpression,
  rewriteIdentifiers,
  type StorageTable,
  storageTables,
  tableNames,
  validatePrefix,
} from "./schema";

export interface ProjectStorage {
  project_id: string;
  table_prefix: string;
  schema_version: number;
  state: "copying" | "active";
}

/** A registry is invocation-local. Never cache its state across RPCs or cutover. */
export class ProjectRegistry {
  constructor(
    readonly raw: D1Database,
    private readonly cipher?: PrivateCipher,
  ) {}

  async entries(): Promise<ProjectStorage[]> {
    const rows = await this.raw
      .prepare("SELECT * FROM project_storage ORDER BY project_id")
      .all<ProjectStorage>();
    for (const row of rows.results) {
      validatePrefix(row.table_prefix);
      if (row.schema_version !== 1) throw new Error("UnsupportedStorageSchema");
    }
    return rows.results;
  }

  async forProject(projectId: string): Promise<D1Database> {
    const registered = await this.raw
      .prepare("SELECT id FROM services WHERE id=? AND is_active=1")
      .bind(projectId)
      .first();
    if (!registered) throw new Error("UnknownStorageProject");
    const entry = (await this.entries()).find((row) => row.project_id === projectId);
    if (entry?.state === "active")
      return privateDatabase(
        projectDatabase(this.raw, entry),
        this.cipher,
        entry.project_id,
        false,
      );
    const required = await this.raw
      .prepare("SELECT value FROM platform_settings WHERE key='project_storage_required'")
      .first<{ value: string }>();
    if (required?.value === "1") throw new Error("ProjectStorageUnavailable");
    return privateDatabase(this.raw, this.cipher, projectId, false);
  }

  async forSlug(slug: unknown): Promise<D1Database> {
    if (slug !== undefined && (typeof slug !== "string" || !slug))
      throw new Error("UnknownStorageProject");
    const row =
      slug === undefined
        ? await this.raw
            .prepare(
              "SELECT COALESCE((SELECT value FROM platform_settings WHERE key='default_service_id'),'unassigned') AS id",
            )
            .first<{ id: string }>()
        : await this.raw
            .prepare("SELECT id FROM apps WHERE slug=? AND archived_at IS NULL")
            .bind(slug)
            .first<{ id: string }>();
    if (!row) throw new Error("UnknownStorageProject");
    return this.forProject(row.id);
  }

  /** Old id-only APIs fail closed on ambiguity, including accidental UUID collisions. */
  async forRecord(
    kind: "ticket" | "thread" | "report" | "message",
    ref: unknown,
    scope?: Scope,
  ): Promise<D1Database | null> {
    if (typeof ref !== "string" || !ref || ref.length > 200) return null;
    const table = {
      ticket: "tickets",
      thread: "support_threads",
      report: "reports",
      message: "support_messages",
    }[kind];
    // The aggregate carries ownership as a hidden column so no second lookup
    // can attach a colliding id to a different project.
    const db = aggregateDatabase(this, scope);
    const rows = await db
      .prepare(
        `SELECT __project_id FROM ${table} r WHERE r.id=?${kind === "ticket" ? " OR r.ticket_number=?" : ""} LIMIT 2`,
      )
      .bind(ref, ...(kind === "ticket" ? [ref] : []))
      .all<{ __project_id: string }>();
    const row = rows.results[0];
    return rows.results.length === 1 && row ? this.forProject(row.__project_id) : null;
  }
}

export function projectDatabase(raw: D1Database, entry: ProjectStorage): D1Database {
  if (entry.state !== "active") throw new Error("ProjectStorageNotActive");
  const names = tableNames(entry.table_prefix);
  return {
    prepare: (sql: string) => raw.prepare(rewriteIdentifiers(sql, names)),
    batch: <T>(statements: D1PreparedStatement[]) => raw.batch<T>(statements),
  } as D1Database;
}

/** Application-layer read aggregation. There is no shared writable case table.
 * Only server-authored SQL reaches this adapter. It never chooses a write target. */
export function aggregateDatabase(
  registry: ProjectRegistry,
  access?: Scope | Promise<Scope>,
): D1Database {
  const raw = registry.raw;
  function union(parts: string[]): string {
    if (parts.length <= 5) return parts.join(" UNION ALL ");
    const groups: string[] = [];
    for (let i = 0; i < parts.length; i += 5)
      groups.push(`SELECT * FROM (${union(parts.slice(i, i + 5))})`);
    return union(groups);
  }
  async function expand(sql: string): Promise<string> {
    const mentioned = new Set<string>();
    // Tokenizer also protects string constants such as source_type='support'.
    const marker = Object.fromEntries(
      storageTables.map((table) => [table, `__storage_${table}__`]),
    );
    const marked = rewriteIdentifiers(sql, marker);
    for (const table of storageTables)
      if (marked.includes(`__storage_${table}__`)) mentioned.add(table);
    if (!mentioned.size) return sql;
    const target =
      /^(?:\s*)(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:main\.)?([a-z_]+)/i.exec(
        sql,
      )?.[1];
    if (target && mentioned.has(target)) throw new Error("AggregateStorageIsReadOnly");
    const scope = await access;
    const entries = await registry.entries();
    const required =
      (
        await raw
          .prepare("SELECT value FROM platform_settings WHERE key='project_storage_required'")
          .first<{ value: string }>()
      )?.value === "1";
    const active = entries.filter((row) => row.state === "active");
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const ctes = [...mentioned].map((name) => {
      const table = name as StorageTable;
      const owner = ownerExpression(table);
      const legacy = [
        `SELECT r.*,${owner} AS __project_id FROM main.${table} r WHERE ${required ? "0" : `NOT EXISTS(SELECT 1 FROM project_storage ps WHERE ps.state='active' AND ps.project_id=${owner})`}`,
      ];
      if (scope?.limited) {
        const where = scope.where(owner);
        if (!where) throw new Error("InvalidStorageScope");
        let index = 0;
        legacy[0] += ` AND (${where.sql.replaceAll("?", () => literal(where.values[index++] ?? ""))})`;
      }
      const parts = active
        .filter((entry) => !scope || scope.has(entry.project_id))
        .map(
          (entry) =>
            `SELECT r.*,${literal(entry.project_id)} AS __project_id FROM ${tableNames(entry.table_prefix)[table]} r`,
        );
      return `${table} AS (${union([...legacy, ...parts])})`;
    });
    const expanded = `WITH ${ctes.join(",")} ${sql}`;
    if (new TextEncoder().encode(expanded).byteLength > 95_000)
      throw new Error("StorageAggregationLimit: select fewer projects");
    return expanded;
  }
  class Statement {
    constructor(
      readonly sql: string,
      readonly values: unknown[] = [],
    ) {}
    bind(...values: unknown[]) {
      return new Statement(this.sql, values);
    }
    async physical() {
      return raw.prepare(await expand(this.sql)).bind(...this.values);
    }
    async all<T>() {
      const result = await (await this.physical()).all<T>();
      if (!this.sql.includes("__project_id"))
        result.results = result.results.map((row) => {
          if (row && typeof row === "object") {
            const { __project_id: _owner, ...rest } = row as Record<string, unknown>;
            return rest as T;
          }
          return row;
        });
      return result;
    }
    async first<T>(column?: string) {
      const stmt = await this.physical();
      const row = column === undefined ? await stmt.first<T>() : await stmt.first<T>(column);
      if (
        column === undefined &&
        !this.sql.includes("__project_id") &&
        row &&
        typeof row === "object"
      ) {
        const { __project_id: _owner, ...rest } = row as Record<string, unknown>;
        return rest as T;
      }
      return row;
    }
    async run<T>() {
      return (await this.physical()).run<T>();
    }
    async raw<T>() {
      return (await this.physical()).raw<T>();
    }
  }
  return {
    prepare: (sql: string) => new Statement(sql),
    batch: async <T>(statements: Statement[]) => {
      const results = await raw.batch<T>(await Promise.all(statements.map((s) => s.physical())));
      results.forEach((result, index) => {
        if (!statements[index]?.sql.includes("__project_id"))
          result.results = result.results.map((row) => {
            if (row && typeof row === "object") {
              const { __project_id: _owner, ...rest } = row as Record<string, unknown>;
              return rest as T;
            }
            return row;
          });
      });
      return results;
    },
  } as unknown as D1Database;
}
