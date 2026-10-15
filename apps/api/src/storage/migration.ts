import {
  ownerExpression,
  rewriteIdentifiers,
  type StorageTable,
  storageTables,
  tableNames,
  validatePrefix,
} from "./schema.ts";

export interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
export interface StorageSchema {
  objects: SchemaObject[];
  columns: Record<StorageTable, string[]>;
}
export interface StoragePlan {
  slug: string;
  prefix: string;
}
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Pure SQL generation: no Cloudflare credentials, no network, no database writes. */
export function storageMigration(schema: StorageSchema, plan: StoragePlan) {
  validatePrefix(plan.prefix);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(plan.slug)) throw new Error("InvalidProjectSlug");
  const names = tableNames(plan.prefix);
  const project = `(SELECT id FROM services WHERE slug=${quote(plan.slug)})`;
  const copying = `(SELECT state FROM project_storage WHERE project_id=${project})='copying'`;
  const active = `(SELECT state FROM project_storage WHERE project_id=${project})='active'`;
  const columns = (table: StorageTable) => schema.columns[table].join(",");
  const owner = (table: StorageTable) => ownerExpression(table);
  const schemaCheck = (table: StorageTable, physical = false) => {
    const name = physical ? names[table] : table;
    const allowed = schema.columns[table].map(quote).join(",");
    return `INSERT OR REPLACE INTO project_storage_checks SELECT ${project},CASE WHEN (SELECT COUNT(*) FROM pragma_table_info(${quote(name)}))=${schema.columns[table].length} AND NOT EXISTS(SELECT 1 FROM pragma_table_info(${quote(name)}) WHERE name NOT IN (${allowed})) THEN 0 ELSE 1 END;`;
  };
  const generated = (sql: string, extra: Record<string, string> = {}) =>
    rewriteIdentifiers(sql, { ...names, ...extra });
  const prepare: string[] = [
    `-- Storage schema v1; generated for deployment-owned prefix ${plan.prefix}.`,
    `INSERT OR IGNORE INTO project_storage(project_id,table_prefix,schema_version) VALUES(${project},${quote(plan.prefix)},1);`,
    // Reusing a slug/prefix with a different pairing is always an error.
    `INSERT OR REPLACE INTO project_storage_checks SELECT ${project}, CASE WHEN EXISTS(SELECT 1 FROM project_storage WHERE project_id=${project} AND table_prefix=${quote(plan.prefix)} AND schema_version=1) THEN 0 ELSE 1 END;`,
  ];
  for (const table of storageTables) {
    const ddl = schema.objects.find((o) => o.type === "table" && o.name === table)?.sql;
    if (!ddl || !schema.columns[table]?.length) throw new Error(`MissingStorageSchema:${table}`);
    prepare.push(
      `${generated(ddl).replace(/^CREATE TABLE (?!IF NOT EXISTS)/i, "CREATE TABLE IF NOT EXISTS ")};`,
    );
    for (const index of schema.objects.filter(
      (o) => o.type === "index" && o.tbl_name === table && o.sql,
    )) {
      if (!index.sql) continue;
      prepare.push(
        `${generated(index.sql, { [index.name]: `${plan.prefix}_${index.name}` }).replace(/^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i, "CREATE $1INDEX IF NOT EXISTS ")};`,
      );
    }
    prepare.push(schemaCheck(table), schemaCheck(table, true));
    const keys =
      table === "support_thread_redirects"
        ? ["source_thread_id"]
        : table === "support_reply_sends" || table === "support_reply_attempts"
          ? ["idempotency_key"]
          : table === "support_drafts"
            ? ["thread_id"]
            : table === "ticket_sources"
              ? ["source_type", "source_id"]
              : ["id"];
    const parentChecks: string[] = [];
    for (const match of ddl.matchAll(
      /\b(\w+)\s+(?:TEXT|INTEGER|REAL|BLOB)\b[^,]*?\bREFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)/gi,
    )) {
      const [, column, parent, key] = match;
      if (storageTables.includes(parent as StorageTable))
        parentChecks.push(
          `(NEW.${column} IS NULL OR EXISTS(SELECT 1 FROM ${names[parent as StorageTable]} WHERE ${key}=NEW.${column}))`,
        );
    }
    const conflict = keys.join(",");
    const upsert = `INSERT INTO ${names[table]}(${columns(table)}) VALUES(${schema.columns[table].map((c) => `NEW.${c}`).join(",")}) ON CONFLICT(${conflict}) DO UPDATE SET ${schema.columns[
      table
    ]
      .filter((c) => !keys.includes(c))
      .map((c) => `${c}=excluded.${c}`)
      .join(",")};`;
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      const owns = owner(table).replaceAll("r.", `${row}.`);
      // Fence is permanent after cutover; stale Workers fail before accepting.
      prepare.push(
        `CREATE TRIGGER IF NOT EXISTS ${plan.prefix}_fence_${table}_${event} BEFORE ${event} ON ${table} WHEN ${active} AND ((${owns})=${project}${event === "UPDATE" ? ` OR (${owner(table).replaceAll("r.", "OLD.")})=${project}` : ""})\nBEGIN\nSELECT RAISE(ABORT,'ProjectStorageMoved');\nEND;`,
      );
      const copy =
        event === "DELETE"
          ? `DELETE FROM ${names[table]} WHERE ${keys.map((k) => `${k}=OLD.${k}`).join(" AND ")};`
          : upsert;
      prepare.push(
        `CREATE TRIGGER IF NOT EXISTS ${plan.prefix}_mirror_${table}_${event} AFTER ${event} ON ${table} WHEN ${copying} AND (${owns})=${project}${event === "DELETE" || !parentChecks.length ? "" : ` AND ${parentChecks.join(" AND ")}`}\nBEGIN\n${copy}\nEND;`,
      );
    }
  }
  prepare.push(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${plan.prefix}_form_idempotency ON ${names.support_messages}(provider_message_id) WHERE direction='inbound' AND provider_message_id LIKE 'form-%';`,
  );
  // Install the existing projection triggers in each physical table set. Their
  // SQL is generated once from the versioned schema, not copied per product.
  for (const trigger of schema.objects.filter(
    (o) =>
      o.type === "trigger" &&
      storageTables.includes(o.tbl_name as StorageTable) &&
      o.sql &&
      !o.name.includes("_mirror_") &&
      !o.name.includes("_fence_") &&
      !o.name.startsWith("sealed_"),
  )) {
    if (!trigger.sql) continue;
    const sql = generated(trigger.sql, {
      [trigger.name]: `${plan.prefix}_${trigger.name}`,
    }).replace(/^CREATE TRIGGER (?!IF NOT EXISTS)/i, "CREATE TRIGGER IF NOT EXISTS ");
    const [header = "", ...body] = sql.split(/\bBEGIN\b/i);
    const conditioned = /\bWHEN\b/i.test(header)
      ? `${header.replace(/\bWHEN\b/i, `WHEN ${active} AND (`)}) `
      : `${header} WHEN ${active} `;
    prepare.push(`${conditioned}BEGIN${body.join("BEGIN")};`);
  }
  // Enforce project ownership even when a new repository accidentally supplies
  // another registered app. Child references are enforced by physical FKs.
  for (const [table, field] of [
    ["tickets", "service_id"],
    ["reports", "app_id"],
    ["support_threads", "app_id"],
  ] as const) {
    for (const event of ["INSERT", "UPDATE"]) {
      prepare.push(
        `CREATE TRIGGER IF NOT EXISTS ${plan.prefix}_owner_${table}_${event} BEFORE ${event} ON ${names[table]} WHEN NEW.${field} IS NOT NULL AND NEW.${field}<>${project}\nBEGIN\nSELECT RAISE(ABORT,'ProjectOwnershipMismatch');\nEND;`,
      );
    }
  }
  for (const table of ["tickets", "reports", "support_threads", "support_messages"] as const) {
    const kind = {
      tickets: "ticket",
      reports: "report",
      support_threads: "thread",
      support_messages: "message",
    }[table];
    prepare.push(
      `CREATE TRIGGER IF NOT EXISTS ${plan.prefix}_identity_${table} BEFORE INSERT ON ${names[table]}\nBEGIN\nSELECT CASE WHEN EXISTS(SELECT 1 FROM project_record_ids WHERE kind=${quote(kind)} AND id=NEW.id AND project_id<>${project}) THEN RAISE(ABORT,'ProjectIdCollision') END;\nINSERT OR IGNORE INTO project_record_ids VALUES(${quote(kind)},NEW.id,${project});\nEND;`,
    );
    prepare.push(
      `INSERT OR IGNORE INTO project_record_ids SELECT ${quote(kind)},r.id,${owner(table)} FROM ${table} r WHERE ${owner(table)} IS NOT NULL;`,
    );
  }

  /** Replay each table's statement until no rows change, parent tables first.
   * Mirrors are installed before copying; only missing or different rows are copied. */
  function backfill(table: StorageTable, limit?: number): string {
    if (!storageTables.includes(table)) throw new Error("InvalidStorageTable");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000))
      throw new Error("InvalidBackfillLimit");
    const keys =
      table === "support_thread_redirects"
        ? ["source_thread_id"]
        : table === "support_reply_sends" || table === "support_reply_attempts"
          ? ["idempotency_key"]
          : table === "support_drafts"
            ? ["thread_id"]
            : table === "ticket_sources"
              ? ["source_type", "source_id"]
              : ["id"];
    const identical = schema.columns[table].map((c) => `d.${c} IS r.${c}`).join(" AND ");
    const updates = schema.columns[table]
      .filter((c) => !keys.includes(c))
      .map((c) => `${c}=excluded.${c}`)
      .join(",");
    // D1 serializes this SELECT and upsert as one write statement. While
    // copying, the legacy source is authoritative; no older snapshot can
    // overwrite a concurrent mirror. Repair a previously deferred update as
    // soon as its physical parent has been copied.
    return `INSERT INTO ${names[table]}(${columns(table)}) SELECT ${schema.columns[table].map((c) => `r.${c}`).join(",")} FROM ${table} r WHERE ${copying} AND (${owner(table)})=${project} AND NOT EXISTS(SELECT 1 FROM ${names[table]} d WHERE ${keys.map((k) => `d.${k}=r.${k}`).join(" AND ")} AND ${identical}) ORDER BY r.rowid${limit ? ` LIMIT ${limit}` : ""} ON CONFLICT(${keys.join(",")}) DO UPDATE SET ${updates};`;
  }
  const differences = storageTables.map((table) => {
    const source = `SELECT ${columns(table)} FROM ${table} r WHERE (${owner(table)})=${project}`;
    const destination = `SELECT ${columns(table)} FROM ${names[table]}`;
    return {
      table,
      sql: `SELECT ${quote(table)} AS table_name, (SELECT COUNT(*) FROM (${source})) AS source_count,(SELECT COUNT(*) FROM (${destination})) AS destination_count,((SELECT COUNT(*) FROM (${source} EXCEPT ${destination}))+(SELECT COUNT(*) FROM (${destination} EXCEPT ${source}))) AS mismatches`,
    };
  });
  const verify = `${differences.map((d) => d.sql).join(";\n")};`;
  const cutover = [
    `-- Execute as ONE D1 batch/migration. Any failed assertion rolls it back.`,
    ...storageTables.flatMap((table) => [schemaCheck(table), schemaCheck(table, true)]),
    ...differences.map(
      (d) =>
        `INSERT OR REPLACE INTO project_storage_checks SELECT ${project},mismatches FROM (${d.sql}) WHERE ${copying};`,
    ),
    `INSERT OR REPLACE INTO project_storage_checks SELECT ${project},COUNT(*) FROM pragma_foreign_key_check WHERE "table" IN (${Object.values(names).map(quote).join(",")}) AND ${copying} HAVING COUNT(*)>0;`,
    `UPDATE project_storage SET state='active',activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE project_id=${project} AND ${copying};`,
  ].join("\n");
  return {
    prepare: prepare.join("\n\n"),
    backfill,
    copy: storageTables.map((t) => backfill(t)).join("\n"),
    verify,
    cutover,
    tables: Object.values(names),
  };
}

export function sealStorageSql(): string {
  return `-- Apply as one batch after every service, including unassigned, is active.
INSERT OR REPLACE INTO project_storage_checks VALUES('all', (SELECT COUNT(*) FROM services s WHERE s.is_active=1 AND NOT EXISTS(SELECT 1 FROM project_storage p WHERE p.project_id=s.id AND p.state='active')));
INSERT INTO platform_settings(key,value) VALUES('project_storage_required','1') ON CONFLICT(key) DO UPDATE SET value='1';
`;
}
