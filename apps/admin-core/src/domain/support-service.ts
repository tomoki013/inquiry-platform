import type {
  ActorRef,
  IngestInboundEmailResult,
  Result,
  SupportThreadDetail,
  SupportThreadListPage,
} from "@tomokichi/admin-contracts";
import {
  assignSupportAppInputSchema,
  createSupportMessageInputSchema,
  createSupportThreadInputSchema,
  ingestInboundEmailInputSchema,
  listSupportThreadsInputSchema,
  newId,
  nowIso,
  ok,
  replySupportInputSchema,
  setSupportStatusInputSchema,
} from "@tomokichi/admin-contracts";
import type { AppRepository } from "../db/apps";
import type { AuditRepository } from "../db/audit";
import type { SupportRepository } from "../db/support";
import { internalFailure, notFound, validationFailure } from "./failures";

/**
 * Support threads, messages and internal notes.
 *
 * This class **has no mail provider**. That is the point: an internal note is
 * written by `addInternalNote` here, and there is no code path from this file
 * to anything that sends. Replying lives in `ReplyService`, which is the only
 * thing holding a `MailProvider`. A boolean deciding whether a private note
 * gets emailed to a customer would be the worst bug this system could have, so
 * the two capabilities are not in the same object.
 */
export class SupportService {
  constructor(
    private readonly db: D1Database,
    private readonly support: SupportRepository,
    private readonly apps: AppRepository,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * One inbound email, already parsed and flattened to text by the mail Worker.
   *
   * Threading is by `Message-ID` only — see `findThreadByHeaders`. Re-delivery
   * of the same message is recognised and answered with the existing ids rather
   * than appending the message twice, because Cloudflare may retry an email
   * Worker and the customer wrote once.
   */
  async ingestInboundEmail(
    raw: unknown,
    actor: ActorRef,
  ): Promise<Result<IngestInboundEmailResult>> {
    const parsed = ingestInboundEmailInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      if (input.messageId) {
        const seen = await this.support.messageExists(input.messageId);
        if (seen) {
          return ok({
            threadId: seen.thread_id,
            messageId: seen.id,
            duplicate: true,
            newThread: false,
          });
        }
      }

      const at = input.receivedAt ?? nowIso();
      const appId = input.appSlug ? (await this.apps.findBySlug(input.appSlug))?.id : undefined;
      const existingThreadId = await this.support.findThreadByHeaders(
        input.inReplyTo,
        input.references,
      );

      const threadId = existingThreadId ?? newId();
      const messageId = newId();
      const statements: D1PreparedStatement[] = [];

      if (!existingThreadId) {
        statements.push(
          this.support.insertThreadStatement({
            id: threadId,
            appId,
            source: "email",
            requesterEmail: input.from,
            requesterName: input.requesterName,
            subject: input.subject.trim().length > 0 ? input.subject.trim() : "(件名なし)",
            at,
          }),
        );
      }

      statements.push(
        this.support.insertMessageStatement({
          id: messageId,
          threadId,
          direction: "inbound",
          providerMessageId: input.messageId,
          inReplyTo: input.inReplyTo,
          sender: input.from,
          recipient: input.to,
          bodyText: input.bodyText,
          at,
        }),
        this.support.touchThreadStatement(threadId, "inbound", at),
        this.audit.statement({
          actor,
          action: "support.received",
          targetType: "support_thread",
          targetId: threadId,
          // Never the address or the body. Whether it opened a thread, and how
          // long the message was, is all an audit trail needs.
          metadata: {
            newThread: !existingThreadId,
            source: "email",
            length: input.bodyText.length,
          },
        }),
      );

      await this.db.batch(statements);
      return ok({ threadId, messageId, duplicate: false, newThread: !existingThreadId });
    } catch (error) {
      return internalFailure("support.ingestInboundEmail", error);
    }
  }

  /** The `tmkch.io/support` form, and anything else that starts a conversation
   * without an email round trip. */
  async createThread(raw: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    const parsed = createSupportThreadInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      const appId = input.appSlug ? (await this.apps.findBySlug(input.appSlug))?.id : undefined;
      const at = input.createdAt ?? nowIso();
      const threadId = newId();
      const messageId = newId();

      await this.db.batch([
        this.support.insertThreadStatement({
          id: threadId,
          appId,
          source: input.source,
          requesterEmail: input.requesterEmail,
          requesterName: input.requesterName,
          subject: input.subject.trim().length > 0 ? input.subject.trim() : "(件名なし)",
          at,
        }),
        this.support.insertMessageStatement({
          id: messageId,
          threadId,
          direction: "inbound",
          providerMessageId: input.providerMessageId,
          inReplyTo: input.inReplyTo,
          sender: input.sender ?? input.requesterEmail,
          recipient: input.recipient,
          bodyText: input.bodyText,
          at,
        }),
        this.support.touchThreadStatement(threadId, "inbound", at),
        this.audit.statement({
          actor,
          action: "support.received",
          targetType: "support_thread",
          targetId: threadId,
          metadata: { newThread: true, source: input.source, length: input.bodyText.length },
        }),
      ]);

      return await this.detail(threadId);
    } catch (error) {
      return internalFailure("support.createThread", error);
    }
  }

  /** A message on an existing thread from a caller that is not the mail path —
   * used by the support form when a person writes again with the same
   * reference. Never sends anything. */
  async addMessage(raw: unknown, _actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    const parsed = createSupportMessageInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      if (!(await this.support.findThread(input.threadId))) return notFound("問い合わせ");
      const at = input.createdAt ?? nowIso();
      await this.db.batch([
        this.support.insertMessageStatement({
          id: newId(),
          threadId: input.threadId,
          direction: input.direction,
          providerMessageId: input.providerMessageId,
          inReplyTo: input.inReplyTo,
          sender: input.sender,
          recipient: input.recipient,
          bodyText: input.bodyText,
          at,
        }),
        this.support.touchThreadStatement(input.threadId, input.direction, at),
      ]);
      return await this.detail(input.threadId);
    } catch (error) {
      return internalFailure("support.addMessage", error);
    }
  }

  /**
   * A note only the operator sees.
   *
   * Its own method, on the class that has no mail provider. Direction
   * `internal_note` keeps it in the same timeline as the conversation, and the
   * thread's `last_message_at` is deliberately not moved — writing a note to
   * yourself is not activity on the customer's side.
   */
  async addInternalNote(raw: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    const parsed = replySupportInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      if (!(await this.support.findThread(input.threadId))) return notFound("問い合わせ");
      const at = nowIso();
      await this.db.batch([
        this.support.insertMessageStatement({
          id: newId(),
          threadId: input.threadId,
          direction: "internal_note",
          sender: actor.id,
          bodyText: input.bodyText,
          at,
        }),
        this.support.touchThreadStatement(input.threadId, "internal_note", at),
        this.audit.statement({
          actor,
          action: "support.internal_note_added",
          targetType: "support_thread",
          targetId: input.threadId,
          metadata: { length: input.bodyText.length },
        }),
      ]);
      return await this.detail(input.threadId);
    } catch (error) {
      return internalFailure("support.addInternalNote", error);
    }
  }

  async list(raw: unknown): Promise<Result<SupportThreadListPage>> {
    const parsed = listSupportThreadsInputSchema.safeParse(raw ?? {});
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      return ok(await this.support.list(parsed.data));
    } catch (error) {
      return internalFailure("support.list", error);
    }
  }

  async detail(threadId: string): Promise<Result<SupportThreadDetail>> {
    try {
      const found = await this.support.detail(threadId);
      return found ? ok(found) : notFound("問い合わせ");
    } catch (error) {
      return internalFailure("support.detail", error);
    }
  }

  async setStatus(raw: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    const parsed = setSupportStatusInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      const thread = await this.support.findThread(input.threadId);
      if (!thread) return notFound("問い合わせ");
      if (thread.status === input.status) return await this.detail(input.threadId);

      await this.db.batch([
        this.support.statusStatement(input.threadId, input.status),
        this.audit.statement({
          actor,
          action: "support.status_changed",
          targetType: "support_thread",
          targetId: input.threadId,
          metadata: { from: thread.status, to: input.status },
        }),
      ]);
      return await this.detail(input.threadId);
    } catch (error) {
      return internalFailure("support.setStatus", error);
    }
  }

  async assignApp(raw: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
    const parsed = assignSupportAppInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      const thread = await this.support.findThread(input.threadId);
      if (!thread) return notFound("問い合わせ");
      if (input.appId && !(await this.apps.findById(input.appId))) return notFound("アプリ");

      await this.db.batch([
        this.support.assignAppStatement(input.threadId, input.appId),
        this.audit.statement({
          actor,
          action: "support.app_assigned",
          targetType: "support_thread",
          targetId: input.threadId,
          metadata: { appId: input.appId ?? "none" },
        }),
      ]);
      return await this.detail(input.threadId);
    } catch (error) {
      return internalFailure("support.assignApp", error);
    }
  }

  /** Used by the reply path to refuse a send into a thread that should not get
   * one. Exported here so `ReplyService` does not need the repository. */
  async threadForReply(threadId: string) {
    return await this.support.findThread(threadId);
  }

  async countOpen(): Promise<number> {
    return await this.support.countOpen();
  }

  async hasAnyThread(): Promise<boolean> {
    return (await this.support.countAll()) > 0;
  }
}
