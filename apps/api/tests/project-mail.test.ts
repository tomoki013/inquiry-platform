import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { Intake } from "../src/intake";
import { projectMailResolver } from "../src/project-mail";
import { admin, expectOk, FakeMailProvider, harness, seedApp } from "./harness";

describe("project-owned mail delivery", () => {
  it("uses the dedicated credential and logo, without a read permission", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ id: "d56f4e72-18ce-4c0f-8e24-0b1a9a7dd234" }),
    ) as unknown as typeof fetch;
    const fallback = new FakeMailProvider();
    const resolve = projectMailResolver(
      {
        orbit: {
          apiKeyBinding: "MAIL_API_KEY_ORBIT",
          logo: { url: "https://orbit.example/logo.png", alt: "Orbit" },
        },
      },
      { MAIL_API_KEY_ORBIT: "test-project-key" },
      fallback,
      fetcher,
    );
    const project = resolve("orbit");
    await project.mail.sendSupportReply({
      from: "support@orbit.example",
      to: "customer@example.com",
      subject: "Re: Help",
      text: "Reply\n\nOrbit",
      signatureText: "Orbit",
      idempotencyKey: "send-1",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = vi.mocked(fetcher).mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-project-key");
    const body = JSON.parse(String(init?.body));
    expect(body.html).toContain("https://orbit.example/logo.png");
    expect(fallback.sent).toHaveLength(0);
    expect(resolve("other").mail).toBe(fallback);
    expect(resolve(undefined).mail).toBe(fallback);
  });

  it("refuses a missing project credential instead of sending with the fallback", async () => {
    const fallback = new FakeMailProvider();
    const resolve = projectMailResolver(
      { orbit: { apiKeyBinding: "MAIL_API_KEY_ORBIT" } },
      {},
      fallback,
    );
    expect(resolve("orbit").mail.configured).toBe(false);
    expect(resolve("orbit").defaultSignature).toBe("");
    expect(resolve("other").mail.configured).toBe(true);
    const invalid = projectMailResolver(
      { orbit: { apiKeyBinding: "HASH_PEPPER" } },
      { HASH_PEPPER: "secret" },
      fallback,
    );
    expect(invalid("orbit").mail.configured).toBe(false);
  });

  it("routes a ticket's reply and alert through its own provider and signature", async () => {
    const own = new FakeMailProvider();
    const h = await harness({
      notifyEmail: "operator@example.com",
      delivery: (id) =>
        id
          ? {
              mail: own,
              defaultSignature: "Orbit Support\nhttps://orbit.example",
              supportUrl: "https://orbit.example/contact",
            }
          : { mail: new FakeMailProvider(false) },
    });
    const appId = await seedApp(h);
    await h.db
      .prepare(`INSERT INTO app_mail_settings
      (app_id,signature_text,support_email,from_name,noreply_email,notification_email,updated_at)
      VALUES (?, '', 'support@orbit.example', 'Orbit', 'noreply@orbit.example', 'ops@orbit.example', ?)`)
      .bind(appId, new Date().toISOString())
      .run();
    const thread = expectOk<{ id: string }>(
      (await h.support.createThread(
        {
          appSlug: "orbit",
          source: "web_form",
          requesterEmail: "customer@example.com",
          subject: "Help",
          bodyText: "Question",
          providerMessageId: "form-project-mail",
        },
        admin,
      )) as never,
    );
    await h.settled();
    const template = expectOk<{ id: string }>(
      (await h.reply.createTemplate(
        {
          key: "project_link",
          name: "Project link",
          category: "general",
          body: "Visit {{supportUrl}}",
          includeSignature: true,
          isActive: true,
          sortOrder: 0,
        },
        admin,
      )) as never,
    );
    expect(
      await h.reply.applyTemplate({ threadId: thread.id, templateId: template.id }),
    ).toMatchObject({
      ok: true,
      value: { bodyText: "Visit https://orbit.example/contact" },
    });
    expect(own.sent[0]?.from).toBe("Orbit <noreply@orbit.example>");
    expect(own.sent[0]?.to).toBe("ops@orbit.example");
    const reply = await h.reply.send(
      { threadId: thread.id, bodyText: "Answer", idempotencyKey: "project-send-1" },
      admin,
    );
    expect(reply.ok).toBe(true);
    expect(own.sent.at(-1)?.from).toBe("Orbit <support@orbit.example>");
    expect(own.sent.at(-1)?.text).toContain("Orbit Support\nhttps://orbit.example");
    expect(own.sent.at(-1)?.text).not.toContain("Example Support");
    expect(h.mail.sent).toHaveLength(0);
    expect(h.reply.mailConfiguredForApp(appId)).toBe(true);
  });

  it("preserves the draft when a dedicated key is missing", async () => {
    const h = await harness({ delivery: () => ({ mail: new FakeMailProvider(false) }) });
    await seedApp(h);
    const thread = expectOk<{ id: string }>(
      (await h.support.createThread(
        {
          appSlug: "orbit",
          source: "web_form",
          requesterEmail: "customer@example.com",
          subject: "Help",
          bodyText: "Question",
          providerMessageId: "form-missing-key",
        },
        admin,
      )) as never,
    );
    await h.reply.saveDraft({ threadId: thread.id, bodyText: "Unsaved reply" });
    const reply = await h.reply.send(
      { threadId: thread.id, bodyText: "Answer", idempotencyKey: "missing-send-1" },
      admin,
    );
    expect(reply).toMatchObject({ ok: false, error: { code: "MAIL_ERROR" } });
    expect(await h.reply.getDraft(thread.id)).toMatchObject({
      ok: true,
      value: { bodyText: "Unsaved reply" },
    });
    expect(h.mail.sent).toHaveLength(0);
  });
});

describe("scoped provider receipt ingestion", () => {
  it("records only the granted project's outbound id and keeps retries idempotent", async () => {
    const h = await harness();
    const appId = await seedApp(h);
    const thread = expectOk<{ id: string }>(
      (await h.support.createThread(
        {
          appSlug: "orbit",
          source: "web_form",
          requesterEmail: "customer@example.com",
          subject: "Help",
          bodyText: "Question",
          providerMessageId: "form-receipt",
        },
        admin,
      )) as never,
    );
    await h.reply.send(
      { threadId: thread.id, bodyText: "Answer", idempotencyKey: "receipt-send-1" },
      admin,
    );
    const transportId = "d56f4e72-18ce-4c0f-8e24-0b1a9a7dd234";
    await h.db
      .prepare(
        "UPDATE support_messages SET transport_id=?,provider_message_id=NULL WHERE thread_id=? AND direction='outbound'",
      )
      .bind(transportId, thread.id)
      .run();
    const ctx = createExecutionContext();
    Object.defineProperty(ctx, "props", { value: { caller: "orbit-api", projects: ["orbit"] } });
    const intake = new Intake(ctx, { ...h, DB: h.db } as never);
    const receipt = (project = "orbit", messageId = "<sent@orbit.example>") =>
      intake.fetch(
        new Request(`https://internal/internal/projects/${project}/mail-receipts`, {
          method: "POST",
          body: JSON.stringify({ transportId, messageId }),
        }),
      );
    expect((await receipt("other")).status).toBe(403);
    expect((await receipt()).status).toBe(200);
    expect((await receipt()).status).toBe(200);
    expect((await receipt("orbit", "<different@orbit.example>")).status).toBe(409);
    const row = await h.db
      .prepare(`SELECT m.provider_message_id FROM support_messages m JOIN support_threads t ON t.id=m.thread_id
      WHERE t.app_id=? AND m.transport_id=?`)
      .bind(appId, transportId)
      .first();
    expect(row?.provider_message_id).toBe("<sent@orbit.example>");
    await h.db.prepare("UPDATE support_threads SET app_id=NULL WHERE id=?").bind(thread.id).run();
    expect((await receipt()).status).toBe(404);
  });
});
