import type {
  ActorRef,
  AppliedTemplate,
  AppMailSettings,
  ReplyTemplate,
  Result,
  SupportDraft,
  SupportThreadDetail,
} from "@tomokichi/admin-contracts";
import {
  applyTemplateInputSchema,
  createReplyTemplateInputSchema,
  DEFAULT_MAIL_SIGNATURE,
  fail,
  listReplyTemplatesInputSchema,
  newId,
  nowIso,
  ok,
  renderTemplate,
  replySubjectFor,
  saveSupportDraftInputSchema,
  sendSupportReplyInputSchema,
  setAppMailSettingsInputSchema,
  unresolvedVariables,
  updateReplyTemplateInputSchema,
} from "@tomokichi/admin-contracts";
import type { MailProvider } from "@tomokichi/admin-mail";
import type { AppRepository } from "../db/apps";
import type { AuditRepository } from "../db/audit";
import type { SupportRepository } from "../db/support";
import type { TemplateRepository } from "../db/templates";
import { internalFailure, notFound, validationFailure } from "./failures";
import type { SupportService } from "./support-service";
import { TicketService } from "./ticket-service";

export interface ReplyAddresses {
  supportEmail: string;
  fromName: string;
  defaultSupportUrl: string;
}

/**
 * Writing back to somebody who wrote in.
 *
 * The only class in Admin Core that holds a {@link MailProvider}. Everything
 * about *where* a reply goes is derived here from the thread — the browser
 * sends a thread id and a body and nothing else, so a tampered request cannot
 * redirect a reply to another address or forge a sender.
 *
 * The ordering in `send` is the whole safety story:
 *
 *   idempotency check → validate → **provider** → record + delete draft
 *
 * The draft is deleted last and only on success, so a provider that times out
 * leaves the operator's text exactly where they left it.
 */
export class ReplyService {
  constructor(
    private readonly db: D1Database,
    private readonly support: SupportRepository,
    private readonly supportService: SupportService,
    private readonly templates: TemplateRepository,
    private readonly apps: AppRepository,
    private readonly audit: AuditRepository,
    private readonly mail: MailProvider,
    private readonly addresses: ReplyAddresses,
  ) {}

  get mailConfigured(): boolean {
    return this.mail.configured;
  }

  // ---- drafts ------------------------------------------------------------

  async getDraft(threadId: string): Promise<Result<SupportDraft | null>> {
    try {
      if (!(await this.support.findThread(threadId))) return notFound("問い合わせ");
      const draft = await this.support.draft(threadId);
      return ok(
        draft
          ? { ...draft, bodyText: await this.withoutSignature(threadId, draft.bodyText) }
          : null,
      );
    } catch (error) {
      return internalFailure("reply.getDraft", error);
    }
  }

  /**
   * Autosaved from the composer.
   *
   * Deliberately **not** audited on every keystroke-debounced write: a log line
   * per few hundred milliseconds of typing would bury the entries that matter
   * and would be a running record of somebody composing. The send is audited;
   * the drafting is not.
   */
  async saveDraft(raw: unknown): Promise<Result<SupportDraft>> {
    const parsed = saveSupportDraftInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      if (!(await this.support.findThread(parsed.data.threadId))) return notFound("問い合わせ");
      return ok(
        await this.support.saveDraft(
          parsed.data.threadId,
          await this.withoutSignature(parsed.data.threadId, parsed.data.bodyText),
        ),
      );
    } catch (error) {
      return internalFailure("reply.saveDraft", error);
    }
  }

  async deleteDraft(threadId: string): Promise<Result<null>> {
    try {
      await this.db.batch([this.support.deleteDraftStatement(threadId)]);
      return ok(null);
    } catch (error) {
      return internalFailure("reply.deleteDraft", error);
    }
  }

  // ---- templates ---------------------------------------------------------

  async listTemplates(raw: unknown): Promise<Result<ReplyTemplate[]>> {
    const parsed = listReplyTemplatesInputSchema.safeParse(raw ?? {});
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      return ok(await this.templates.list(parsed.data));
    } catch (error) {
      return internalFailure("reply.listTemplates", error);
    }
  }

  async getTemplate(templateId: string): Promise<Result<ReplyTemplate>> {
    try {
      const found = await this.templates.find(templateId);
      return found ? ok(found) : notFound("定型文");
    } catch (error) {
      return internalFailure("reply.getTemplate", error);
    }
  }

  async createTemplate(raw: unknown, actor: ActorRef): Promise<Result<ReplyTemplate>> {
    const parsed = createReplyTemplateInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      if (await this.templates.findByKey(parsed.data.key)) {
        return fail("CONFLICT", `key "${parsed.data.key}" はすでに使われています。`);
      }
      const id = await this.templates.insert(parsed.data);
      await this.db.batch([
        this.audit.statement({
          actor,
          action: "reply_template.created",
          targetType: "system",
          targetId: id,
          metadata: { key: parsed.data.key, category: parsed.data.category },
        }),
      ]);
      return await this.getTemplate(id);
    } catch (error) {
      return internalFailure("reply.createTemplate", error);
    }
  }

  async updateTemplate(
    templateId: string,
    raw: unknown,
    actor: ActorRef,
  ): Promise<Result<ReplyTemplate>> {
    const parsed = updateReplyTemplateInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const existing = await this.templates.find(templateId);
      if (!existing) return notFound("定型文");
      await this.templates.update(templateId, parsed.data);
      await this.db.batch([
        this.audit.statement({
          actor,
          action: "reply_template.updated",
          targetType: "system",
          targetId: templateId,
          metadata: { key: existing.key, fields: Object.keys(parsed.data).sort().join(",") },
        }),
      ]);
      return await this.getTemplate(templateId);
    } catch (error) {
      return internalFailure("reply.updateTemplate", error);
    }
  }

  async deactivateTemplate(templateId: string, actor: ActorRef): Promise<Result<ReplyTemplate>> {
    try {
      const existing = await this.templates.find(templateId);
      if (!existing) return notFound("定型文");
      await this.templates.deactivate(templateId);
      await this.db.batch([
        this.audit.statement({
          actor,
          action: "reply_template.deactivated",
          targetType: "system",
          targetId: templateId,
          metadata: { key: existing.key },
        }),
      ]);
      return await this.getTemplate(templateId);
    } catch (error) {
      return internalFailure("reply.deactivateTemplate", error);
    }
  }

  /** Render only the editable body. Every outgoing mail gets its signature at send time. */
  async applyTemplate(raw: unknown): Promise<Result<AppliedTemplate>> {
    const parsed = applyTemplateInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);

    try {
      const thread = await this.support.findThread(parsed.data.threadId);
      if (!thread) return notFound("問い合わせ");
      const template = await this.templates.find(parsed.data.templateId);
      if (!template) return notFound("定型文");

      const app = thread.app_id ? await this.apps.findById(thread.app_id) : null;
      const rendered = renderTemplate(template.body, {
        appName: app?.name ?? undefined,
        // Only a name the person typed. Never guessed from the address.
        userName: thread.requester_name ?? undefined,
        supportUrl: app?.support_url ?? this.addresses.defaultSupportUrl,
      });

      const body = await this.withoutSignature(thread.id, rendered);

      return ok({
        bodyText: body,
        unresolved: unresolvedVariables(body),
        subject: replySubjectFor(
          {
            subject: thread.subject,
            source: thread.source as never,
            mailSubject: thread.mail_subject ?? undefined,
          },
          template.subject,
        ),
      });
    } catch (error) {
      return internalFailure("reply.applyTemplate", error);
    }
  }

  // ---- signatures --------------------------------------------------------

  async listSettings(): Promise<Result<AppMailSettings[]>> {
    try {
      return ok(await this.templates.listSettings());
    } catch (error) {
      return internalFailure("reply.listSettings", error);
    }
  }

  async setSettings(raw: unknown, actor: ActorRef): Promise<Result<AppMailSettings>> {
    const parsed = setAppMailSettingsInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      if (parsed.data.appId && !(await this.apps.findById(parsed.data.appId))) {
        return notFound("アプリ");
      }
      const saved = await this.templates.setSettings(parsed.data.appId, parsed.data.signatureText);
      await this.db.batch([
        this.audit.statement({
          actor,
          action: "mail_settings.updated",
          targetType: parsed.data.appId ? "app" : "system",
          targetId: parsed.data.appId ?? "studio",
          metadata: { length: parsed.data.signatureText.length },
        }),
      ]);
      return ok(saved);
    } catch (error) {
      return internalFailure("reply.setSettings", error);
    }
  }

  private async withoutSignature(threadId: string, text: string): Promise<string> {
    const thread = await this.support.findThread(threadId);
    const configured = await this.templates.signature(thread?.app_id ?? undefined);
    const legacy = [
      "────────────────────────",
      "Tomokichi Studio",
      "髙木 友喜",
      "",
      "Web: https://tmkch.io",
      "Email: support@tmkch.io",
      "TEL: 080-6648-1475",
      "────────────────────────",
    ].join("\n");
    let body = text;
    for (const signature of [configured, DEFAULT_MAIL_SIGNATURE, legacy]) {
      if (!signature?.trim()) continue;
      const ending = `\n\n${signature.trim()}`;
      while (body.trimEnd().endsWith(ending)) body = body.trimEnd().slice(0, -ending.length);
    }
    return body;
  }

  async refreshMessageIds(threadId?: string): Promise<void> {
    if (!this.mail.resolveMessageId) return;
    const { results } = await this.db
      .prepare(`SELECT id, transport_id FROM support_messages
      WHERE provider_message_id IS NULL AND transport_id IS NOT NULL
      ${threadId ? "AND thread_id = ?" : ""} ORDER BY message_id_checked_at ASC, created_at DESC LIMIT 50`)
      .bind(...(threadId ? [threadId] : []))
      .all<{ id: string; transport_id: string }>();
    for (const row of results) {
      const messageId = await this.mail.resolveMessageId(row.transport_id);
      await this.db
        .prepare("UPDATE support_messages SET message_id_checked_at = ? WHERE id = ?")
        .bind(nowIso(), row.id)
        .run();
      if (messageId)
        await this.db
          .prepare("UPDATE support_messages SET provider_message_id = ? WHERE id = ?")
          .bind(messageId, row.id)
          .run();
    }
  }

  // ---- sending -----------------------------------------------------------

  async send(
    raw: unknown,
    actor: ActorRef,
    options: { preserveDraft?: boolean; initialMessage?: boolean } = {},
  ): Promise<Result<SupportThreadDetail>> {
    const parsed = sendSupportReplyInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;

    try {
      // Before anything with a side effect. A double-clicked button and a
      // retried fetch both land here with the same key, and the second one is
      // answered with the thread as it stands.
      const already = await this.support.findSend(input.idempotencyKey);
      if (already) {
        if (already.thread_id !== input.threadId) {
          return fail("CONFLICT", "この送信キーは別の問い合わせで使われています。");
        }
        return await this.supportService.detail(input.threadId);
      }

      if (actor.type === "admin") {
        const tickets = new TicketService(this.db);
        const source = await tickets.source("support", input.threadId);
        if (!source.ok) return source;
        {
          const ticket = await tickets.row(source.value.id);
          if (!ticket) return notFound("Ticket");
          if (ticket?.merged_into) return fail("CONFLICT", "統合先のTicketから返信してください。");
          if (ticket && ["CLOSED", "RESOLVED"].includes(ticket.status)) {
            if (!input.reopenIfResolved)
              return fail("CONFLICT", "Ticketを再開してから返信してください。");
            const reopened = await tickets.change(
              { id: ticket.id, revision: ticket.revision, status: "IN_PROGRESS" },
              actor,
            );
            if (!reopened.ok) return reopened;
          }
        }
      }
      const thread = await this.support.findThread(input.threadId);
      if (!thread) return notFound("問い合わせ");
      if (thread.status === "spam") {
        return fail(
          "CONFLICT",
          "迷惑メールに分類された問い合わせには返信できません。先に分類を解除してください。",
        );
      }
      if (thread.status === "resolved" && !input.reopenIfResolved) {
        return fail("CONFLICT", "この問い合わせは解決済みです。再開してから返信してください。");
      }
      if (!thread.requester_email) return fail("VALIDATION_ERROR", "返信先が登録されていません。");

      // A literal `{{userName}}` reaching a customer is worse than a refused
      // send, so it is refused.
      const unresolved = unresolvedVariables(input.bodyText);
      if (unresolved.length > 0) {
        return fail(
          "VALIDATION_ERROR",
          `未置換の項目が残っています: ${unresolved.map((name) => `{{${name}}}`).join(", ")}`,
        );
      }

      if (!this.mail.configured) {
        return fail("MAIL_ERROR", "メール送信機能が設定されていません。");
      }

      await this.refreshMessageIds(input.threadId);
      const { references, inReplyTo } = await this.support.threadReferences(input.threadId);
      const from = `${this.addresses.fromName} <${this.addresses.supportEmail}>`;
      // The subject is resolved here, from the thread and — for a thread that
      // has no subject of its own — the template the operator inserted. The
      // request carried that template's id and never its text, so a tampered
      // one still cannot choose what a reply says it is about.
      const template = input.templateId ? await this.templates.find(input.templateId) : undefined;
      const subject = options.initialMessage
        ? thread.subject
        : replySubjectFor(
            {
              subject: thread.subject,
              source: thread.source as never,
              mailSubject: thread.mail_subject ?? undefined,
            },
            template?.subject,
          );

      const signature =
        (await this.templates.signature(thread.app_id ?? undefined))?.trim() ||
        DEFAULT_MAIL_SIGNATURE;
      const body = await this.withoutSignature(input.threadId, input.bodyText);
      if (!body.trim()) return fail("VALIDATION_ERROR", "返信本文を入力してください。");
      const linkedReport = await this.db
        .prepare("SELECT external_report_id FROM reports WHERE support_thread_id=? LIMIT 1")
        .bind(input.threadId)
        .first<{ external_report_id: string }>();
      const receiptLine = linkedReport ? `受付ID: ${linkedReport.external_report_id}` : undefined;
      const reportFooter = receiptLine && !body.includes(receiptLine) ? `\n\n${receiptLine}` : "";
      const text = `${body}${reportFooter}\n\n${signature}`;
      const sent = await this.mail.sendSupportReply({
        to: thread.requester_email,
        from,
        replyTo: this.addresses.supportEmail,
        subject,
        text,
        signatureText: signature,
        inReplyTo,
        references,
        idempotencyKey: input.idempotencyKey,
      });

      if (!sent.ok) {
        console.error(
          JSON.stringify({
            event: "support.reply_failed",
            threadId: input.threadId,
            code: sent.code,
            provider: this.mail.name,
            // The provider's own summary of what went wrong. Every adapter
            // builds this out of a status code or an error name, never out of
            // a response body — so it says why a send failed without quoting
            // the message that failed to send. Without it, a TRANSPORT_ERROR
            // is indistinguishable from any other and has to be reproduced
            // with a tail to be diagnosed at all.
            detail: sent.detail,
          }),
        );
        // The draft is untouched. Whatever they wrote is still there.
        return fail(
          "MAIL_ERROR",
          "返信を送信できませんでした。下書きは保存されています。時間をおいて再度お試しください。",
        );
      }

      const at = nowIso();
      const messageId = newId();
      const statements: D1PreparedStatement[] = [
        this.db
          .prepare(
            "UPDATE support_threads SET mail_subject = COALESCE(mail_subject, ?) WHERE id = ?",
          )
          .bind(subject, input.threadId),
        this.support.insertMessageStatement({
          id: messageId,
          threadId: input.threadId,
          direction: "outbound",
          providerMessageId: sent.providerMessageId,
          transportId: sent.transportId,
          inReplyTo,
          sender: this.addresses.supportEmail,
          recipient: thread.requester_email,
          // The finished text, stored as sent. Never re-rendered from a
          // template later: editing a template must not change what somebody
          // was actually told.
          bodyText: text,
          at,
        }),
        this.support.touchThreadStatement(input.threadId, "outbound", at),
        this.support.recordSendStatement(input.idempotencyKey, input.threadId, messageId),
        ...(options.preserveDraft ? [] : [this.support.deleteDraftStatement(input.threadId)]),
        this.audit.statement({
          actor,
          action: "support.reply_sent",
          targetType: "support_thread",
          targetId: input.threadId,
          metadata: { length: input.bodyText.length, threaded: Boolean(inReplyTo) },
        }),
      ];

      // Replying does not resolve a thread on its own — that is the operator's
      // call. Reopening one they explicitly chose to reopen is, though, and it
      // is recorded as its own status change rather than happening silently.
      if (thread.status === "resolved") {
        statements.push(
          this.support.statusStatement(input.threadId, "open"),
          this.audit.statement({
            actor,
            action: "support.status_changed",
            targetType: "support_thread",
            targetId: input.threadId,
            metadata: { from: "resolved", to: "open", reason: "reply" },
          }),
        );
      }

      await this.db.batch(statements);
      return await this.supportService.detail(input.threadId);
    } catch (error) {
      return internalFailure("reply.send", error);
    }
  }
}
