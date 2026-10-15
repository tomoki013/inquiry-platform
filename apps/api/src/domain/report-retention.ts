import type { AdminCoreEnv } from "../env";
import { aggregateDatabase, ProjectRegistry } from "../storage/database";

/** The original receipt date survives retries; support attachments are not affected. */
export async function expireReportEvidence(env: AdminCoreEnv, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const registry = new ProjectRegistry(env.DB);
  const rows = await aggregateDatabase(registry)
    .prepare(
      "SELECT id, report_id, r2_key FROM report_attachments WHERE expired_at IS NULL AND created_at <= ? LIMIT 500",
    )
    .bind(cutoff)
    .all<{ id: string; report_id: string; r2_key: string }>();
  if (!rows.results.length) return;
  await env.PRIVATE_FILES.delete(rows.results.map((row) => row.r2_key));
  for (const row of rows.results) {
    const db = await registry.forRecord("report", row.report_id);
    if (!db) continue;
    await db
      .prepare("UPDATE report_attachments SET expired_at=? WHERE id=?")
      .bind(now.toISOString(), row.id)
      .run();
  }
}
