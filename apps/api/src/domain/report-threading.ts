/** A stable correlation marker, independent of the mail provider's Message-ID. */
export function reportMailSubject(appName: string, reportId: string): string {
  return `[${appName}] 通報の受付・対応について [通報ID:${reportId}]`;
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function reportIdsFromReply(
  subject: string,
  body: string,
): { ids: string[]; legacy: boolean } {
  const tagged = [...subject.matchAll(new RegExp(`\\[通報ID:(${uuid})\\]`, "gi"))];
  if (tagged.length)
    return { ids: [...new Set(tagged.map((m) => m[1]!.toLowerCase()))], legacy: false };
  // Earlier receipts had the ID only in the body. Accept an exact receipt line,
  // including normal mail-client quote prefixes, never arbitrary UUIDs in prose.
  const quoted = [
    ...body.matchAll(new RegExp(`(?:^|\\n)[ \\t>]*受付ID:[ \\t]*(${uuid})[ \\t]*(?=\\r?$)`, "gim")),
  ];
  return { ids: [...new Set(quoted.map((m) => m[1]!.toLowerCase()))], legacy: true };
}

export function unprefixedSubject(subject: string): string {
  return subject.replace(/^(?:\s*(?:re|fw|fwd):\s*)+/i, "").trim();
}

export async function findReportReplyThread(
  db: D1Database,
  input: { from: string; subject: string; bodyText: string },
): Promise<string | null> {
  const match = reportIdsFromReply(input.subject, input.bodyText);
  if (match.ids.length !== 1) return null;
  const rows = await db
    .prepare(`SELECT t.id, t.subject FROM reports r
    JOIN support_threads t ON t.id = r.support_thread_id
    WHERE lower(r.external_report_id) = ? AND lower(t.requester_email) = ? LIMIT 2`)
    .bind(match.ids[0]!, input.from.trim().toLowerCase())
    .all<{ id: string; subject: string }>();
  if (rows.results.length !== 1) return null;
  const row = rows.results[0]!;
  if (match.legacy && unprefixedSubject(input.subject) !== unprefixedSubject(row.subject))
    return null;
  return row.id;
}
