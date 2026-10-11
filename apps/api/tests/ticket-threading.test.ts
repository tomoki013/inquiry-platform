import type { IngestInboundEmailResult } from "@inquiry-platform/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ticketNumbersFromReply } from "../src/domain/ticket-threading";
import { expectOk, type Harness, harness, seedApp } from "./harness";

/*
 * A reply to a receipt mail whose threading headers were lost (forwarded,
 * rewritten by a client, or sent before the provider reported a Message-ID)
 * still reaches its ticket by number — only from the address that opened it.
 */

let h: Harness;

const mail = (overrides: Record<string, unknown> = {}) => ({
  from: "someone@example.com",
  to: "support@example.com",
  subject: "掲載について",
  bodyText: "掲載したいです。",
  messageId: "<first@example.com>",
  references: [],
  ...overrides,
});

async function open(overrides: Record<string, unknown> = {}) {
  const result = expectOk<IngestInboundEmailResult>(
    (await h.support.ingestInboundEmail(mail(overrides), { type: "email" })) as never,
  );
  const row = await h.db
    .prepare(
      "SELECT t.ticket_number AS number FROM tickets t JOIN ticket_sources s ON s.ticket_id=t.id AND s.source_type='support' WHERE s.source_id=?",
    )
    .bind(result.threadId)
    .first<{ number: string }>();
  return { threadId: result.threadId, number: row?.number ?? "" };
}

beforeEach(async () => {
  h = await harness();
  await seedApp(h, "orbit");
});

describe("ticketNumbersFromReply", () => {
  it("reads a number from the subject, or an exact receipt line in the body", () => {
    expect(ticketNumbersFromReply("Re: 受付のご案内 [TK-000123]", "")).toEqual(["TK-000123"]);
    expect(
      ticketNumbersFromReply("Re: 受付のご案内", "追記です\n\n> 受付番号：TK-000045\n"),
    ).toEqual(["TK-000045"]);
    expect(ticketNumbersFromReply("Re: x", "前回の TK-000045 の件ですが")).toEqual([]);
  });
});

describe("a reply that names its ticket", () => {
  it("joins the ticket opened by the same address", async () => {
    const first = await open();
    const reply = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(
        mail({
          subject: "Re: お問い合わせを受け付けました",
          bodyText: `追加の情報です。\n\n> 受付番号：${first.number}`,
          messageId: "<second@example.com>",
        }),
        { type: "email" },
      )) as never,
    );
    expect(reply.newThread).toBe(false);
    expect(reply.threadId).toBe(first.threadId);
  });

  it("does not let another address write into it", async () => {
    const first = await open();
    const other = expectOk<IngestInboundEmailResult>(
      (await h.support.ingestInboundEmail(
        mail({
          from: "stranger@example.com",
          subject: `Re: [${first.number}]`,
          messageId: "<third@example.com>",
        }),
        { type: "email" },
      )) as never,
    );
    expect(other.newThread).toBe(true);
    expect(other.threadId).not.toBe(first.threadId);
  });
});
