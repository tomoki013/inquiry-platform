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
    .prepare(`SELECT th.id, th.app_id FROM tickets t
    JOIN ticket_sources s ON s.ticket_id = t.id AND s.source_type = 'support'
    JOIN support_threads th ON th.id = s.source_id
    WHERE t.ticket_number = ? AND t.merged_into IS NULL AND lower(th.requester_email) = ? LIMIT 2`)
    .bind(numbers[0], input.from.trim().toLowerCase())
    .all<{ id: string; app_id: string | null }>();
  if (rows.results.length !== 1) return null;
  const row = rows.results[0];
  // Mail to one project's address never lands in another project's ticket.
  if (!row || (input.appId && row.app_id !== input.appId)) return null;
  return row.id;
}
