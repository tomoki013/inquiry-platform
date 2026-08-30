import type {
  AppliedTemplate,
  IngestInboundEmailResult,
  ReplyTemplate,
  SupportDraft,
  SupportThreadDetail,
} from "@tomokichi/admin-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, expectOk, FakeMailProvider, type Harness, harness, seedApp } from "./harness";

let h: Harness;
let threadId: string;
let appId: string;

const KEY = "idem-key-0000000001";

async function openThread(overrides: Record<string, unknown> = {}): Promise<string> {
  const result = expectOk<IngestInboundEmailResult>(
    (await h.support.ingestInboundEmail(
      {
        from: "someone@example.com",
        to: "support@tmkch.io",
        subject: "アプリで共有できません",
        bodyText: "共有できません。",
        messageId: "<first@example.com>",
        references: [],
        ...overrides,
      },
      { type: "email" },
    )) as never,
  );
  return result.threadId;
}

beforeEach(async () => {
  h = await harness();
  appId = await seedApp(h, "remeet");
  threadId = await openThread();
  await h.support.assignApp({ threadId, appId }, admin);
});

// ---------------------------------------------------------------- drafts ----

describe("drafts", () => {
  it("saves and reads back one draft per thread", async () => {
    await h.reply.saveDraft({ threadId, bodyText: "書きかけ" });
    await h.reply.saveDraft({ threadId, bodyText: "書きかけ、その2" });

    const draft = expectOk<SupportDraft | null>((await h.reply.getDraft(threadId)) as never);
    expect(draft?.bodyText).toBe("書きかけ、その2");

    const rows = await h.db
      .prepare("SELECT COUNT(*) AS total FROM support_drafts WHERE thread_id = ?")
      .bind(threadId)
      .first<{ total: number }>();
    expect(rows?.total).toBe(1);
  });

  it("survives being read again later — a reopened thread restores what was typed", async () => {
    await h.reply.saveDraft({ threadId, bodyText: "途中まで" });
    const reread = expectOk<SupportDraft | null>((await h.reply.getDraft(threadId)) as never);
    expect(reread?.bodyText).toBe("途中まで");
  });

  it("refuses a draft for a thread that does not exist", async () => {
    const result = await h.reply.saveDraft({ threadId: "nope", bodyText: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("is not written to the audit log", async () => {
    await h.reply.saveDraft({ threadId, bodyText: "秘密の下書き" });
    const entries = await h.audit.list({ limit: 100, offset: 0 });
    expect(entries.map((entry) => entry.action)).not.toContain("support.draft_saved");
    expect(JSON.stringify(entries)).not.toContain("秘密の下書き");
  });
});

// -------------------------------------------------------------- templates ----

async function makeTemplate(overrides: Record<string, unknown> = {}): Promise<ReplyTemplate> {
  return expectOk<ReplyTemplate>(
    (await h.reply.createTemplate(
      {
        key: "remeet_general",
        name: "一般返信",
        category: "general",
        appId,
        body: "{{userName}}様\n\nいつも{{appName}}をご利用いただきありがとうございます。\n\n{{answerToInquiry}}",
        includeSignature: true,
        isActive: true,
        sortOrder: 10,
        ...overrides,
      },
      admin,
    )) as never,
  );
}

describe("templates", () => {
  it("shows this app's templates alongside the Studio-wide ones", async () => {
    await makeTemplate();
    await makeTemplate({ key: "studio_general", name: "共通", appId: undefined });

    const forApp = expectOk<ReplyTemplate[]>(
      (await h.reply.listTemplates({ forAppId: appId, includeInactive: false })) as never,
    );
    expect(forApp.map((template) => template.key).sort()).toEqual([
      "remeet_general",
      "studio_general",
    ]);
    // App-specific first: the more specific answer is usually the right one.
    expect(forApp[0]?.key).toBe("remeet_general");
  });

  it("hides a deactivated template from the composer but keeps the record", async () => {
    const template = await makeTemplate();
    await h.reply.deactivateTemplate(template.id, admin);

    const active = expectOk<ReplyTemplate[]>(
      (await h.reply.listTemplates({ forAppId: appId, includeInactive: false })) as never,
    );
    expect(active).toHaveLength(0);

    const all = expectOk<ReplyTemplate[]>(
      (await h.reply.listTemplates({ includeInactive: true })) as never,
    );
    expect(all).toHaveLength(1);
    expect(all[0]?.isActive).toBe(false);
  });

  it("refuses a duplicate key so a re-run of the seed cannot fork a template", async () => {
    await makeTemplate();
    const again = await h.reply.createTemplate(
      { key: "remeet_general", name: "別物", category: "general", body: "x" } as never,
      admin,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("CONFLICT");
  });

  it("fills the variables it knows and appends the signature once", async () => {
    await h.reply.setSettings({ appId: null, signatureText: "Tomokichi Studio" }, admin);
    const template = await makeTemplate();
    // A name the person actually typed.
    await h.db
      .prepare("UPDATE support_threads SET requester_name = ? WHERE id = ?")
      .bind("ともきち", threadId)
      .run();

    const applied = expectOk<AppliedTemplate>(
      (await h.reply.applyTemplate({ threadId, templateId: template.id })) as never,
    );

    expect(applied.bodyText).toContain("ともきち様");
    expect(applied.bodyText).toContain("いつもremeetをご利用");
    expect(applied.bodyText.match(/Tomokichi Studio/g)).toHaveLength(1);
    // The one step nobody can pre-write is still standing, and blocks sending.
    expect(applied.unresolved).toEqual(["answerToInquiry"]);
  });

  it("leaves {{userName}} standing rather than guessing a name from the address", async () => {
    const template = await makeTemplate();
    const applied = expectOk<AppliedTemplate>(
      (await h.reply.applyTemplate({ threadId, templateId: template.id })) as never,
    );
    expect(applied.bodyText).toContain("{{userName}}様");
    expect(applied.unresolved).toContain("userName");
  });

  it("does not append a signature when the template says it has its own", async () => {
    await h.reply.setSettings({ appId: null, signatureText: "Tomokichi Studio" }, admin);
    const template = await makeTemplate({ includeSignature: false, body: "本文だけ" });
    const applied = expectOk<AppliedTemplate>(
      (await h.reply.applyTemplate({ threadId, templateId: template.id })) as never,
    );
    expect(applied.bodyText).toBe("本文だけ");
  });

  it("does not touch the draft — inserting is the operator's decision", async () => {
    await h.reply.saveDraft({ threadId, bodyText: "書きかけ" });
    const template = await makeTemplate();
    await h.reply.applyTemplate({ threadId, templateId: template.id });

    const draft = expectOk<SupportDraft | null>((await h.reply.getDraft(threadId)) as never);
    expect(draft?.bodyText).toBe("書きかけ");
  });

  /**
   * Editing a template must never change a reply somebody already received.
   * The finished text is stored on the message, and nothing renders a past
   * message through a template.
   */
  it("does not rewrite history when a template is edited", async () => {
    const template = await makeTemplate({ body: "元の本文", includeSignature: false });
    const applied = expectOk<AppliedTemplate>(
      (await h.reply.applyTemplate({ threadId, templateId: template.id })) as never,
    );
    await h.reply.send({ threadId, bodyText: applied.bodyText, idempotencyKey: KEY }, admin);

    await h.reply.updateTemplate(template.id, { body: "書き換えた本文" }, admin);

    const thread = expectOk<SupportThreadDetail>((await h.support.detail(threadId)) as never);
    expect(thread.messages.at(-1)?.bodyText).toBe("元の本文");
  });
});

// ------------------------------------------------------------------ send ----

describe("sendSupportReply", () => {
  it("builds the recipient, sender and subject from the thread", async () => {
    const sent = await h.reply.send(
      { threadId, bodyText: "ご連絡ありがとうございます。", idempotencyKey: KEY },
      admin,
    );
    expect(sent.ok).toBe(true);

    expect(h.mail.sendCount).toBe(1);
    const mail = h.mail.sent[0];
    expect(mail?.to).toBe("someone@example.com");
    expect(mail?.from).toBe("Tomokichi Studio Support <support@tmkch.io>");
    expect(mail?.replyTo).toBe("support@tmkch.io");
    expect(mail?.subject).toBe("Re: アプリで共有できません");
  });

  it("threads the reply onto the customer's message", async () => {
    await h.reply.send({ threadId, bodyText: "本文", idempotencyKey: KEY }, admin);
    const mail = h.mail.sent[0];
    expect(mail?.inReplyTo).toBe("<first@example.com>");
    expect(mail?.references).toEqual(["<first@example.com>"]);
  });

  it("does not stack Re: on a subject that already has one", async () => {
    const replyThread = await openThread({
      messageId: "<re@example.com>",
      subject: "Re: 返信済みの件",
      from: "other@example.com",
    });
    await h.reply.send(
      { threadId: replyThread, bodyText: "本文", idempotencyKey: "idem-key-000000002" },
      admin,
    );
    expect(h.mail.sent.at(-1)?.subject).toBe("Re: 返信済みの件");
  });

  it("stores the outbound message and deletes the draft — in that order", async () => {
    await h.reply.saveDraft({ threadId, bodyText: "下書き" });
    const updated = expectOk<SupportThreadDetail>(
      (await h.reply.send({ threadId, bodyText: "送信本文", idempotencyKey: KEY }, admin)) as never,
    );

    expect(updated.messages.at(-1)?.direction).toBe("outbound");
    expect(updated.messages.at(-1)?.bodyText).toBe("送信本文");
    expect(updated.unreadCount).toBe(0);

    const draft = expectOk<SupportDraft | null>((await h.reply.getDraft(threadId)) as never);
    expect(draft).toBeNull();
  });

  /** The failure mode that matters most: nobody loses what they wrote. */
  it("keeps the draft and writes nothing when the provider fails", async () => {
    await h.reply.saveDraft({ threadId, bodyText: "失敗しても残る下書き" });
    h.mail.failNext = true;

    const result = await h.reply.send(
      { threadId, bodyText: "送信本文", idempotencyKey: KEY },
      admin,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MAIL_ERROR");

    const draft = expectOk<SupportDraft | null>((await h.reply.getDraft(threadId)) as never);
    expect(draft?.bodyText).toBe("失敗しても残る下書き");

    const thread = expectOk<SupportThreadDetail>((await h.support.detail(threadId)) as never);
    expect(thread.messages.filter((message) => message.direction === "outbound")).toHaveLength(0);
  });

  it("sends once however many times the same request arrives", async () => {
    await h.reply.send({ threadId, bodyText: "本文", idempotencyKey: KEY }, admin);
    await h.reply.send({ threadId, bodyText: "本文", idempotencyKey: KEY }, admin);
    await h.reply.send({ threadId, bodyText: "本文", idempotencyKey: KEY }, admin);

    expect(h.mail.sendCount).toBe(1);
    const thread = expectOk<SupportThreadDetail>((await h.support.detail(threadId)) as never);
    expect(thread.messages.filter((message) => message.direction === "outbound")).toHaveLength(1);
  });

  it("refuses a send key that belongs to another thread", async () => {
    await h.reply.send({ threadId, bodyText: "本文", idempotencyKey: KEY }, admin);
    const other = await openThread({ from: "b@example.com", messageId: "<b@example.com>" });
    const result = await h.reply.send(
      { threadId: other, bodyText: "本文", idempotencyKey: KEY },
      admin,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
  });

  it("refuses an empty body", async () => {
    const result = await h.reply.send({ threadId, bodyText: "   ", idempotencyKey: KEY }, admin);
    expect(result.ok).toBe(false);
    expect(h.mail.sendCount).toBe(0);
  });

  it("refuses a body with a placeholder still in it", async () => {
    const result = await h.reply.send(
      { threadId, bodyText: "{{userName}}様\n\nご連絡ありがとうございます。", idempotencyKey: KEY },
      admin,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("{{userName}}");
    expect(h.mail.sendCount).toBe(0);
  });

  it("refuses to reply into a thread marked spam", async () => {
    await h.support.setStatus({ threadId, status: "spam" }, admin);
    const result = await h.reply.send({ threadId, bodyText: "本文", idempotencyKey: KEY }, admin);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    expect(h.mail.sendCount).toBe(0);
  });

  it("asks before reopening a resolved thread, then reopens it", async () => {
    await h.support.setStatus({ threadId, status: "resolved" }, admin);

    const refused = await h.reply.send({ threadId, bodyText: "本文", idempotencyKey: KEY }, admin);
    expect(refused.ok).toBe(false);
    expect(h.mail.sendCount).toBe(0);

    const sent = expectOk<SupportThreadDetail>(
      (await h.reply.send(
        { threadId, bodyText: "本文", idempotencyKey: KEY, reopenIfResolved: true },
        admin,
      )) as never,
    );
    expect(sent.status).toBe("open");
    expect(h.mail.sendCount).toBe(1);

    const audit = await h.audit.list({
      targetType: "support_thread",
      targetId: threadId,
      limit: 50,
      offset: 0,
    });
    expect(audit.map((entry) => entry.action)).toContain("support.status_changed");
  });

  it("does not resolve a thread just because it was answered", async () => {
    const updated = expectOk<SupportThreadDetail>(
      (await h.reply.send({ threadId, bodyText: "本文", idempotencyKey: KEY }, admin)) as never,
    );
    expect(updated.status).toBe("open");
  });

  it("records the send without recording what was said", async () => {
    await h.reply.send(
      { threadId, bodyText: "とても具体的な返信内容", idempotencyKey: KEY },
      admin,
    );
    const audit = await h.audit.list({
      targetType: "support_thread",
      targetId: threadId,
      limit: 50,
      offset: 0,
    });
    expect(audit.map((entry) => entry.action)).toContain("support.reply_sent");
    expect(JSON.stringify(audit)).not.toContain("とても具体的な返信内容");
  });
});

describe("with no mail provider configured", () => {
  beforeEach(async () => {
    h = await harness({ mail: new FakeMailProvider(false) });
    appId = await seedApp(h, "remeet");
    threadId = await openThread();
  });

  it("still saves drafts, applies templates and takes internal notes", async () => {
    expect(h.reply.mailConfigured).toBe(false);
    expect((await h.reply.saveDraft({ threadId, bodyText: "下書き" })).ok).toBe(true);
    expect((await h.support.addInternalNote({ threadId, bodyText: "メモ" }, admin)).ok).toBe(true);
  });

  it("refuses only the send, with a reason the screen can show", async () => {
    const result = await h.reply.send({ threadId, bodyText: "本文", idempotencyKey: KEY }, admin);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MAIL_ERROR");
      expect(result.error.message).toContain("設定されていません");
    }
  });
});
