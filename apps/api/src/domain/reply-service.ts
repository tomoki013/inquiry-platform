import type {
  ActorRef,
  AppliedTemplate,
  AppMailSettings,
  ReplyTemplate,
  Result,
  SupportDraft,
  SupportThreadDetail,
} from "@inquiry-platform/core";
import {
  applyTemplateInputSchema,
  createReplyTemplateInputSchema,
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
} from "@inquiry-platform/core";
import type { MailProvider } from "@inquiry-platform/notification/mail";
import type { AppRepository } from "../db/apps";
import type { AuditRepository } from "../db/audit";
import type { SupportRepository } from "../db/support";
import type { ProjectMailSettings, TemplateRepository } from "../db/templates";
import { privateText } from "../privacy/crypto";
import type { ProjectMailDelivery } from "../project-mail";
import { internalFailure, notFound, validationFailure } from "./failures";
import { sha256Hex } from "./identity";
import type { SupportService } from "./support-service";
import { TicketService } from "./ticket-service";

/**
 * Web-form threads from the last day still owed a receipt: nobody has written
 * to them and no receipt was recorded. Mail threads are not retried — whether
 * one was machine-sent is known only while it is being ingested. `__PROJECT__`
 * is where aggregate storage adds its project join condition.
 */
export const INQUIRY_RECEIPT_RETRY_SQL = `SELECT t.id FROM support_threads t
  WHERE t.source='web_form' AND t.requester_email<>'' AND t.status='open' AND t.created_at>=?
  AND NOT EXISTS (SELECT 1 FROM support_messages x WHERE x.thread_id=t.id AND x.direction='outbound' __PROJECT__)
  AND NOT EXISTS (SELECT 1 FROM support_reply_sends x WHERE x.idempotency_key='inquiry-receipt-'||t.id __PROJECT__)
  AND NOT EXISTS (SELECT 1 FROM reports x WHERE x.support_thread_id=t.id __PROJECT__)
  ORDER BY t.created_at LIMIT 25`;

export interface ReplyAddresses {
  supportEmail: string;
  fromName: string;
  defaultSupportUrl: string;
  /** The deployment's fallback signature, used when no `app_mail_settings`
   * row applies. Empty means none. */
  defaultSignature: string;
  /** Older signatures to strip from drafts; see `Branding.legacySignatures`. */
  legacySignatures: readonly string[];
  /** See `Branding.replyClosing`. */
  replyClosing?: string;
  /** Project-scoped overrides from the platform's mail settings repository. */
  resolve?: (appId: string | undefined) => Promise<ProjectMailSettings>;
  delivery?: (appId: string | undefined) => ProjectMailDelivery;
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

  mailConfiguredForApp(appId: string): boolean {
    return (this.addresses.delivery?.(appId)?.mail ?? this.mail).configured;
  }

  private async addressesFor(appId: string | undefined) {
    const override = (await this.addresses.resolve?.(appId)) ?? {};
    const delivery = this.addresses.delivery?.(appId);
    return {
      supportEmail: override.supportEmail ?? this.addresses.supportEmail,
      fromName: override.fromName ?? this.addresses.fromName,
      defaultSignature: delivery?.defaultSignature ?? this.addresses.defaultSignature,
      defaultSupportUrl: delivery?.supportUrl ?? this.addresses.defaultSupportUrl,
      replyClosing: (delivery?.replyClosing ?? this.addresses.replyClosing ?? "").trim(),
      mail: delivery?.mail ?? this.mail,
    };
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

  /**
   * A project's own report receipt, when its mail route names a template for
   * it: the template must be active and belong to that project, and render
   * with nothing left to fill (`{{reportId}}` is the receipt ID). Anything
   * else answers `null`, and the caller sends the generic receipt — a receipt
   * is never withheld over its wording.
   */
  async projectReportReceipt(threadId: string, reportId: string): Promise<string | null> {
    const thread = await this.support.findThread(threadId);
    const appId = thread?.app_id ?? undefined;
    const key = appId ? this.addresses.delivery?.(appId)?.reportReceiptTemplate : undefined;
    if (!thread || !appId || !key) return null;
    const template = await this.templates.findByKey(key);
    if (!template?.isActive || template.appId !== appId) return null;
    const app = await this.apps.findById(appId);
    const rendered = renderTemplate(template.body, {
      appName: app?.name ?? undefined,
      userName: thread.requester_name ?? undefined,
      supportUrl: app?.support_url ?? (await this.addressesFor(appId)).defaultSupportUrl,
    }).replace(/\{\{\s*reportId\s*\}\}/g, reportId);
    return unresolvedVariables(rendered).length === 0 && rendered.trim() ? rendered : null;
  }

  /**
   * The receipt a person gets when they open a conversation: by the web form,
   * or by a new mail that is not machine-sent (`SupportService` decides that
   * and only calls in for those).
   *
   * Sent at most once per thread (the idempotency key), never after a person
   * has already been answered, never for a report (it has its own receipt),
   * and never to one of this deployment's own addresses. Failing to send is
   * logged and retried by the cron for web-form threads; it never fails the
   * inquiry itself.
   */
  async sendInquiryReceipt(threadId: string): Promise<void> {
    try {
      const thread = await this.support.findThread(threadId);
      if (!thread?.requester_email || thread.status !== "open") return;
      if (this.addresses.delivery?.(thread.app_id ?? undefined)?.inquiryReceipt === false) return;
      if (thread.source !== "web_form" && thread.source !== "email") return;
      const addresses = await this.addressesFor(thread.app_id ?? undefined);
      const own = [addresses.supportEmail, this.addresses.supportEmail].map((a) =>
        a.trim().toLowerCase(),
      );
      if (own.includes(thread.requester_email.trim().toLowerCase())) return;
      const answered = await this.db
        .prepare(
          `SELECT 1 FROM support_messages WHERE thread_id=? AND direction='outbound'
           UNION ALL SELECT 1 FROM reports WHERE support_thread_id=? LIMIT 1`,
        )
        .bind(threadId, threadId)
        .first();
      if (answered) return;
      const ticket = await this.db
        .prepare(
          "SELECT t.ticket_number FROM tickets t JOIN ticket_sources s ON s.ticket_id=t.id WHERE s.source_type='support' AND s.source_id=? LIMIT 1",
        )
        .bind(threadId)
        .first<{ ticket_number: string }>();
      const number = ticket?.ticket_number;
      const numberLine = number ? `受付番号: ${number}` : "";
      const body =
        (await this.inquiryReceiptTemplate(thread, numberLine)) ??
        [
          "お問い合わせを受け付けました。ご連絡いただきありがとうございます。",
          numberLine,
          "内容を確認のうえ、あらためてご連絡いたします。内容によってはお返事までにお時間をいただく場合がありますので、ご了承ください。",
          "追加でお伝えいただきたいことがあれば、このメールにそのままご返信ください。",
          "※このメールは受付時に自動で送信しています。",
        ]
          .filter(Boolean)
          .join("\n\n");
      const sent = await this.send(
        { threadId, bodyText: body, idempotencyKey: `inquiry-receipt-${threadId}` },
        { type: "system", id: "inquiry-receipt" },
        {
          preserveDraft: true,
          automatic: true,
          countsAsResponse: false,
          // A form has no mail to answer; the receipt's subject becomes the
          // conversation's, and the number in it keeps replies threaded.
          ...(thread.source === "web_form"
            ? {
                subject: `${number ? `[${number}] ` : ""}お問い合わせを受け付けました: ${thread.subject}`,
              }
            : {}),
        },
      );
      if (!sent.ok) internalFailure("reply.sendInquiryReceipt", new Error(sent.error.code));
    } catch (error) {
      internalFailure("reply.sendInquiryReceipt", error);
    }
  }

  async retryInquiryReceipts(): Promise<void> {
    const { results } = await this.db
      .prepare(INQUIRY_RECEIPT_RETRY_SQL.replaceAll("__PROJECT__", ""))
      .bind(new Date(Date.now() - 86_400_000).toISOString())
      .all<{ id: string }>();
    for (const row of results) await this.sendInquiryReceipt(row.id);
  }

  /**
   * An operator-written receipt, most specific first: the project's mail route
   * (`inquiryReceiptTemplate`), then a template keyed `inquiry_receipt_<project>`,
   * then the shared `inquiry_receipt`. Each must be active, belong to this
   * project or to none, and render completely; otherwise the next one is tried
   * and finally the generic wording is used.
   */
  private async inquiryReceiptTemplate(
    thread: { app_id: string | null; requester_name: string | null },
    numberLine: string,
  ): Promise<string | null> {
    const appId = thread.app_id ?? undefined;
    const app = appId ? await this.apps.findById(appId) : null;
    const keys = [
      appId ? this.addresses.delivery?.(appId)?.inquiryReceiptTemplate : undefined,
      app ? `inquiry_receipt_${app.slug.replace(/-/g, "_")}` : undefined,
      "inquiry_receipt",
    ].filter((key): key is string => Boolean(key));
    for (const key of keys) {
      const template = await this.templates.findByKey(key);
      if (!template?.isActive || (template.appId && template.appId !== appId)) continue;
      const rendered = renderTemplate(template.body, {
        appName: app?.name ?? undefined,
        userName: thread.requester_name ?? undefined,
        supportUrl: app?.support_url ?? (await this.addressesFor(appId)).defaultSupportUrl,
      }).replace(/\{\{\s*ticketNumber\s*\}\}/g, numberLine.replace("受付番号: ", ""));
      if (rendered.trim() && unresolvedVariables(rendered).length === 0) return rendered;
    }
    return null;
  }

  /** Render only the editable body. Every outgoing mail gets its signature at send time. */
  async applyTemplate(raw: unknown): Promise<Result<AppliedTemplate>> {
    const parsed = applyTemplateInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);

    try {
      const thread = await this.support.findThread(parsed.data.threadId);
      if (!thread) return notFound("問い合わせ");
      const template = await this.templates.find(parsed.data.templateId);
      if (!template || (template.appId && template.appId !== thread.app_id))
        return notFound("定型文");

      const app = thread.app_id ? await this.apps.findById(thread.app_id) : null;
      const rendered = renderTemplate(template.body, {
        appName: app?.name ?? undefined,
        // Only a name the person typed. Never guessed from the address.
        userName: thread.requester_name ?? undefined,
        supportUrl:
          app?.support_url ??
          (await this.addressesFor(thread.app_id ?? undefined)).defaultSupportUrl,
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
          targetId: parsed.data.appId ?? "default",
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
    let body = text;
    for (const signature of [
      configured,
      (await this.addressesFor(thread?.app_id ?? undefined)).defaultSignature,
      this.addresses.defaultSignature,
      ...this.addresses.legacySignatures,
    ]) {
      if (!signature?.trim()) continue;
      const ending = `\n\n${signature.trim()}`;
      while (body.trimEnd().endsWith(ending)) body = body.trimEnd().slice(0, -ending.length);
    }
    return body;
  }

  async refreshMessageIds(threadId?: string): Promise<void> {
    const { results } = await this.db
      .prepare(`SELECT m.id, m.transport_id, t.app_id FROM support_messages m
      JOIN support_threads t ON t.id=m.thread_id
      WHERE m.provider_message_id IS NULL AND m.transport_id IS NOT NULL
      ${threadId ? "AND m.thread_id = ?" : ""} ORDER BY m.message_id_checked_at ASC, m.created_at DESC LIMIT 50`)
      .bind(...(threadId ? [threadId] : []))
      .all<{ id: string; transport_id: string; app_id: string | null }>();
    for (const row of results) {
      const mail = this.addresses.delivery?.(row.app_id ?? undefined)?.mail ?? this.mail;
      if (!mail.resolveMessageId) continue;
      const messageId = await mail.resolveMessageId(row.transport_id);
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
    options: {
      preserveDraft?: boolean;
      initialMessage?: boolean;
      /** Sent without an operator; see `SupportReplyMail.automatic`. */
      automatic?: boolean;
      /** The subject, decided by the caller. Only system mail sets it. */
      subject?: string;
      /** False for mail that tells somebody nothing but that their message
       * arrived: it must not stop the response clock. */
      countsAsResponse?: boolean;
    } = {},
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

      const addresses = await this.addressesFor(thread.app_id ?? undefined);
      const mail = addresses.mail;
      if (!mail.configured) {
        return fail("MAIL_ERROR", "メール送信機能が設定されていません。");
      }

      await this.refreshMessageIds(input.threadId);
      const { references, inReplyTo } = await this.support.threadReferences(input.threadId);
      const from = `${addresses.fromName} <${addresses.supportEmail}>`;
      // The subject is resolved here, from the thread and — for a thread that
      // has no subject of its own — the template the operator inserted. The
      // request carried that template's id and never its text, so a tampered
      // one still cannot choose what a reply says it is about.
      const template = input.templateId ? await this.templates.find(input.templateId) : undefined;
      if (template?.appId && template.appId !== thread.app_id) return notFound("定型文");
      const subject = options.subject
        ? options.subject
        : options.initialMessage
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
        addresses.defaultSignature.trim();
      const body = await this.withoutSignature(input.threadId, input.bodyText);
      if (!body.trim()) return fail("VALIDATION_ERROR", "返信本文を入力してください。");
      const linkedReport = await this.db
        .prepare("SELECT external_report_id FROM reports WHERE support_thread_id=? LIMIT 1")
        .bind(input.threadId)
        .first<{ external_report_id: string }>();
      const receiptLine = linkedReport ? `受付ID: ${linkedReport.external_report_id}` : undefined;
      const reportFooter = receiptLine && !body.includes(receiptLine) ? `\n\n${receiptLine}` : "";
      // The closing goes last, above the signature, once.
      const content = `${body}${reportFooter}`.trimEnd();
      const closing = addresses.replyClosing;
      const text = `${content}${closing && !content.endsWith(closing) ? `\n\n${closing}` : ""}\n\n${signature}`;
      const existingAttempt = await this.db
        .prepare(
          "SELECT thread_id,provider_key FROM support_reply_attempts WHERE idempotency_key=?",
        )
        .bind(input.idempotencyKey)
        .first<{ thread_id: string; provider_key: string }>();
      if (existingAttempt && existingAttempt.thread_id !== input.threadId)
        return fail("CONFLICT", "この送信キーは別の問い合わせで使われています。");
      const partitioned = await this.db
        .prepare(
          "SELECT 1 FROM project_storage WHERE project_id=COALESCE(?,(SELECT value FROM platform_settings WHERE key='default_service_id'),'unassigned') AND state='active'",
        )
        .bind(thread.app_id)
        .first();
      const proposedKey = partitioned
        ? `reply-${await sha256Hex(new TextEncoder().encode(`${thread.app_id ?? "unassigned"}:${input.threadId}:${input.idempotencyKey}`))}`
        : input.idempotencyKey;
      await this.db
        .prepare(
          "INSERT OR IGNORE INTO support_reply_attempts(idempotency_key,thread_id,provider_key,created_at) VALUES(?,?,?,?)",
        )
        .bind(input.idempotencyKey, input.threadId, proposedKey, nowIso())
        .run();
      const attempt = await this.db
        .prepare(
          "SELECT thread_id,provider_key FROM support_reply_attempts WHERE idempotency_key=?",
        )
        .bind(input.idempotencyKey)
        .first<{ thread_id: string; provider_key: string }>();
      if (!attempt || attempt.thread_id !== input.threadId)
        return fail("CONFLICT", "送信キーの競合を検出しました。");
      // Ours, so it is known whether or not the provider reports its own.
      const domain = addresses.supportEmail.split("@")[1]?.trim() || "localhost";
      const ownMessageId = `<${newId()}@${domain}>`;
      const sent = await mail.sendSupportReply({
        to: thread.requester_email,
        from,
        replyTo: addresses.supportEmail,
        subject,
        text,
        signatureText: signature,
        inReplyTo,
        references,
        idempotencyKey: attempt.provider_key,
        messageId: ownMessageId,
        ...(options.automatic ? { automatic: true } : {}),
      });

      if (!sent.ok) {
        console.error(
          JSON.stringify({
            event: "support.reply_failed",
            threadId: input.threadId,
            code: sent.code,
            provider: mail.name,
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
          .bind(privateText(this.db, subject), input.threadId),
        this.support.insertMessageStatement({
          id: messageId,
          threadId: input.threadId,
          direction: "outbound",
          providerMessageId: sent.providerMessageId ?? ownMessageId,
          transportId: sent.transportId,
          inReplyTo,
          sender: addresses.supportEmail,
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
        // The projection triggers copy the send into the ticket; these run
        // after them in the same batch. Done here rather than in the triggers
        // because every project's storage carries its own copy of those.
        ...(options.automatic
          ? [
              this.db
                .prepare("UPDATE ticket_messages SET is_automatic=1 WHERE legacy_message_id=?")
                .bind(messageId),
            ]
          : []),
        ...(options.countsAsResponse === false
          ? [
              this.db
                .prepare(
                  "UPDATE tickets SET first_response_at=NULL WHERE id=(SELECT ticket_id FROM ticket_sources WHERE source_type='support' AND source_id=?) AND first_response_at=(SELECT created_at FROM ticket_messages WHERE legacy_message_id=?)",
                )
                .bind(input.threadId, messageId),
            ]
          : []),
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
