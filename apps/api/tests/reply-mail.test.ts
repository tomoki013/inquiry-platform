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

describe("an operator's copy of their own reply (ccSelf)", () => {
  async function mailThread(h: Awaited<ReturnType<typeof harness>>, recipients: string[] = []) {
    return expectOk<{ threadId: string }>(
      (await h.support.ingestInboundEmail(
        {
          from: "taro@corp.example",
          to: "support@example.com",
          recipients: ["support@example.com", ...recipients],
          subject: "ログインできません",
          bodyText: "入れません",
          messageId: "<q1@corp.example>",
          appSlug: "orbit",
        },
        mailActor,
      )) as never,
    ).threadId;
  }
  const send = (
    h: Awaited<ReturnType<typeof harness>>,
    threadId: string,
    options: { ccSelf?: boolean } = { ccSelf: true },
  ) =>
    h.reply.send(
      { threadId, bodyText: "確認します", idempotencyKey: crypto.randomUUID() },
      admin,
      options,
    );
  async function projectOperator(
    h: Awaited<ReturnType<typeof harness>>,
    appId: string,
    to: string,
  ) {
    await h.db
      .prepare(
        "INSERT INTO app_mail_settings (app_id, signature_text, notification_email, updated_at) VALUES (?, '', ?, ?)",
      )
      .bind(appId, to, new Date().toISOString())
      .run();
  }

  it("copies the support address for the project's operator, records it, and says so", async () => {
    const h = await harness({ operatorEmail: "deploy-ops@private.example" });
    const appId = await seedApp(h, "orbit");
    await projectOperator(h, appId, "orbit-ops@private.example");
    const threadId = await mailThread(h, ["boss@corp.example"]);
    const sent = expectOk<{
      selfCopy?: string;
      messages: { direction: string; recipient?: string }[];
    }>((await send(h, threadId)) as never);
    expect(sent.selfCopy).toBe("copied");
    expect(h.mail.sent[0]?.to).toBe("taro@corp.example");
    // The person sees the support address, never the operator's own.
    expect(h.mail.sent[0]?.cc).toEqual(["boss@corp.example", "support@example.com"]);
    expect(JSON.stringify(h.mail.sent[0])).not.toContain("private.example");
    expect(h.mail.sent[0]?.copyId).toBeTruthy();
    expect(sent.messages.at(-1)?.recipient).toBe(
      "taro@corp.example, boss@corp.example, support@example.com",
    );
    const ticketMessage = await h.db
      .prepare("SELECT recipient FROM ticket_messages WHERE direction='OUTBOUND'")
      .first<{ recipient: string }>();
    expect(ticketMessage?.recipient).toContain("support@example.com");
    expect(ticketMessage?.recipient).not.toContain("orbit-ops@private.example");
    // Where the copy is forwarded, for mail-ingress.
    expect(await h.reply.selfCopyForwardTo(appId)).toBe("orbit-ops@private.example");
    const [audit] = (await h.audit.list({ limit: 100, offset: 0 })).filter(
      (entry) => entry.action === "support.reply_sent",
    );
    expect(audit?.metadata).toMatchObject({ cc: 2, selfCopy: "copied" });
    expect(JSON.stringify(audit)).not.toContain("orbit-ops@private.example");
  });

  it("falls back to the deployment's operator address", async () => {
    const h = await harness({ operatorEmail: "deploy-ops@private.example" });
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    expect(expectOk<{ selfCopy?: string }>((await send(h, threadId)) as never).selfCopy).toBe(
      "copied",
    );
    expect(h.mail.sent[0]?.cc).toEqual(["support@example.com"]);
    const preview = expectOk<{ self: unknown }>((await h.reply.previewThread(threadId)) as never);
    expect(preview.self).toEqual({
      cc: "support@example.com",
      forwardTo: "deploy-ops@private.example",
      address: "deploy-ops@private.example",
      outcome: "copied",
    });
  });

  it("sends without it, and says why, when there is no operator address", async () => {
    const h = await harness();
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    expect(expectOk<{ selfCopy?: string }>((await send(h, threadId)) as never).selfCopy).toBe(
      "not_configured",
    );
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]?.cc).toBeUndefined();
  });

  it("never copies the person or the support address, nor anyone twice", async () => {
    const asPerson = await harness({ operatorEmail: "Taro@corp.example" });
    await seedApp(asPerson, "orbit");
    const thread = await mailThread(asPerson);
    expect(expectOk<{ selfCopy?: string }>((await send(asPerson, thread)) as never).selfCopy).toBe(
      "is_recipient",
    );
    expect(asPerson.mail.sent[0]?.cc).toBeUndefined();

    const asSupport = await harness({ operatorEmail: "support@example.com" });
    await seedApp(asSupport, "orbit");
    const other = await mailThread(asSupport);
    expect(expectOk<{ selfCopy?: string }>((await send(asSupport, other)) as never).selfCopy).toBe(
      "is_recipient",
    );

    // The person had already copied the operator: reply-all reaches them, and
    // nothing is added.
    const copied = await harness({ operatorEmail: "ops@private.example" });
    await seedApp(copied, "orbit");
    const third = await mailThread(copied, ["OPS@private.example"]);
    expect(expectOk<{ selfCopy?: string }>((await send(copied, third)) as never).selfCopy).toBe(
      "is_recipient",
    );
    expect(copied.mail.sent[0]?.cc).toEqual(["ops@private.example"]);
  });

  it("files neither a ticket nor a message when the copy comes back, and still takes the person's reply", async () => {
    const h = await harness({ operatorEmail: "ops@private.example" });
    h.mail.reportsMessageId = false;
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    expectOk((await send(h, threadId)) as never);
    const reply = h.mail.sent[0];
    const count = async () =>
      (await h.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM support_threads) AS threads, (SELECT COUNT(*) FROM support_messages) AS messages, (SELECT COUNT(*) FROM ticket_messages) AS ticketMessages",
        )
        .first<{ threads: number; messages: number; ticketMessages: number }>())!;
    const before = await count();
    // As Email Routing hands it back: from our own address, by any of the
    // marks — our header, our Message-ID, or our header under a Message-ID
    // the provider replaced.
    for (const mark of [
      { messageId: reply?.messageId, copyId: reply?.copyId },
      { messageId: reply?.messageId },
      { messageId: "<rewritten-by-provider@example.net>", copyId: reply?.copyId },
    ]) {
      const back = expectOk<{ selfCopy?: boolean; newThread: boolean }>(
        (await h.support.ingestInboundEmail(
          {
            from: "support@example.com",
            to: "support@example.com",
            recipients: ["taro@corp.example", "support@example.com"],
            subject: reply?.subject ?? "",
            bodyText: "確認します",
            inReplyTo: "<q1@corp.example>",
            appSlug: "orbit",
            ...mark,
          },
          mailActor,
        )) as never,
      );
      expect(back).toMatchObject({ selfCopy: true, newThread: false });
    }
    expect(await count()).toEqual(before);
    // The same marks from anybody else are just mail.
    const forged = expectOk<{ selfCopy?: boolean }>(
      (await h.support.ingestInboundEmail(
        {
          from: "taro@corp.example",
          subject: `Re: ${reply?.subject}`,
          bodyText: "ありがとうございます",
          messageId: "<answer@corp.example>",
          inReplyTo: reply?.messageId,
          copyId: reply?.copyId,
          appSlug: "orbit",
        },
        mailActor,
      )) as never,
    );
    expect(forged.selfCopy).toBeUndefined();
    expect((await count()).messages).toBe(before.messages + 1);
  });

  it("is off unless asked, and never on a receipt", async () => {
    const h = await harness({ operatorEmail: "ops@private.example", receipts: true });
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    await h.settled();
    expect(h.mail.sent[0]?.automatic).toBe(true);
    expect(h.mail.sent[0]?.cc).toBeUndefined();
    const plain = expectOk<{ selfCopy?: string }>((await send(h, threadId, {})) as never);
    expect(plain.selfCopy).toBeUndefined();
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

describe("an operator's own To, Cc and subject (overrides)", () => {
  async function mailThread(h: Awaited<ReturnType<typeof harness>>) {
    return expectOk<{ threadId: string }>(
      (await h.support.ingestInboundEmail(
        {
          from: "taro@corp.example",
          to: "support@example.com",
          recipients: ["support@example.com", "boss@corp.example"],
          subject: "ログインできません",
          bodyText: "入れません",
          messageId: "<q1@corp.example>",
          appSlug: "orbit",
        },
        mailActor,
      )) as never,
    ).threadId;
  }
  const send = (
    h: Awaited<ReturnType<typeof harness>>,
    threadId: string,
    overrides: { to?: string[]; cc?: string[]; subject?: string },
    extra: { ccSelf?: boolean } = {},
  ) =>
    h.reply.send({ threadId, bodyText: "確認します", idempotencyKey: crypto.randomUUID() }, admin, {
      overrides,
      ...extra,
    });

  it("previews what a plain reply gets, and a plain reply gets exactly that", async () => {
    const h = await harness();
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    const preview = expectOk<{
      from: string;
      to: string[];
      cc: string[];
      self: { address: string | null; outcome: string };
      subject: string;
    }>((await h.reply.previewThread(threadId)) as never);
    expect(preview).toMatchObject({
      to: ["taro@corp.example"],
      cc: ["boss@corp.example"],
      subject: "Re: ログインできません",
    });
    expectOk((await reply(h, threadId, "確認します")) as never);
    const sent = h.mail.sent[0];
    expect(sent?.from).toBe(preview.from);
    expect([sent?.to]).toEqual(preview.to);
    expect(sent?.cc).toEqual(preview.cc);
    expect(sent?.subject).toBe(preview.subject);
  });

  it("sends to the operator's To and Cc, records them, and audits only counts", async () => {
    const h = await harness();
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    expectOk(
      (await send(h, threadId, {
        to: ["Taro@corp.example", "hanako@corp.example", "taro@corp.example"],
        cc: ["hanako@corp.example", "kaito@corp.example"],
        subject: "ログインの件（追加のご案内）",
      })) as never,
    );
    const sent = h.mail.sent[0];
    expect(sent?.to).toBe("Taro@corp.example");
    expect(sent?.alsoTo).toEqual(["hanako@corp.example"]);
    // Already on the To: not copied again. Reply-all's boss is replaced.
    expect(sent?.cc).toEqual(["kaito@corp.example"]);
    expect(sent?.subject).toBe("ログインの件（追加のご案内）");
    // The thread stays threaded however the subject reads.
    expect(sent?.inReplyTo).toBe("<q1@corp.example>");
    const message = await h.db
      .prepare("SELECT recipient FROM support_messages WHERE thread_id=? AND direction='outbound'")
      .bind(threadId)
      .first<{ recipient: string }>();
    expect(message?.recipient).toBe("Taro@corp.example, hanako@corp.example, kaito@corp.example");
    const audit = await h.db
      .prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action='support.reply_sent'")
      .first<{ metadata: string }>();
    expect(JSON.parse(audit?.metadata ?? "{}")).toMatchObject({
      overridden: "to,cc,subject",
      to: 2,
      cc: 1,
    });
    expect(audit?.metadata).not.toContain("@");
    // The operator's subject is now the conversation's, as in a mail client.
    expectOk((await reply(h, threadId, "続きです")) as never);
    expect(h.mail.sent[1]?.subject).toBe("Re: ログインの件（追加のご案内）");
    expect(h.mail.sent[1]?.cc).toEqual(["boss@corp.example"]);
  });

  it("sends no reply-all Cc for an empty list, and still adds the operator's own copy", async () => {
    const h = await harness();
    const appId = await seedApp(h, "orbit");
    await h.db
      .prepare(
        "INSERT INTO app_mail_settings (app_id, signature_text, notification_email, updated_at) VALUES (?, '', 'ops@private.example', ?)",
      )
      .bind(appId, new Date().toISOString())
      .run();
    const threadId = await mailThread(h);
    const preview = expectOk<{ self: { address: string | null; outcome: string } }>(
      (await h.reply.previewThread(threadId)) as never,
    );
    expect(preview.self).toEqual({
      cc: "support@example.com",
      forwardTo: "ops@private.example",
      address: "ops@private.example",
      outcome: "copied",
    });
    const result = expectOk<{ selfCopy?: string }>(
      (await send(h, threadId, { cc: [] }, { ccSelf: true })) as never,
    );
    expect(result.selfCopy).toBe("copied");
    expect(h.mail.sent[0]?.cc).toEqual(["support@example.com"]);
  });

  it("refuses a malformed address, our own address, a blank or two-line subject", async () => {
    const h = await harness();
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    for (const overrides of [
      { to: ["not-an-address"] },
      { to: ["Taro <taro@corp.example>"] },
      { to: ["support@example.com"] },
      { cc: ["SUPPORT@example.com"] },
      { to: [] },
      { subject: "  " },
      { subject: "件名\nBcc: x@attacker.example" },
    ]) {
      expect(await send(h, threadId, overrides)).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" },
      });
    }
    expect(h.mail.sent).toHaveLength(0);
  });

  it("keeps the ticket number a form's subject carries, and files the answer by it", async () => {
    const h = await harness({ receipts: true });
    h.mail.reportsMessageId = false;
    await seedApp(h, "orbit");
    const threadId = await formThread(h);
    await h.settled();
    const number = h.mail.sent[0]?.subject.match(/TK-\d+/)?.[0];
    expect(number).toBeTruthy();
    expectOk((await send(h, threadId, { subject: "書き出しの件" })) as never);
    expect(h.mail.sent[1]?.subject).toBe(`書き出しの件 [${number}]`);
    // Named already, it is not added twice.
    expectOk((await send(h, threadId, { subject: `${number} 書き出しの件` })) as never);
    expect(h.mail.sent[2]?.subject).toBe(`${number} 書き出しの件`);
    // A colleague the operator wrote to answers without headers.
    expectOk((await send(h, threadId, { to: ["colleague@example.org"] })) as never);
    const answered = expectOk<{ threadId: string; newThread: boolean }>(
      (await h.support.ingestInboundEmail(
        {
          from: "colleague@example.org",
          subject: `Re: ${h.mail.sent[1]?.subject}`,
          bodyText: "確認しました",
          messageId: "<colleague@example.org>",
          appSlug: "orbit",
        },
        mailActor,
      )) as never,
    );
    expect(answered).toMatchObject({ threadId, newThread: false });
  });

  it("answers the person's latest subject, keeping a ticket number they dropped", async () => {
    const h = await harness({ receipts: true });
    h.mail.reportsMessageId = false;
    await seedApp(h, "orbit");
    const threadId = await formThread(h);
    await h.settled();
    const receipt = h.mail.sent[0]?.subject ?? "";
    const number = receipt.match(/TK-\d+/)?.[0];
    expect(number).toBeTruthy();
    // The first reply to a form answers its receipt.
    expectOk((await reply(h, threadId, "一通目です")) as never);
    expect(h.mail.sent[1]?.subject).toBe(`Re: ${receipt}`);
    // Their client changed the subject and lost the number.
    expectOk(
      (await h.support.ingestInboundEmail(
        {
          from: "someone@example.com",
          subject: "RE: Re: 書き出しの続き",
          bodyText: "もう一つ",
          messageId: "<again@example.com>",
          inReplyTo: h.mail.sent[1]?.messageId,
          appSlug: "orbit",
        },
        mailActor,
      )) as never,
    );
    expectOk((await reply(h, threadId, "二通目です")) as never);
    expect(h.mail.sent[2]?.subject).toBe(`Re: 書き出しの続き [${number}]`);
    const subjects = await h.db
      .prepare(
        "SELECT direction, subject FROM ticket_messages WHERE ticket_id=(SELECT ticket_id FROM ticket_sources WHERE source_type='support' AND source_id=?) ORDER BY created_at, rowid",
      )
      .bind(threadId)
      .all<{ direction: string; subject: string | null }>();
    expect(subjects.results.map((row) => row.subject)).toEqual([
      null,
      receipt,
      `Re: ${receipt}`,
      "RE: Re: 書き出しの続き",
      `Re: 書き出しの続き [${number}]`,
    ]);
  });

  it("is ignored for automatic mail", async () => {
    const h = await harness();
    await seedApp(h, "orbit");
    const threadId = await mailThread(h);
    expectOk(
      (await h.reply.send(
        { threadId, bodyText: "受付しました", idempotencyKey: crypto.randomUUID() },
        { type: "system", id: "inquiry-receipt" },
        { automatic: true, overrides: { to: ["x@example.org"], subject: "別件" } },
      )) as never,
    );
    expect(h.mail.sent[0]?.to).toBe("taro@corp.example");
    expect(h.mail.sent[0]?.subject).toBe("Re: ログインできません");
  });
});
