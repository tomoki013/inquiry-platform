import { describe, expect, it } from "vitest";
import { admin, appActor, expectOk, FakeMailProvider, harness, seedApp } from "./harness";

/*
 * Every mail about one inquiry belongs to one conversation in the person's
 * mail client, and every one ends the same way.
 */

const mailActor = { type: "email", id: "mail-ingress" } as const;

async function formThread(h: Awaited<ReturnType<typeof harness>>) {
  return expectOk<{ id: string }>(
    (await h.support.createThread(
      {
        appSlug: "orbit",
        source: "web_form",
        requesterEmail: "someone@example.com",
        subject: "書き出しについて",
        bodyText: "SVGで保存できますか？",
      },
      appActor,
    )) as never,
  ).id;
}

const reply = (h: Awaited<ReturnType<typeof harness>>, threadId: string, bodyText: string) =>
  h.reply.send({ threadId, bodyText, idempotencyKey: crypto.randomUUID() }, admin);

describe("replies stay in one conversation", () => {
  it("sends each reply under its own Message-ID and answers the previous one", async () => {
    const h = await harness();
    h.mail.reportsMessageId = false;
    await seedApp(h, "orbit");
    const threadId = await formThread(h);
    expectOk((await reply(h, threadId, "一通目です")) as never);
    expectOk((await reply(h, threadId, "二通目です")) as never);
    const [first, second] = h.mail.sent;
    expect(first?.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
    expect(second?.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
    expect(second?.messageId).not.toBe(first?.messageId);
    expect(second?.inReplyTo).toBe(first?.messageId);
    expect(second?.references).toEqual([first?.messageId]);
    // Same subject, as a reply, so clients group them.
    expect(second?.subject).toBe(`Re: ${first?.subject}`);
  });

  it("files the person's answer to a reply under the same ticket", async () => {
    const h = await harness();
    h.mail.reportsMessageId = false;
    await seedApp(h, "orbit");
    const threadId = await formThread(h);
    expectOk((await reply(h, threadId, "回答です")) as never);
    const answered = expectOk<{ threadId: string; newThread: boolean }>(
      (await h.support.ingestInboundEmail(
        {
          from: "someone@example.com",
          subject: `Re: ${h.mail.sent[0]?.subject}`,
          bodyText: "ありがとうございます",
          messageId: "<answer@example.org>",
          inReplyTo: h.mail.sent[0]?.messageId,
        },
        mailActor,
      )) as never,
    );
    expect(answered).toMatchObject({ threadId, newThread: false });
    // And the next reply answers that mail.
    expectOk((await reply(h, threadId, "どういたしまして")) as never);
    expect(h.mail.sent[1]?.inReplyTo).toBe("<answer@example.org>");
  });

  it("prefers the Message-ID the provider reports, when it reports one", async () => {
    const h = await harness();
    await seedApp(h, "orbit");
    const threadId = await formThread(h);
    const original = h.mail.sendSupportReply.bind(h.mail);
    h.mail.sendSupportReply = async (mail) => {
      const result = await original(mail);
      return result.ok ? { ...result, providerMessageId: "<provider@mail.example>" } : result;
    };
    expectOk((await reply(h, threadId, "一通目")) as never);
    expectOk((await reply(h, threadId, "二通目")) as never);
    expect(h.mail.sent[1]?.inReplyTo).toBe("<provider@mail.example>");
  });
});

describe("the closing line", () => {
  const closing = "以上、よろしくお願いいたします。";

  it("ends every reply above the signature, once", async () => {
    const h = await harness({ replyClosing: closing });
    await seedApp(h, "orbit");
    const threadId = await formThread(h);
    expectOk((await reply(h, threadId, "対応予定です。")) as never);
    expectOk((await reply(h, threadId, `対応しました。\n\n${closing}\n`)) as never);
    for (const mail of h.mail.sent) {
      const [content] = (mail.text ?? "").split(`\n\n${mail.signatureText}`);
      expect(content?.endsWith(closing)).toBe(true);
      expect(content?.split(closing)).toHaveLength(2);
    }
  });

  it("ends automatic receipts too, and a project can choose its own or none", async () => {
    const own = new FakeMailProvider();
    const h = await harness({
      replyClosing: closing,
      receipts: true,
      delivery: (appId) => (appId ? { mail: own, replyClosing: "" } : { mail: h.mail }),
    });
    await seedApp(h, "orbit");
    await formThread(h);
    await h.settled();
    expect(own.sent).toHaveLength(1);
    expect(own.sent[0]?.text).not.toContain(closing);
  });
});

describe("turning the inquiry receipt off for a project", () => {
  it("sends nothing for that project and still answers others", async () => {
    const own = new FakeMailProvider();
    const shared = new FakeMailProvider();
    const off = await harness({
      receipts: true,
      mail: shared,
      delivery: (appId) => (appId ? { mail: own, inquiryReceipt: false } : { mail: shared }),
    });
    await seedApp(off, "orbit");
    await formThread(off);
    await off.settled();
    expect(own.sent).toHaveLength(0);
    expect(shared.sent).toHaveLength(0);
  });
});

describe("reply-all", () => {
  async function mailThread(h: Awaited<ReturnType<typeof harness>>) {
    return expectOk<{ threadId: string }>(
      (await h.support.ingestInboundEmail(
        {
          from: "taro@corp.example",
          to: "support@example.com",
          recipients: ["support@example.com", "boss@corp.example", "notification@example.com"],
          subject: "ログインできません",
          bodyText: "入れません",
          messageId: "<q1@corp.example>",
          appSlug: "orbit",
        },
        mailActor,
      )) as never,
    ).threadId;
  }

  it("copies everyone else on the person's mail, never us", async () => {
    const h = await harness();
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    expectOk((await reply(h, threadId, "確認します")) as never);
    expect(h.mail.sent[0]?.to).toBe("taro@corp.example");
    expect(h.mail.sent[0]?.cc).toEqual(["boss@corp.example"]);
  });

  it("follows the conversation: a colleague who answers is copied next time", async () => {
    const h = await harness();
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    expectOk((await reply(h, threadId, "確認します")) as never);
    expectOk(
      (await h.support.ingestInboundEmail(
        {
          from: "hanako@corp.example",
          recipients: ["support@example.com", "taro@corp.example", "boss@corp.example"],
          subject: "Re: ログインできません",
          bodyText: "代わりに返信します",
          messageId: "<q2@corp.example>",
          // What the fake provider reported as the sent Message-ID.
          inReplyTo: "<sent-1@test>",
          appSlug: "orbit",
        },
        mailActor,
      )) as never,
    );
    expectOk((await reply(h, threadId, "承知しました")) as never);
    expect(h.mail.sent[1]?.to).toBe("taro@corp.example");
    expect(h.mail.sent[1]?.cc).toEqual(["hanako@corp.example", "boss@corp.example"]);
  });

  it("sends a receipt to the person alone, and a form reply has nobody to copy", async () => {
    const h = await harness({ receipts: true });
    await seedApp(h, "orbit");
    await mailThread(h);
    await h.settled();
    expect(h.mail.sent[0]?.automatic).toBe(true);
    expect(h.mail.sent[0]?.cc).toBeUndefined();
    const form = await formThread(h);
    await h.settled();
    expectOk((await reply(h, form, "回答です")) as never);
    expect(h.mail.sent.at(-1)?.cc).toBeUndefined();
  });
});

describe("provider-confirmed reply parents", () => {
  it("waits for the receipt ID and then replies to the real provider ID", async () => {
    const h = await harness({ receipts: true });
    await seedApp(h, "orbit");
    const id = await formThread(h);
    await h.settled();
    const transportId = "d56f4e72-18ce-4c0f-8e24-0b1a9a7dd234";
    await h.db
      .prepare(
        "UPDATE support_messages SET provider_message_id='<temporary@example.com>', transport_id=?, message_id_checked_at=NULL WHERE thread_id=? AND direction='outbound'",
      )
      .bind(transportId, id)
      .run();
    const { ReplyService } = await import("../src/domain/reply-service");
    const { SupportRepository } = await import("../src/db/support");
    const { AppRepository } = await import("../src/db/apps");
    const { AuditRepository } = await import("../src/db/audit");
    const { TemplateRepository } = await import("../src/db/templates");
    const { recordMailReceipt } = await import("../src/mail-receipts");
    const service = new ReplyService(
      h.db,
      new SupportRepository(h.db),
      h.support,
      new TemplateRepository(h.db),
      new AppRepository(h.db),
      new AuditRepository(h.db),
      h.mail,
      {
        supportEmail: "support@example.com",
        fromName: "Example",
        defaultSupportUrl: "https://example.com",
        defaultSignature: "Example",
        legacySignatures: [],
        delivery: () => ({ mail: h.mail, requireVerifiedReplyParent: true }),
      },
    );
    const waiting = await service.send(
      { threadId: id, bodyText: "回答", idempotencyKey: "wait-parent" },
      admin,
    );
    expect(waiting.ok).toBe(false);
    expect(h.mail.sent).toHaveLength(1);
    const received = await recordMailReceipt(
      h.db,
      "orbit",
      new Request("https://internal", {
        method: "POST",
        body: JSON.stringify({ transportId, messageId: "<actual@provider.example>" }),
      }),
    );
    expect(received.status).toBe(200);
    const sent = await service.send(
      { threadId: id, bodyText: "回答", idempotencyKey: "real-parent" },
      admin,
    );
    expect(sent.ok).toBe(true);
    expect(h.mail.sent[1]?.inReplyTo).toBe("<actual@provider.example>");
    expect(h.mail.sent[1]?.references).toContain("<actual@provider.example>");
    expect(h.mail.sent[1]?.references).not.toContain("<temporary@example.com>");
    expect(h.mail.sent[1]?.subject).toBe(`Re: ${h.mail.sent[0]?.subject}`);
    const replay = await recordMailReceipt(
      h.db,
      "orbit",
      new Request("https://internal", {
        method: "POST",
        body: JSON.stringify({ transportId, messageId: "<other@provider.example>" }),
      }),
    );
    expect(replay.status).toBe(409);
  });
});

it("pins a project's sender instead of falling back to the shared address", async () => {
  const { FakeMailProvider } = await import("./harness");
  const mail = new FakeMailProvider();
  const h = await harness({
    mail,
    delivery: () => ({ mail, supportEmail: "contact@orbit.example" }),
  });
  await seedApp(h, "orbit");
  const threadId = await formThread(h);
  expectOk((await reply(h, threadId, "Answer")) as never);
  expect(mail.sent[0]?.from).toContain("<contact@orbit.example>");
  expect(mail.sent[0]?.replyTo).toBe("contact@orbit.example");
});
