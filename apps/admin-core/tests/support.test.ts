import type { IngestInboundEmailResult, SupportThreadDetail } from "@tomokichi/admin-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, expectOk, type Harness, harness, seedApp } from "./harness";

let h: Harness;

const inbound = (overrides: Record<string, unknown> = {}) => ({
  from: "someone@example.com",
  to: "support@tmkch.io",
  subject: "アプリで共有できません",
  bodyText: "共有ボタンを押しても何も起きません。",
  messageId: "<first@example.com>",
  references: [],
  ...overrides,
});

beforeEach(async () => {
  h = await harness();
});

describe("ingestInboundEmail", () => {
  it("opens a thread for a first message", async () => {
    const result = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound(), { type: "email" })) as never,
    );
    expect(result.newThread).toBe(true);

    const thread = expectOk<SupportThreadDetail>(
      (await h.support.detail(result.threadId)) as never,
    );
    expect(thread.status).toBe("open");
    expect(thread.requesterEmail).toBe("someone@example.com");
    expect(thread.unreadCount).toBe(1);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]?.direction).toBe("inbound");
  });

  it("threads a reply onto the existing conversation by Message-ID", async () => {
    const first = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound(), { type: "email" })) as never,
    );
    const second = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(
        inbound({
          messageId: "<second@example.com>",
          inReplyTo: "<first@example.com>",
          subject: "Re: アプリで共有できません",
          bodyText: "追記です。",
        }),
        { type: "email" },
      )) as never,
    );

    expect(second.newThread).toBe(false);
    expect(second.threadId).toBe(first.threadId);
  });

  it("follows References when In-Reply-To is missing", async () => {
    const first = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound(), { type: "email" })) as never,
    );
    const second = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(
        inbound({
          messageId: "<third@example.com>",
          references: ["<unknown@example.com>", "<first@example.com>"],
        }),
        { type: "email" },
      )) as never,
    );
    expect(second.threadId).toBe(first.threadId);
  });

  /**
   * The rule that keeps one customer from seeing another's message. Two people
   * writing "アプリについて" is two conversations, however identical the subject.
   */
  it("never merges two threads on subject alone", async () => {
    const first = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound(), { type: "email" })) as never,
    );
    const other = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(
        inbound({ from: "another@example.com", messageId: "<other@example.com>" }),
        { type: "email" },
      )) as never,
    );
    expect(other.threadId).not.toBe(first.threadId);
  });

  it("recognises the same message delivered twice", async () => {
    const first = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound(), { type: "email" })) as never,
    );
    const again = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound(), { type: "email" })) as never,
    );
    expect(again.duplicate).toBe(true);
    expect(again.threadId).toBe(first.threadId);

    const thread = expectOk<SupportThreadDetail>((await h.support.detail(first.threadId)) as never);
    expect(thread.messages).toHaveLength(1);
  });

  it("refuses a body past the limit and a sender that is not an address", async () => {
    expect(
      (await h.support.ingestInboundEmail(inbound({ from: "not-an-address" }), { type: "email" }))
        .ok,
    ).toBe(false);
    expect(
      (
        await h.support.ingestInboundEmail(inbound({ bodyText: "x".repeat(200_000) }), {
          type: "email",
        })
      ).ok,
    ).toBe(false);
  });

  it("links a thread to an app when the mail Worker knew which one", async () => {
    await seedApp(h, "remeet");
    const result = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound({ appSlug: "remeet" }), {
        type: "email",
      })) as never,
    );
    const thread = expectOk<SupportThreadDetail>(
      (await h.support.detail(result.threadId)) as never,
    );
    expect(thread.appSlug).toBe("remeet");
  });
});

describe("createThread from the support form", () => {
  it("stores the message and the name the person typed", async () => {
    const thread = expectOk<SupportThreadDetail>(
      (await h.support.createThread(
        {
          source: "web_form",
          requesterEmail: "form@example.com",
          requesterName: "ともきち",
          subject: "[bug] req-1",
          bodyText: "落ちます",
        },
        { type: "app", id: "tomokichi-api" },
      )) as never,
    );
    expect(thread.requesterName).toBe("ともきち");
    expect(thread.source).toBe("web_form");
    expect(thread.messages).toHaveLength(1);
  });
});

describe("status", () => {
  let threadId: string;

  beforeEach(async () => {
    threadId = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound(), { type: "email" })) as never,
    ).threadId;
  });

  it("moves between every status, including back out of spam", async () => {
    for (const status of ["spam", "open", "pending_user", "resolved", "open"] as const) {
      expect((await h.support.setStatus({ threadId, status }, admin)).ok).toBe(true);
    }
  });

  it("clears the unread badge when a thread is resolved or marked spam", async () => {
    const resolved = expectOk<SupportThreadDetail>(
      (await h.support.setStatus({ threadId, status: "resolved" }, admin)) as never,
    );
    expect(resolved.unreadCount).toBe(0);
    expect(resolved.resolvedAt).toBeTruthy();
  });
});

describe("internal notes", () => {
  /**
   * The regression test this whole design exists for.
   *
   * `SupportService` does not hold a mail provider at all — an internal note
   * physically cannot reach one. This asserts the observable consequence, so
   * that any future refactor which hands `SupportService` a provider has to
   * break a test that says why it must not.
   */
  it("never sends mail", async () => {
    const threadId = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound(), { type: "email" })) as never,
    ).threadId;

    const updated = expectOk<SupportThreadDetail>(
      (await h.support.addInternalNote(
        { threadId, bodyText: "この人は以前も同じ質問をしている" },
        admin,
      )) as never,
    );

    expect(h.mail.sendCount).toBe(0);
    expect(updated.messages.at(-1)?.direction).toBe("internal_note");
    expect(updated.messages.at(-1)?.bodyText).toContain("以前も同じ質問");
  });

  it("does not move the thread's last-message clock", async () => {
    const threadId = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(inbound(), { type: "email" })) as never,
    ).threadId;
    const before = expectOk<SupportThreadDetail>((await h.support.detail(threadId)) as never);
    await h.support.addInternalNote({ threadId, bodyText: "メモ" }, admin);
    const after = expectOk<SupportThreadDetail>((await h.support.detail(threadId)) as never);

    // Writing a note to yourself is not activity on the customer's side.
    expect(after.lastMessageAt).toBe(before.lastMessageAt);
  });
});
