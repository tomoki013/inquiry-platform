/**
 * The operator's copy of our own reply, coming back.
 *
 * `ccSelf` copies a reply to the project's support address — the address the
 * person already sees — instead of exposing the operator's private one. That
 * copy arrives through Email Routing and mail-ingress like any other mail, and
 * must become neither a ticket nor a message: mail-ingress forwards it to the
 * operator instead (`/internal/mail-ingress/self-copy`), and ingestion drops it
 * if it gets that far.
 *
 * Recognised only when **both** hold:
 *
 * - it names one of our outgoing messages: the `X-Inquiry-Copy` header we wrote
 *   (the message's id), the `Message-ID` we sent under (`<id@domain>`), or the
 *   `Message-ID` the provider reported for it. Any of the three, because a
 *   provider may replace a `Message-ID` it was given;
 * - it is from the address that message was sent from.
 *
 * The id is a random UUID the person never sees, so a stranger cannot make
 * their mail disappear by claiming to be a copy.
 */
const OWN_MESSAGE_ID =
  /^<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@[^<>\s]+>$/i;

export interface SelfCopy {
  /** The outgoing message it is a copy of. */
  messageId: string;
  threadId: string;
  appId: string | null;
}

export async function findSelfCopy(
  db: D1Database,
  input: { from: string; messageId?: string; copyId?: string },
): Promise<SelfCopy | null> {
  const from = input.from.trim().toLowerCase();
  if (!from) return null;
  const ids = [
    input.copyId,
    input.messageId ? OWN_MESSAGE_ID.exec(input.messageId)?.[1] : undefined,
  ]
    .filter((id): id is string => Boolean(id))
    .map((id) => id.toLowerCase());
  if (!ids.length && !input.messageId) return null;
  const { results } = await db
    .prepare(
      `SELECT m.id, m.thread_id, m.sender, t.app_id FROM support_messages m
        JOIN support_threads t ON t.id = m.thread_id
       WHERE m.direction = 'outbound'
         AND (lower(m.id) IN (SELECT value FROM json_each(?)) OR m.provider_message_id = ?)
       LIMIT 4`,
    )
    .bind(JSON.stringify(ids), input.messageId ?? null)
    .all<{ id: string; thread_id: string; sender: string | null; app_id: string | null }>();
  const row = results.find((candidate) => candidate.sender?.trim().toLowerCase() === from);
  return row ? { messageId: row.id, threadId: row.thread_id, appId: row.app_id } : null;
}
