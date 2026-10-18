import { describe, expect, it } from "vitest";
import { admin, appActor, expectOk, FakeMailProvider, harness, seedApp } from "./harness";

/*
 * Somebody who writes in is told, once, that their message arrived — by a mail
 * marked automatic, which neither stops the response clock nor answers a
 * machine. Everything that is not a person opening a conversation (an
 * operator's ticket, a reply on an existing thread, an auto-reply, a report)
 * gets no receipt from here.
 */

const mailActor = { type: "email", id: "mail-ingress" } as const;

async function setup() {
  const h = await harness({ receipts: true });
  await seedApp(h, "orbit");
  return h;
}

async function form(h: Awaited<ReturnType<typeof setup>>, overrides: Record<string, unknown> = {}) {
  const thread = expectOk<{ id: string }>(
    (await h.support.createThread(
      {
        appSlug: "orbit",
        source: "web_form",
        requesterEmail: "someone@example.com",
        subject: "書き出しについて",
        bodyText: "SVGで保存できますか？",
        providerMessageId: `form-${crypto.randomUUID()}`,
        ...overrides,
      },
      appActor,
    )) as never,
  );
  await h.settled();
  return thread.id;
}

async function ticketFor(h: Awaited<ReturnType<typeof setup>>, threadId: string) {
  return h.db
    .prepare(
      "SELECT t.ticket_number, t.first_response_at FROM tickets t JOIN ticket_sources s ON s.ticket_id=t.id WHERE s.source_type='support' AND s.source_id=?",
    )
    .bind(threadId)
    .first<{ ticket_number: string; first_response_at: string | null }>();
}

describe("the receipt for a new inquiry", () => {
  it("answers a web form once, automatic, with the ticket number", async () => {
    const h = await setup();
    const threadId = await form(h);
    const ticket = await ticketFor(h, threadId);
    expect(h.mail.sent).toHaveLength(1);
    const mail = h.mail.sent[0];
    expect(mail?.to).toBe("someone@example.com");
    expect(mail?.automatic).toBe(true);
    expect(mail?.subject).toBe(
      `[${ticket?.ticket_number}] お問い合わせを受け付けました: 書き出しについて`,
    );
    expect(mail?.text).toContain(`受付番号: ${ticket?.ticket_number}`);
    expect(mail?.text).toContain("お問い合わせを受け付けました。");

    // Shown as automatic, and the person still counts as unanswered.
    const message = await h.db
      .prepare(
        "SELECT is_automatic FROM ticket_messages WHERE direction='OUTBOUND' AND ticket_id=(SELECT ticket_id FROM ticket_sources WHERE source_type='support' AND source_id=?)",
      )
      .bind(threadId)
      .first<{ is_automatic: number }>();
    expect(message?.is_automatic).toBe(1);
    expect(ticket?.first_response_at).toBeNull();

    // A retry or a second trigger sends nothing more.
    await h.reply.sendInquiryReceipt(threadId);
    await h.reply.retryInquiryReceipts();
    expect(h.mail.sent).toHaveLength(1);
  });

  it("lets the first real reply start the response clock", async () => {
    const h = await setup();
    const threadId = await form(h);
    expectOk(
      (await h.reply.send(
        { threadId, bodyText: "SVGにも対応予定です。", idempotencyKey: "manual-1" },
        admin,
      )) as never,
    );
    expect((await ticketFor(h, threadId))?.first_response_at).not.toBeNull();
  });

  it("is retried by the cron when the first send failed", async () => {
    const h = await setup();
    h.mail.failNext = true;
    await form(h);
    expect(h.mail.sent).toHaveLength(0);
    await h.reply.retryInquiryReceipts();
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]?.text).toContain("受付番号:");
    // Already answered by a person: the retry leaves it alone.
    h.mail.failNext = true;
    const other = await form(h, { requesterEmail: "other@example.com" });
    expectOk(
      (await h.reply.send(
        { threadId: other, bodyText: "回答です", idempotencyKey: "manual-2" },
        admin,
      )) as never,
    );
    await h.reply.retryInquiryReceipts();
    expect(h.mail.sent.filter((m) => m.to === "other@example.com")).toHaveLength(1);
  });

  it("is not sent for an operator's ticket, a form without an address, or our own address", async () => {
    const h = await setup();
    await form(h, { source: "internal" });
    await form(h, { requesterEmail: "" });
    await form(h, { requesterEmail: "Support@Example.com" });
    expect(h.mail.sent).toHaveLength(0);
  });

  it("answers a person's new mail in its own thread, and never a machine or a follow-up", async () => {
    const h = await setup();
    expectOk(
      (await h.support.ingestInboundEmail(
        {
          from: "taro@example.com",
          to: "support@example.com",
          subject: "ログインできません",
          bodyText: "パスワードを変えたら入れなくなりました",
          messageId: "<m1@example.com>",
          appSlug: "orbit",
        },
        mailActor,
      )) as never,
    );
    await h.settled();
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]?.subject).toBe("Re: ログインできません");
    expect(h.mail.sent[0]?.inReplyTo).toBe("<m1@example.com>");

    // A follow-up on the same conversation.
    expectOk(
      (await h.support.ingestInboundEmail(
        {
          from: "taro@example.com",
          subject: "Re: ログインできません",
          bodyText: "追記です",
          messageId: "<m2@example.com>",
          inReplyTo: "<m1@example.com>",
          appSlug: "orbit",
        },
        mailActor,
      )) as never,
    );
    // An out-of-office reply that opens a new thread.
    expectOk(
      (await h.support.ingestInboundEmail(
        {
          from: "away@example.com",
          subject: "不在通知",
          bodyText: "休暇中です",
          messageId: "<m3@example.com>",
          appSlug: "orbit",
          automated: true,
        },
        mailActor,
      )) as never,
    );
    await h.settled();
    expect(h.mail.sent).toHaveLength(1);
  });

  it("uses an operator's template, most specific first, and falls back when it cannot", async () => {
    const h = await setup();
    const appId = (
      await h.db.prepare("SELECT id FROM apps WHERE slug='orbit'").first<{
        id: string;
      }>()
    )?.id;
    const template = (key: string, body: string, forApp?: string) =>
      h.reply.createTemplate(
        {
          key,
          name: key,
          category: "acknowledgement",
          ...(forApp ? { appId: forApp } : {}),
          body,
          includeSignature: true,
          isActive: true,
          sortOrder: 0,
        },
        admin,
      );
    expectOk((await template("inquiry_receipt", "共通の受付です。番号 {{ticketNumber}}")) as never);
    await form(h);
    expect(h.mail.sent.at(-1)?.text).toMatch(/^共通の受付です。番号 TK-\d+/);

    expectOk((await template("inquiry_receipt_orbit", "{{appName}}の受付です。", appId)) as never);
    await form(h);
    expect(h.mail.sent.at(-1)?.text).toMatch(/^orbitの受付です。/);

    // A placeholder nobody can fill: the generic wording, not a broken mail.
    const broken = await h.db
      .prepare("UPDATE reply_templates SET body='{{answer}}' WHERE key='inquiry_receipt_orbit'")
      .run();
    expect(broken.success).toBe(true);
    await form(h);
    expect(h.mail.sent.at(-1)?.text).toMatch(/^共通の受付です。/);
  });
});

describe("a project's receipt settings", () => {
  async function settings(
    h: Awaited<ReturnType<typeof setup>>,
    slug: string | null,
    values: { receipt?: boolean; template?: string },
  ) {
    await h.db
      .prepare(
        `INSERT INTO app_mail_settings (app_id, signature_text, updated_at, inquiry_receipt, inquiry_receipt_template)
         VALUES (${slug ? "(SELECT id FROM apps WHERE slug=?)" : "NULL"}, '', '2026-10-18T00:00:00.000Z', ?, ?)`,
      )
      .bind(
        ...(slug ? [slug] : []),
        values.receipt === undefined ? null : values.receipt ? 1 : 0,
        values.template ?? null,
      )
      .run();
  }

  it("turns the receipt off for one project, and back on over a deployment-wide off", async () => {
    const h = await setup();
    await settings(h, "orbit", { receipt: false });
    await form(h);
    expect(h.mail.sent).toHaveLength(0);

    const other = await setup();
    await settings(other, null, { receipt: false });
    await settings(other, "orbit", { receipt: true });
    await form(other);
    expect(other.mail.sent).toHaveLength(1);
  });

  it("decides before a mail route's older switch does", async () => {
    const mail = new FakeMailProvider();
    const h = await harness({
      receipts: true,
      mail,
      delivery: () => ({ mail, inquiryReceipt: false }),
    });
    await seedApp(h, "orbit");
    await form(h as never);
    expect(mail.sent).toHaveLength(0);

    await settings(h as never, "orbit", { receipt: true });
    await form(h as never);
    expect(mail.sent).toHaveLength(1);
  });

  it("writes it in the project's own words: its template, subject, name fallback and receipt ID", async () => {
    const h = await setup();
    const appId = (
      await h.db.prepare("SELECT id FROM apps WHERE slug='orbit'").first<{ id: string }>()
    )?.id;
    expectOk(
      (await h.reply.createTemplate(
        {
          key: "orbit_auto_ack",
          name: "受付",
          category: "acknowledgement",
          appId,
          subject: "【{{appName}}】お問い合わせを受け付けました",
          body: "{{userName|お客様}} 様\n\n受付ID: {{receiptId}}",
          includeSignature: true,
          isActive: true,
          sortOrder: 0,
        },
        admin,
      )) as never,
    );
    await settings(h, "orbit", { template: "orbit_auto_ack" });

    const anonymous = await form(h);
    const mail = h.mail.sent.at(-1);
    expect(mail?.subject).toBe("【orbit】お問い合わせを受け付けました");
    expect(mail?.text).toMatch(new RegExp(`^お客様 様\\n\\n受付ID: ${anonymous}`));

    await form(h, { requesterName: "山田" });
    expect(h.mail.sent.at(-1)?.text).toMatch(/^山田 様/);
  });
});
