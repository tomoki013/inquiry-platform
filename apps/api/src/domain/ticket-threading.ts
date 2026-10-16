/**
 * A reply that lost its threading headers still belongs to its ticket when it
 * names the ticket number and comes from the address that opened it.
 *
 * Accepted: a number in the subject (`[TK-000123]`, `TK-000123`), or an exact
 * `受付番号: TK-000123` line in the body — which is how a quoted receipt mail
 * carries it. Never a number found anywhere else in prose, and never a ticket
 * whose requester is somebody else: naming a number does not let a stranger
 * write into another person's conversation.
 */
const NUMBER = "TK-\\d{1,12}";

export function ticketNumbersFromReply(subject: string, body: string): string[] {
  const inSubject = [
    ...subject.matchAll(new RegExp(`(?:^|[^A-Za-z0-9-])(${NUMBER})(?![0-9])`, "gi")),
  ];
  const found = inSubject.length
    ? inSubject
    : [
        ...body.matchAll(
          new RegExp(
            `(?:^|\\n)[ \\t>]*受付番号[ \\t]*[:：][ \\t]*(${NUMBER})[ \\t]*(?=\\r?$)`,
            "gim",
          ),
        ),
      ];
  return [...new Set(found.map((m) => (m[1] ?? "").toUpperCase()).filter(Boolean))];
}

export async function findTicketReplyThread(
  db: D1Database,
  input: { from: string; subject: string; bodyText: string; appId?: string },
): Promise<string | null> {
  const numbers = ticketNumbersFromReply(input.subject, input.bodyText);
  if (numbers.length !== 1) return null;
  const rows = await db
    .prepare(`SELECT th.id, th.app_id, th.requester_email FROM tickets t
    JOIN ticket_sources s ON s.ticket_id = t.id AND s.source_type = 'support'
    JOIN support_threads th ON th.id = s.source_id
    WHERE t.ticket_number = ? AND t.merged_into IS NULL LIMIT 64`)
    .bind(numbers[0])
    .all<{ id: string; app_id: string | null; requester_email: string }>();
  const matches = rows.results.filter(
    (row) => row.requester_email.trim().toLowerCase() === input.from.trim().toLowerCase(),
  );
  if (rows.results.length === 64 || matches.length !== 1) return null;
  const row = matches[0];
  // Mail to one project's address never lands in another project's ticket.
  if (
    !row ||
    row.requester_email.trim().toLowerCase() !== input.from.trim().toLowerCase() ||
    (input.appId && row.app_id !== input.appId)
  )
    return null;
  return row.id;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** `[受付ID:…]` in the subject, or an exact `受付ID: …` line — a quoted receipt. */
export function receiptIdsFromReply(subject: string, body: string): string[] {
  const tagged = [...subject.matchAll(new RegExp(`\\[受付ID[:：]\\s*(${UUID})\\]`, "gi"))];
  const found = tagged.length
    ? tagged
    : [
        ...body.matchAll(
          new RegExp(`(?:^|\\n)[ \\t>]*受付ID[ \\t]*[:：][ \\t]*(${UUID})[ \\t]*(?=\\r?$)`, "gim"),
        ),
      ];
  return [...new Set(found.map((m) => (m[1] ?? "").toLowerCase()).filter(Boolean))];
}

/**
 * The conversation a receipt ID names, when the reply comes from the address
 * that opened it and was sent to the same project. Reports have their own
 * receipt IDs and are matched before this (`report-threading.ts`).
 */
export async function findReceiptReplyThread(
  db: D1Database,
  input: { from: string; subject: string; bodyText: string; appId?: string },
): Promise<string | null> {
  const ids = receiptIdsFromReply(input.subject, input.bodyText);
  if (ids.length !== 1) return null;
  const row = await db
    .prepare("SELECT id, app_id, requester_email FROM support_threads WHERE lower(id) = ? LIMIT 1")
    .bind(ids[0])
    .first<{ id: string; app_id: string | null; requester_email: string }>();
  if (
    !row ||
    row.requester_email.trim().toLowerCase() !== input.from.trim().toLowerCase() ||
    (input.appId && row.app_id !== input.appId)
  )
    return null;
  return row.id;
}
