import type { IngestInboundEmailResult, Result } from "@tomokichi/admin-contracts";
import { beforeEach, expect, it } from "vitest";
import type { MailIngressEnv } from "../../mail-ingress/src/index";
import ingress from "../../mail-ingress/src/index";
import { appActor, type Harness, harness, seedApp } from "./harness";

let h: Harness;
const reportId = "11111111-1111-4111-8111-111111111111";
let threadId: string;
beforeEach(async () => {
  h = await harness();
  await seedApp(h);
  const report = await h.reports.create(
    {
      appSlug: "remeet",
      externalReportId: reportId,
      contentType: "wish",
      contentExternalId: "22222222-2222-4222-8222-222222222222",
      reasonCode: "other",
      reporterEmail: "reporter@example.com",
    },
    appActor,
  );
  if (!report.ok) throw new Error("create failed");
  const detail = await h.reports.detail(report.value.reportId);
  if (!detail.ok) throw new Error("missing report");
  threadId = detail.value.supportThreadId!;
  // Reproduce production: sending-only provider cannot resolve Message-ID.
  await h.db
    .prepare("UPDATE support_messages SET provider_message_id=NULL WHERE direction='outbound'")
    .run();
});

async function receive(
  subject: string,
  body: string,
  type = "text/plain",
  from = "reporter@example.com",
) {
  const encode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const raw = [
    `From: Tester <${from}>`,
    "To: support@tmkch.io",
    `Subject: =?UTF-8?B?${encode(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@example.com>`,
    "In-Reply-To: <unavailable-provider-id@example.com>",
    "References: <unavailable-provider-id@example.com>",
    "MIME-Version: 1.0",
    `Content-Type: ${type}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    encode(body),
  ].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  const results: Array<Result<IngestInboundEmailResult>> = [];
  const env = {
    SUPPORT_EMAIL: "support@tmkch.io",
    MAX_STORED_BYTES: "5242880",
    ADMIN_CORE: {
      ingestInboundEmail: async (input: unknown) => {
        const result = await h.support.ingestInboundEmail(input, {
          type: "email",
          id: "test-ingress",
        });
        results.push(result);
        return result;
      },
    },
  } as unknown as MailIngressEnv;
  await ingress.email(
    {
      from,
      to: "support@tmkch.io",
      raw: new Blob([bytes]).stream(),
      rawSize: bytes.byteLength,
      headers: new Headers(),
      forward: async () => {
        throw new Error("Real forwarding must never be attempted");
      },
      setReject: () => {},
    },
    env,
    {} as ExecutionContext,
  );
  if (!results[0]?.ok) throw new Error("Mail ingress failed");
  return results[0].value;
}

it("routes an encoded Japanese subject with report ID through the real email parser to its report", async () => {
  const result = await receive(
    `Re: ${h.mail.sent[0]!.subject}`,
    "追記です。引用本文は削除しました。",
  );
  expect(result.threadId).toBe(threadId);
  expect(result.newThread).toBe(false);
});
it("routes an older HTML-only quoted receipt through the real email parser", async () => {
  const subject = "[Remeet] 通報の受付・対応について";
  await h.db
    .prepare("UPDATE support_threads SET subject=? WHERE id=?")
    .bind(subject, threadId)
    .run();
  const result = await receive(
    `Re: ${subject}`,
    `<p>追記です</p><blockquote><div>通報を受け付けました。</div><div>受付ID: ${reportId}</div></blockquote>`,
    "text/html",
  );
  expect(result.threadId).toBe(threadId);
  expect(result.newThread).toBe(false);
});
it("keeps a different sender separate even with copied MIME subject and receipt", async () => {
  const result = await receive(
    `Re: ${h.mail.sent[0]!.subject}`,
    `受付ID: ${reportId}`,
    "text/plain",
    "someone-else@example.com",
  );
  expect(result.threadId).not.toBe(threadId);
  expect(result.newThread).toBe(true);
});
