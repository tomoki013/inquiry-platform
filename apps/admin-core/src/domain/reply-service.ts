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
  fail,
  listReplyTemplatesInputSchema,
  newId,
  nowIso,
  ok,
  renderTemplate,
  replySubject,
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
      return ok(await this.support.draft(threadId));
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
      return ok(await this.support.saveDraft(parsed.data.threadId, parsed.data.bodyText));
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
   * Renders a template for one thread, and stops there.
   *
   * The signature is appended **here**, once, if the template says so — not at
   * send time. So what the operator reads in the composer is exactly the text
   * that will leave, and a template that already ends with a sign-off does not
   * get a second one bolted on. Nothing is written: the composer puts the text
   * in the box and a person decides.
   */
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

      let body = rendered;
      if (template.includeSignature) {
        const signature = await this.templates.signature(thread.app_id ?? undefined);
        if (signature && signature.trim().length > 0) body = `${rendered}\n\n${signature}`;
      }

      return ok({ bodyText: body, unresolved: unresolvedVariables(body) });
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

  // ---- sending -----------------------------------------------------------

  async send(raw: unknown, actor: ActorRef): Promise<Result<SupportThreadDetail>> {
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

      const { references, inReplyTo } = await this.support.threadReferences(input.threadId);
      const from = `${this.addresses.fromName} <${this.addresses.supportEmail}>`;
      const subject = replySubject(thread.subject);

      const sent = await this.mail.sendSupportReply({
        to: thread.requester_email,
        from,
        replyTo: this.addresses.supportEmail,
        subject,
        text: input.bodyText,
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
        this.support.insertMessageStatement({
          id: messageId,
          threadId: input.threadId,
          direction: "outbound",
          providerMessageId: sent.providerMessageId,
          inReplyTo,
          sender: this.addresses.supportEmail,
          recipient: thread.requester_email,
          // The finished text, stored as sent. Never re-rendered from a
          // template later: editing a template must not change what somebody
          // was actually told.
          bodyText: input.bodyText,
          at,
        }),
        this.support.touchThreadStatement(input.threadId, "outbound", at),
        this.support.recordSendStatement(input.idempotencyKey, input.threadId, messageId),
        this.support.deleteDraftStatement(input.threadId),
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
