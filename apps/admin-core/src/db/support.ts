import type {
  ListSupportThreadsInput,
  SupportAttachmentMeta,
  SupportDirection,
  SupportDraft,
  SupportMessage,
  SupportSource,
  SupportStatus,
  SupportThreadDetail,
  SupportThreadListPage,
  SupportThreadSummary,
} from "@tomokichi/admin-contracts";
import { newId, nowIso } from "@tomokichi/admin-contracts";

interface ThreadRow {
  id: string;
  app_id: string | null;
  source: string;
  /**
   * Empty when the sender did not ask for a reply, which is what the app forms
   * default to for everything that is not a question.
   *
   * The column stays `NOT NULL`: making it nullable means rebuilding the table,
   * and SQLite cannot drop a parent table that `support_messages` still points
   * at without foreign keys off — not something to do to the live database for
   * a spelling. The empty string is the same absence the apps put on the wire
   * (`email: ""`, never a missing key), and `reply-service` already refuses to
   * send to it. Everything above this layer sees `undefined`.
   */
  requester_email: string;
  requester_name: string | null;
  subject: string;
  status: string;
  unread_count: number;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  resolved_at: string | null;
  app_slug: string | null;
  app_name: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  direction: string;
  provider_message_id: string | null;
  in_reply_to: string | null;
  sender: string | null;
  recipient: string | null;
  body_text: string;
  created_at: string;
}

interface SupportAttachmentRow {
  id: string;
  message_id: string;
  r2_key: string;
  original_filename: string | null;
  content_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
}

const SELECT_THREAD = `
  SELECT t.*, a.slug AS app_slug, a.name AS app_name
    FROM support_threads t LEFT JOIN apps a ON a.id = t.app_id`;

function toSummary(row: ThreadRow): SupportThreadSummary {
  return {
    id: row.id,
    appId: row.app_id ?? undefined,
    appSlug: row.app_slug ?? undefined,
    appName: row.app_name ?? undefined,
    source: row.source as SupportSource,
    requesterEmail: row.requester_email.length > 0 ? row.requester_email : undefined,
    requesterName: row.requester_name ?? undefined,
    subject: row.subject,
    status: row.status as SupportStatus,
    unreadCount: row.unread_count,
    lastMessageAt: row.last_message_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export class SupportRepository {
  constructor(private readonly db: D1Database) {}

  async findThread(id: string): Promise<ThreadRow | null> {
    return await this.db.prepare(`${SELECT_THREAD} WHERE t.id = ?`).bind(id).first<ThreadRow>();
  }

  /**
   * Finds the thread an inbound mail belongs to.
   *
   * `In-Reply-To` first, then each `References` entry newest-last, matched
   * against the `Message-ID`s already stored — inbound ones we received and
   * outbound ones we sent. Subject is **not** consulted: two unrelated people
   * writing "アプリについて" is not one conversation, and merging them would show
   * one customer another customer's message.
   */
  async findThreadByHeaders(
    inReplyTo: string | undefined,
    references: readonly string[],
  ): Promise<string | null> {
    const candidates = [inReplyTo, ...[...references].reverse()].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    for (const candidate of candidates) {
      const row = await this.db
        .prepare("SELECT thread_id FROM support_messages WHERE provider_message_id = ? LIMIT 1")
        .bind(candidate)
        .first<{ thread_id: string }>();
      if (row) return row.thread_id;
    }
    return null;
  }

  async messageExists(
    providerMessageId: string,
  ): Promise<{ id: string; thread_id: string } | null> {
    return await this.db
      .prepare("SELECT id, thread_id FROM support_messages WHERE provider_message_id = ? LIMIT 1")
      .bind(providerMessageId)
      .first<{ id: string; thread_id: string }>();
  }

  insertThreadStatement(values: {
    id: string;
    appId?: string;
    source: SupportSource;
    requesterEmail?: string;
    requesterName?: string;
    subject: string;
    at: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO support_threads
           (id, app_id, source, requester_email, requester_name, subject, status,
            unread_count, created_at, updated_at, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.appId ?? null,
        values.source,
        values.requesterEmail ?? "",
        values.requesterName ?? null,
        values.subject,
        values.at,
        values.at,
        values.at,
      );
  }

  insertMessageStatement(values: {
    id: string;
    threadId: string;
    direction: SupportDirection;
    providerMessageId?: string;
    inReplyTo?: string;
    sender?: string;
    recipient?: string;
    bodyText: string;
    at: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO support_messages
           (id, thread_id, direction, provider_message_id, in_reply_to,
            sender, recipient, body_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.threadId,
        values.direction,
        values.providerMessageId ?? null,
        values.inReplyTo ?? null,
        values.sender ?? null,
        values.recipient ?? null,
        values.bodyText,
        values.at,
      );
  }

  /**
   * Moves the thread's clock forward after a message lands.
   *
   * Only an inbound message raises `unread_count` — our own reply and an
   * internal note must not make a thread look like it is waiting on us. A reply
   * clears it, because writing back is what "I have read this" means here.
   */
  touchThreadStatement(
    threadId: string,
    direction: SupportDirection,
    at: string,
  ): D1PreparedStatement {
    if (direction === "inbound") {
      return this.db
        .prepare(
          `UPDATE support_threads
              SET last_message_at = ?, updated_at = ?, unread_count = unread_count + 1
            WHERE id = ?`,
        )
        .bind(at, at, threadId);
    }
    if (direction === "outbound") {
      return this.db
        .prepare(
          `UPDATE support_threads
              SET last_message_at = ?, updated_at = ?, unread_count = 0
            WHERE id = ?`,
        )
        .bind(at, at, threadId);
    }
    return this.db
      .prepare("UPDATE support_threads SET updated_at = ? WHERE id = ?")
      .bind(at, threadId);
  }

  statusStatement(threadId: string, status: SupportStatus): D1PreparedStatement {
    const at = nowIso();
    return this.db
      .prepare(
        `UPDATE support_threads
            SET status = ?, updated_at = ?, resolved_at = ?,
                unread_count = CASE WHEN ? IN ('resolved','spam') THEN 0 ELSE unread_count END
          WHERE id = ?`,
      )
      .bind(status, at, status === "resolved" ? at : null, status, threadId);
  }

  assignAppStatement(threadId: string, appId: string | null): D1PreparedStatement {
    return this.db
      .prepare("UPDATE support_threads SET app_id = ?, updated_at = ? WHERE id = ?")
      .bind(appId, nowIso(), threadId);
  }

  async list(input: ListSupportThreadsInput): Promise<SupportThreadListPage> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (input.appId) {
      where.push("t.app_id = ?");
      values.push(input.appId);
    }
    if (input.status) {
      where.push("t.status = ?");
      values.push(input.status);
    }
    if (input.query) {
      // Exact address, or the thread id — not a substring scan over subjects.
      where.push("(t.requester_email = ? OR t.id = ?)");
      values.push(input.query, input.query);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const batched = await this.db.batch<ThreadRow | { total: number }>([
      this.db
        .prepare(`${SELECT_THREAD} ${clause} ORDER BY t.last_message_at DESC LIMIT ? OFFSET ?`)
        .bind(...values, input.limit, input.offset),
      this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM support_threads t
             LEFT JOIN apps a ON a.id = t.app_id ${clause}`,
        )
        .bind(...values),
    ]);

    return {
      items: ((batched[0]?.results ?? []) as ThreadRow[]).map(toSummary),
      total: ((batched[1]?.results ?? []) as { total: number }[])[0]?.total ?? 0,
    };
  }

  async detail(threadId: string): Promise<SupportThreadDetail | null> {
    const row = await this.findThread(threadId);
    if (!row) return null;

    const { results: messages } = await this.db
      .prepare("SELECT * FROM support_messages WHERE thread_id = ? ORDER BY created_at, id")
      .bind(threadId)
      .all<MessageRow>();

    const { results: attachments } = await this.db
      .prepare(
        `SELECT * FROM support_attachments
          WHERE message_id IN (SELECT id FROM support_messages WHERE thread_id = ?)
          ORDER BY created_at`,
      )
      .bind(threadId)
      .all<SupportAttachmentRow>();

    const byMessage = new Map<string, SupportAttachmentMeta[]>();
    for (const attachment of attachments) {
      const list = byMessage.get(attachment.message_id) ?? [];
      list.push({
        id: attachment.id,
        messageId: attachment.message_id,
        originalFilename: attachment.original_filename ?? undefined,
        contentType: attachment.content_type,
        byteSize: attachment.byte_size,
        sha256: attachment.sha256,
        createdAt: attachment.created_at,
      });
      byMessage.set(attachment.message_id, list);
    }

    return {
      ...toSummary(row),
      resolvedAt: row.resolved_at ?? undefined,
      messages: messages.map(
        (message): SupportMessage => ({
          id: message.id,
          threadId: message.thread_id,
          direction: message.direction as SupportDirection,
          sender: message.sender ?? undefined,
          recipient: message.recipient ?? undefined,
          bodyText: message.body_text,
          createdAt: message.created_at,
          attachments: byMessage.get(message.id) ?? [],
        }),
      ),
    };
  }

  /** The `Message-ID`s a reply should thread onto: what the customer sent, and
   * what we have already sent them, oldest first. */
  async threadReferences(threadId: string): Promise<{ references: string[]; inReplyTo?: string }> {
    const { results } = await this.db
      .prepare(
        `SELECT provider_message_id, direction FROM support_messages
          WHERE thread_id = ? AND provider_message_id IS NOT NULL
            AND direction IN ('inbound','outbound')
          ORDER BY created_at, id`,
      )
      .bind(threadId)
      .all<{ provider_message_id: string; direction: string }>();

    const references = results.map((row) => row.provider_message_id);
    const lastInbound = [...results].reverse().find((row) => row.direction === "inbound");
    return {
      references,
      inReplyTo: lastInbound?.provider_message_id ?? references[references.length - 1],
    };
  }

  async countOpen(): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS total FROM support_threads WHERE status IN ('open','pending_user')",
      )
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  async countAll(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS total FROM support_threads")
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  // ---- attachments -------------------------------------------------------

  attachmentStatement(values: {
    id: string;
    messageId: string;
    r2Key: string;
    contentType: string;
    originalFilename?: string;
    byteSize: number;
    sha256: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO support_attachments
           (id, message_id, r2_key, original_filename, content_type, byte_size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.messageId,
        values.r2Key,
        values.originalFilename ?? null,
        values.contentType,
        values.byteSize,
        values.sha256,
        nowIso(),
      );
  }

  async findAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<SupportAttachmentRow | null> {
    return await this.db
      .prepare("SELECT * FROM support_attachments WHERE id = ? AND message_id = ?")
      .bind(attachmentId, messageId)
      .first<SupportAttachmentRow>();
  }

  async messageThreadId(messageId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT thread_id FROM support_messages WHERE id = ?")
      .bind(messageId)
      .first<{ thread_id: string }>();
    return row?.thread_id ?? null;
  }

  // ---- drafts ------------------------------------------------------------

  async draft(threadId: string): Promise<SupportDraft | null> {
    const row = await this.db
      .prepare("SELECT thread_id, body_text, updated_at FROM support_drafts WHERE thread_id = ?")
      .bind(threadId)
      .first<{ thread_id: string; body_text: string; updated_at: string }>();
    return row
      ? { threadId: row.thread_id, bodyText: row.body_text, updatedAt: row.updated_at }
      : null;
  }

  /** One row per thread — the primary key is `thread_id`, so an upsert is the
   * only shape this can take and a second draft cannot appear. */
  async saveDraft(threadId: string, bodyText: string): Promise<SupportDraft> {
    const at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO support_drafts (thread_id, body_text, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET body_text = excluded.body_text,
                                              updated_at = excluded.updated_at`,
      )
      .bind(threadId, bodyText, at, at)
      .run();
    return { threadId, bodyText, updatedAt: at };
  }

  deleteDraftStatement(threadId: string): D1PreparedStatement {
    return this.db.prepare("DELETE FROM support_drafts WHERE thread_id = ?").bind(threadId);
  }

  // ---- send idempotency --------------------------------------------------

  async findSend(
    idempotencyKey: string,
  ): Promise<{ thread_id: string; message_id: string } | null> {
    return await this.db
      .prepare("SELECT thread_id, message_id FROM support_reply_sends WHERE idempotency_key = ?")
      .bind(idempotencyKey)
      .first<{ thread_id: string; message_id: string }>();
  }

  recordSendStatement(
    idempotencyKey: string,
    threadId: string,
    messageId: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO support_reply_sends (idempotency_key, thread_id, message_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(idempotencyKey, threadId, messageId, nowIso());
  }

  newId(): string {
    return newId();
  }
}
