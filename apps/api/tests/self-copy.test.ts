import { createExecutionContext } from "cloudflare:test";
import { INTERNAL_ORIGIN } from "@inquiry-platform/core";
import { expect, it } from "vitest";
import { SupportRepository } from "../src/db/support";
import { DeliveryJobs } from "../src/domain/delivery-jobs";
import { InboundJobs } from "../src/domain/inbound-jobs";
import AdminCore from "../src/index";
import { admin, expectOk, harness, seedApp, testEnv } from "./harness";

const mailActor = { type: "email" } as const;

/**
 * The operator's copy of a reply (`ccSelf`) goes to the support address and
 * comes back through mail-ingress. Core tells mail-ingress it is a copy and
 * where to forward it, and never files it — not even if it reaches ingestion.
 */
async function sentWithCopy() {
  const h = await harness({ operatorEmail: "ops@private.example" });
  h.mail.reportsMessageId = false;
  await seedApp(h, "orbit");
  const threadId = expectOk<{ threadId: string }>(
    (await h.support.ingestInboundEmail(
      {
        from: "taro@corp.example",
        subject: "ログインできません",
        bodyText: "入れません",
        messageId: "<q1@corp.example>",
        appSlug: "orbit",
      },
      mailActor,
    )) as never,
  ).threadId;
  expectOk(
    (await h.reply.send(
      { threadId, bodyText: "確認します", idempotencyKey: crypto.randomUUID() },
      admin,
      { ccSelf: true },
    )) as never,
  );
  const reply = h.mail.sent[0];
  if (!reply?.messageId || !reply.copyId) throw new Error("no copy marks");
  return { h, reply: { ...reply, messageId: reply.messageId, copyId: reply.copyId } };
}

const ask = (body: unknown, env: Record<string, unknown> = {}) =>
  new AdminCore(createExecutionContext(), {
    ...testEnv,
    NOTIFICATION_EMAIL: "ops@private.example",
    ...env,
  } as never).fetch(
    new Request(`${INTERNAL_ORIGIN}/internal/mail-ingress/self-copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

it("tells mail-ingress a copy from where to forward it, and nothing else is one", async () => {
  const { reply } = await sentWithCopy();
  const yes = await ask({
    projectSlug: "orbit",
    from: "support@example.com",
    messageId: "<rewritten@provider.example>",
    copyId: reply.copyId,
  });
  expect(await yes.json()).toEqual({ selfCopy: true, forwardTo: "ops@private.example" });
  for (const body of [
    // Somebody else naming the same message.
    { projectSlug: "orbit", from: "taro@corp.example", copyId: reply.copyId },
    // Our address, but no message of ours.
    { projectSlug: "orbit", from: "support@example.com", messageId: "<other@example.com>" },
  ])
    expect(await (await ask(body)).json()).toEqual({ selfCopy: false });
});

it("drops a copy that reaches ingestion, by our header when the Message-ID was replaced", async () => {
  const { h, reply } = await sentWithCopy();
  const raw = new TextEncoder().encode(
    [
      "From: Example Support <support@example.com>",
      "To: taro@corp.example",
      "Cc: support@example.com",
      `Subject: ${reply.subject}`,
      "Message-ID: <rewritten@provider.example>",
      `X-Inquiry-Copy: ${reply.copyId}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "確認します",
    ].join("\r\n"),
  );
  const before = await h.db.prepare("SELECT count(*) AS n FROM support_messages").first();
  let inbound!: InboundJobs;
  const jobs = new DeliveryJobs(h.db, (row) => inbound.process(row));
  inbound = new InboundJobs(testEnv, jobs, h.support, new SupportRepository(h.db));
  const response = await inbound.store(
    new Request(`${INTERNAL_ORIGIN}/internal/mail-ingress/raw`, {
      method: "PUT",
      headers: { "X-Mail-To": "support@example.com", "X-Mail-Project": "orbit" },
      body: raw,
    }),
  );
  const { jobId } = (await response.json()) as { jobId: string };
  await jobs.run(jobId);
  expect(await h.db.prepare("SELECT count(*) AS n FROM support_messages").first()).toEqual(before);
  expect(
    (await h.db.prepare("SELECT state FROM delivery_jobs WHERE id=?").bind(jobId).first())?.state,
  ).toBe("completed");
});
