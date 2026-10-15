import { aggregateDatabase, type ProjectRegistry } from "./database";

export async function namespacedSupportKey(
  registry: ProjectRegistry,
  messageId: string,
  threadId: string,
  attachmentId: string,
): Promise<string> {
  const rows = await aggregateDatabase(registry)
    .prepare(`SELECT m.__project_id AS project_id,
    EXISTS(SELECT 1 FROM reports r WHERE r.support_thread_id=m.thread_id AND r.__project_id=m.__project_id) AS moderation
    FROM support_messages m WHERE m.id=? LIMIT 2`)
    .bind(messageId)
    .all<{ project_id: string; moderation: number }>();
  const row = rows.results[0];
  if (rows.results.length !== 1 || !row) throw new Error("AttachmentOwnerUnavailable");
  return `projects/${encodeURIComponent(row.project_id)}/${row.moderation ? "moderation" : "support"}/${encodeURIComponent(threadId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`;
}
