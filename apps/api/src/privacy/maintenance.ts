import type { AdminCoreEnv } from "../env";
import { ownerExpression, type StorageTable, tableNames } from "../storage/schema";
import { privateCipher } from "./crypto";
import { privateBucket } from "./files";

/** Only the unscoped Core can invoke this. Values and keys never leave it. */
const columns: Partial<Record<StorageTable, string[]>> = {
  support_threads: ["requester_email", "requester_name", "subject", "mail_subject"],
  support_messages: ["sender", "recipient", "body_text"],
  support_drafts: ["body_text"],
  support_attachments: ["original_filename"],
  reports: ["detail", "snapshot_text", "resolution_note"],
  report_events: ["note", "actor_id"],
  report_attachments: ["original_filename"],
  tickets: ["subject", "summary", "requester_email", "next_action", "priority_override"],
  ticket_messages: ["sender", "recipient", "subject", "body"],
  ticket_events: ["metadata", "actor_id"],
  ticket_reports: ["detail"],
};
export async function migratePrivateStorage(
  env: AdminCoreEnv,
  slug: string,
): Promise<{ rows: number; files: number; done: boolean }> {
  const cipher = privateCipher(env);
  if (!cipher) throw new Error("PrivateKeyRequired");
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new Error("InvalidProject");
  const project = await env.DB.prepare(
    "SELECT a.id,p.table_prefix,p.state FROM apps a JOIN project_storage p ON p.project_id=a.id WHERE a.slug=?",
  )
    .bind(slug)
    .first<{ id: string; table_prefix: string; state: string }>();
  if (!project || project.state !== "active") throw new Error("ProjectStorageNotActive");
  // Shared operator destinations are private even though delivery settings are global.
  const settings = (
    await env.DB.prepare(
      "SELECT rowid,notification_email FROM app_mail_settings WHERE notification_email IS NOT NULL AND notification_email<>'' AND notification_email NOT LIKE 'private:v1:%' LIMIT 20",
    ).all<{ rowid: number; notification_email: string }>()
  ).results;
  for (const row of settings)
    await env.DB.prepare(
      "UPDATE app_mail_settings SET notification_email=? WHERE rowid=? AND notification_email=?",
    )
      .bind(
        await cipher.seal(row.notification_email, "platform"),
        row.rowid,
        row.notification_email,
      )
      .run();
  if (settings.length) return { rows: settings.length, files: 0, done: false };
  const pushes = (
    await env.DB.prepare(
      "SELECT * FROM push_subscriptions WHERE endpoint_hash IS NULL OR endpoint NOT LIKE 'private:v1:%' OR p256dh NOT LIKE 'private:v1:%' OR auth NOT LIKE 'private:v1:%' OR (device_name IS NOT NULL AND device_name<>'' AND device_name NOT LIKE 'private:v1:%') OR (user_agent IS NOT NULL AND user_agent<>'' AND user_agent NOT LIKE 'private:v1:%') LIMIT 20",
    ).all<Record<string, string | null>>()
  ).results;
  for (const row of pushes) {
    const fields = ["endpoint", "p256dh", "auth", "device_name", "user_agent"];
    const values = await Promise.all(
      fields.map(async (col) =>
        row[col]
          ? row[col]!.startsWith("private:v1:")
            ? row[col]
            : cipher.seal(row[col]!, "platform")
          : row[col],
      ),
    );
    await env.DB.prepare(
      "UPDATE push_subscriptions SET endpoint=?,p256dh=?,auth=?,device_name=?,user_agent=?,endpoint_hash=? WHERE id=? AND endpoint IS ?",
    )
      .bind(...values, await cipher.index(await cipher.open(row.endpoint!)), row.id, row.endpoint)
      .run();
  }
  if (pushes.length) return { rows: pushes.length, files: 0, done: false };
  const names = tableNames(project.table_prefix);
  for (const legacy of [false, true])
    for (const [logical, fields] of Object.entries(columns) as [StorageTable, string[]][]) {
      const table = legacy ? logical : names[logical];
      const key = logical === "support_drafts" ? "thread_id" : "id";
      const where = fields
        .map((c) => `(${c} IS NOT NULL AND ${c}<>'' AND ${c} NOT LIKE 'private:v1:%')`)
        .join(" OR ");
      const rows = (
        await env.DB.prepare(
          `SELECT r.* FROM ${table} r WHERE (${where}) ${legacy ? "AND " + ownerExpression(logical) + "=?" : ""} LIMIT 20`,
        )
          .bind(...(legacy ? [project.id] : []))
          .all<Record<string, unknown>>()
      ).results;
      if (!rows.length) continue;
      const statements: D1PreparedStatement[] = [];
      // Suspend this legacy table's triggers in one atomic batch: business
      // triggers must not generate writes into other sealed legacy tables.
      // Every original trigger, including the write fence, is restored before commit.
      const fences = legacy
        ? (
            await env.DB.prepare(
              "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
            )
              .bind(table)
              .all<{ name: string; sql: string }>()
          ).results
        : [];
      for (const fence of fences) {
        if (!/^[A-Za-z0-9_]+$/.test(fence.name)) throw new Error("InvalidFence");
        statements.push(env.DB.prepare(`DROP TRIGGER ${fence.name}`));
      }
      for (const row of rows) {
        const pending = fields.filter(
          (c) =>
            typeof row[c] === "string" &&
            row[c] !== "" &&
            !(row[c] as string).startsWith("private:v1:"),
        );
        const sealed = await Promise.all(
          pending.map((c) => cipher.seal(row[c] as string, project.id)),
        );
        statements.push(
          env.DB.prepare(
            `UPDATE ${table} SET ${pending.map((c) => `${c}=?`).join(",")} WHERE ${key}=? AND ${pending.map((c) => `${c} IS ?`).join(" AND ")}`,
          ).bind(...sealed, row[key], ...pending.map((c) => row[c])),
        );
      }
      for (const fence of fences) statements.push(env.DB.prepare(fence.sql));
      await env.DB.batch(statements);
      return { rows: rows.length, files: 0, done: false };
    }
  const files = privateBucket(env.PRIVATE_FILES, cipher);
  for (const logical of ["support_attachments", "report_attachments"] as const) {
    const objects = (
      await env.DB.prepare(`SELECT r2_key FROM ${names[logical]}`).all<{ r2_key: string }>()
    ).results;
    for (const row of objects) {
      const object = await env.PRIVATE_FILES.get(row.r2_key);
      if (!object || object.customMetadata?.privateStorage === "v1") continue;
      await files.put(row.r2_key, await object.arrayBuffer(), {
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
        onlyIf: { etagMatches: object.etag },
      });
      return { rows: 0, files: 1, done: false };
    }
  }
  const journal = await env.PRIVATE_FILES.list({
    prefix: "inbound-jobs/",
    include: ["customMetadata"],
    limit: 1000,
  });
  if (journal.truncated) throw new Error("PrivateJournalPaginationRequired");
  for (const row of journal.objects) {
    if (row.customMetadata?.projectSlug !== slug || row.customMetadata.privateStorage === "v1")
      continue;
    const object = await env.PRIVATE_FILES.get(row.key);
    if (!object) continue;
    await files.put(row.key, await object.arrayBuffer(), {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      onlyIf: { etagMatches: object.etag },
    });
    return { rows: 0, files: 1, done: false };
  }
  // Seal future writes only after the dual-read backfill has completed.
  // Trigger-generated event metadata contains IDs/codes, so it is excluded.
  for (const [logical, fields] of Object.entries(columns) as [StorageTable, string[]][]) {
    const table = names[logical];
    const checks = fields
      .filter((c) => c !== "metadata" && c !== "actor_id")
      .map(
        (c) =>
          `(NEW.${c} IS NOT NULL AND NEW.${c}<>'' AND NEW.${c} NOT LIKE 'private:v1:%'${logical === "tickets" && c === "subject" ? " AND NOT (NEW.type='REPORT' AND NEW.subject GLOB '通報: *')" : ""})`,
      );
    if (!checks.length) continue;
    await env.DB.batch(
      ["INSERT", "UPDATE"].map((action) =>
        env.DB.prepare(
          `CREATE TRIGGER IF NOT EXISTS ${table}_privacy_${action.toLowerCase()} BEFORE ${action} ON ${table} WHEN ${checks.join(" OR ")} BEGIN SELECT RAISE(ABORT,'PrivateCiphertextRequired'); END`,
        ),
      ),
    );
  }
  for (const action of ["INSERT", "UPDATE"])
    await env.DB.batch([
      env.DB.prepare(
        `CREATE TRIGGER IF NOT EXISTS push_private_${action.toLowerCase()} BEFORE ${action} ON push_subscriptions WHEN NEW.endpoint_hash IS NULL OR NEW.endpoint_hash NOT LIKE 'h1:%' OR NEW.endpoint NOT LIKE 'private:v1:%' OR NEW.p256dh NOT LIKE 'private:v1:%' OR NEW.auth NOT LIKE 'private:v1:%' OR (NEW.device_name IS NOT NULL AND NEW.device_name<>'' AND NEW.device_name NOT LIKE 'private:v1:%') OR (NEW.user_agent IS NOT NULL AND NEW.user_agent<>'' AND NEW.user_agent NOT LIKE 'private:v1:%') BEGIN SELECT RAISE(ABORT,'PrivateCiphertextRequired'); END`,
      ),
      env.DB.prepare(
        `CREATE TRIGGER IF NOT EXISTS notification_private_${action.toLowerCase()} BEFORE ${action} ON app_mail_settings WHEN NEW.notification_email IS NOT NULL AND NEW.notification_email<>'' AND NEW.notification_email NOT LIKE 'private:v1:%' BEGIN SELECT RAISE(ABORT,'PrivateCiphertextRequired'); END`,
      ),
    ]);
  return { rows: 0, files: 0, done: true };
}
