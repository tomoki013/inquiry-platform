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
