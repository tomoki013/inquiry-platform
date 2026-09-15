import type { AdminCoreEnv } from "../env";

/** The original receipt date survives retries; support attachments are not affected. */
export async function expireReportEvidence(env: AdminCoreEnv, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id, r2_key FROM report_attachments WHERE expired_at IS NULL AND created_at <= ? LIMIT 500",
  )
    .bind(cutoff)
    .all<{ id: string; r2_key: string }>();
  if (!rows.results.length) return;
  await env.PRIVATE_FILES.delete(rows.results.map((row) => row.r2_key));
  await env.DB.batch(
    rows.results.map((row) =>
      env.DB.prepare("UPDATE report_attachments SET expired_at = ? WHERE id = ?").bind(
        now.toISOString(),
        row.id,
      ),
    ),
  );
}
