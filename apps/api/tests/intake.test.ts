import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { IntakeProps } from "@inquiry-platform/core";
import { createInquiryClient, type IntakeBinding } from "@inquiry-platform/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminCore } from "../src/index";
import { Intake } from "../src/intake";
import { harness, seedApp, testEnv } from "./harness";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** An `Intake` as a project's binding sees it: `props` fixed by the binding. */
function bind(props: IntakeProps | Record<string, unknown> | undefined, env: object = testEnv) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: props });
  const intake = new Intake(ctx, env as never);
  // What a Service Binding does on the way in: RPC methods as they are, and
  // `fetch(url, init)` delivered to the entrypoint as one `Request`.
  const binding = {
    submitContact: intake.submitContact.bind(intake),
    submitReport: intake.submitReport.bind(intake),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => intake.fetch(new Request(input, init)),
  } as IntakeBinding;
  return { intake, ctx, client: createInquiryClient(binding) };
}

const projectApi: IntakeProps = {
  caller: "project-api",
  projects: ["orbit", "prism"],
  allowUnassigned: true,
};
const other: IntakeProps = { caller: "other-api", projects: ["margin"] };

const contact = (overrides: Record<string, unknown> = {}) => ({
  projectSlug: "prism",
  idempotencyKey: "req-1",
  subject: "[不具合] req-1",
  message: "地図が開きません",
  email: "someone@example.com",
  channel: "app" as const,
  ...overrides,
});

const report = (overrides: Record<string, unknown> = {}) => ({
  projectSlug: "orbit",
  externalReportId: "11111111-1111-4111-8111-111111111111",
  targetType: "waitingMemory",
  targetId: "content-1",
  targetOwnerId: "author-1",
  contextId: "reunion-1",
  reason: "harassment",
  reporterId: "reporter-1",
  ...overrides,
});

beforeEach(async () => {
  const h = await harness();
  await seedApp(h, "orbit");
  await seedApp(h, "prism");
  await seedApp(h, "margin");
});

describe("Intake: contacts", () => {
  it("creates a ticket and answers in the public vocabulary", async () => {
    const { client, ctx } = bind(projectApi);
    const result = await client.createContact(contact());
    await waitOnExecutionContext(ctx);
    expect(result).toMatchObject({ ok: true, value: { status: "OPEN", duplicate: false } });
    expect(result.ok && result.value.ticketNumber).toBeTruthy();
    // The receipt is a reference number, never the message back.
    expect(JSON.stringify(result)).not.toContain("地図が開きません");
  });

  it("returns the first ticket for a retried key", async () => {
    const { client } = bind(projectApi);
    const first = await client.createContact(contact());
    const again = await client.createContact(contact());
    expect(again).toMatchObject({ ok: true, value: { duplicate: true } });
    expect(again.ok && first.ok && again.value.ticketNumber).toBe(
      first.ok && first.value.ticketNumber,
    );
  });

  it("accepts an unassigned contact only from a binding that allows it", async () => {
    const unassigned = contact({ projectSlug: undefined, idempotencyKey: "req-2" });
    expect((await bind(projectApi).client.createContact(unassigned)).ok).toBe(true);
    const refused = await bind({ ...projectApi, allowUnassigned: false }).client.createContact(
      contact({ projectSlug: undefined, idempotencyKey: "req-3" }),
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});

describe("Intake: the receipt for a contact", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mails the person who wrote, once, through the deployment's provider", async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: `resend-${sent.length}` }));
    });
    const { client, ctx } = bind(projectApi, { ...testEnv, MAIL_API_KEY: "test-key" });
    const result = await client.createContact(contact({ idempotencyKey: "receipt-1" }));
    await client.createContact(contact({ idempotencyKey: "receipt-1" }));
    await waitOnExecutionContext(ctx);
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(["someone@example.com"]);
    expect(String(sent[0]?.text)).toContain(
      `受付番号: ${result.ok ? result.value.ticketNumber : ""}`,
    );
    expect(sent[0]?.headers).toMatchObject({ "Auto-Submitted": "auto-replied" });
  });
});

describe("Intake: features per Project", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function id(slug: string) {
    const found = await testEnv.DB.prepare("SELECT id FROM apps WHERE slug=?")
      .bind(slug)
      .first<string>("id");
    if (!found) throw new Error(`Missing fixture ${slug}`);
    return found;
  }

  it("preserves a branded receipt at one site and disables automatic mail and notification jobs at another", async () => {
    const prism = await id("prism");
    const margin = await id("margin");
    const sent: Array<{ text: string; from: string }> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: `sent-${sent.length}` }));
    });
    const { client, ctx } = bind(
      { ...projectApi, projects: ["prism", "margin"] },
      {
        ...testEnv,
        MAIL_API_KEY_PRISM: "test-key",
        PROJECT_MAIL_PROVIDERS: {
          [prism]: {
            apiKeyBinding: "MAIL_API_KEY_PRISM",
            supportEmail: "prism@example.com",
            defaultSignature: "Prism team",
          },
        },
        PROJECT_FEATURES: {
          [prism]: {
            inquiry: { receipt: true, signature: true },
          },
          [margin]: { inquiry: { receipt: false, notifyEmail: false, notifyPush: false } },
        },
      },
    );
    expect((await client.createContact(contact())).ok).toBe(true);
    expect(
      (await client.createContact(contact({ projectSlug: "margin", idempotencyKey: "req-margin" })))
        .ok,
    ).toBe(true);
    await waitOnExecutionContext(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Prism team");
    expect(sent[0]?.from).toContain("prism@example.com");
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM delivery_jobs").first("n")).toBe(0);
  });

  it("opens an independent report ticket without an inquiry, mail conversation or notification job", async () => {
    const orbit = await id("orbit");
    const { client, ctx } = bind(projectApi, {
      ...testEnv,
      PRIVATE_FILES: undefined,
      PROJECT_FEATURES: {
        [orbit]: {
          inquiry: { enabled: false },
          report: { reply: false, receipt: false, notifyEmail: false, notifyPush: false },
        },
      },
    });
    expect(await client.createContact(contact({ projectSlug: "orbit" }))).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const first = await client.createReport(report({ reporterEmail: "reporter@example.com" }));
    expect(first).toMatchObject({
      ok: true,
      value: { ticketNumber: expect.stringMatching(/^TK-/) },
    });
    await waitOnExecutionContext(ctx);
    expect(await testEnv.DB.prepare("SELECT type, status FROM tickets").first()).toEqual({
      type: "REPORT",
      status: "NEW",
    });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM support_threads").first("n")).toBe(
      0,
    );
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM delivery_jobs").first("n")).toBe(0);
  });

  it("creates a report conversation on the first reply and keeps the report's ticket and decision", async () => {
    const orbit = await id("orbit");
    const configured = {
      ...testEnv,
      MAIL_API_KEY: "test-key",
      PROJECT_FEATURES: {
        [orbit]: {
          inquiry: { enabled: false },
          report: {
            reply: true,
            receipt: false,
            notifyEmail: false,
            notifyPush: false,
          },
        },
      },
    };
    const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "provider-reply" }),
    );
    vi.stubGlobal("fetch", send);
    const { client } = bind(projectApi, configured);
    const created = await client.createReport(report({ reporterEmail: "reporter@example.com" }));
    if (!created.ok) throw new Error(created.error.message);
    const { reportId, ticketNumber } = created.value;
    const core = new AdminCore(createExecutionContext(), configured);
    const actor = { type: "admin", id: "reviewer" } as const;
    expect((await core.changeReportStatus({ reportId, to: "reviewing" }, actor)).ok).toBe(true);
    expect((await core.changeReportStatus({ reportId, to: "actioned" }, actor)).ok).toBe(true);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM support_threads").first("n")).toBe(
      0,
    );
    const sent = await core.replyToReporter(
      reportId,
      {
        bodyText: "通報を確認しました。",
        idempotencyKey: "report-reply-1",
      },
      actor,
    );
    expect(sent).toMatchObject({ ok: true, value: { reportId } });
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(
      await testEnv.DB.prepare("SELECT ticket_number, type, status FROM tickets").all(),
    ).toMatchObject({
      results: [{ ticket_number: ticketNumber, type: "REPORT", status: "RESOLVED" }],
    });
    expect(await core.getReport(reportId)).toMatchObject({
      ok: true,
      value: { status: "actioned" },
    });
  });

  it("checks Turnstile before saving, rejects token reuse, and returns the committed receipt on retry", async () => {
    const prism = await id("prism");
    let hostname = "other.example.com";
    const siteverify = vi.fn(async () =>
      Response.json({ success: true, hostname, action: "inquiry" }),
    );
    vi.stubGlobal("fetch", siteverify);
    const { client, ctx } = bind(projectApi, {
      ...testEnv,
      TURNSTILE_SECRET_PRISM: "test-key",
      PROJECT_FEATURES: {
        [prism]: {
          inquiry: {
            receipt: false,
            notifyEmail: false,
            notifyPush: false,
            turnstile: {
              secretBinding: "TURNSTILE_SECRET_PRISM",
              hostnames: ["form.example.com"],
              action: "inquiry",
            },
          },
        },
      },
    });
    expect((await client.createContact(contact())).ok).toBe(false);
    expect((await client.createContact(contact({ turnstileToken: "wrong-host" }))).ok).toBe(false);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM tickets").first("n")).toBe(0);
    hostname = "form.example.com";
    const first = await client.createContact(contact({ turnstileToken: "one-time" }));
    expect(first).toMatchObject({ ok: true, value: { duplicate: false } });
    expect(await client.createContact(contact())).toMatchObject({
      ok: true,
      value: { duplicate: true, receiptId: first.ok ? first.value.receiptId : "" },
    });
    expect(await client.createContact(contact({ message: "別の本文" }))).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(
      await client.createContact(contact({ idempotencyKey: "other", turnstileToken: "one-time" })),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(siteverify).toHaveBeenCalledTimes(2);
    await waitOnExecutionContext(ctx);
  });
});

describe("Intake: unregistered projects", () => {
  const granted = { ...projectApi, projects: ["orbit", "prism", "not-registered"] };

  it("rejects a granted but unregistered project even when unassigned intake is allowed", async () => {
    const { client } = bind(granted);
    expect(await client.createContact(contact({ projectSlug: "not-registered" }))).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM support_threads").first("n")).toBe(
      0,
    );
  });

  it("refuses it without writing anything where unassigned is not allowed", async () => {
    const { client } = bind({ ...granted, allowUnassigned: false });
    const contactResult = await client.createContact(contact({ projectSlug: "not-registered" }));
    expect(contactResult).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const reportResult = await client.createReport(report({ projectSlug: "not-registered" }));
    expect(reportResult.ok).toBe(false);
    const counts = await testEnv.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM support_threads) AS threads, (SELECT COUNT(*) FROM reports) AS reports",
    ).first<{ threads: number; reports: number }>();
    expect(counts).toEqual({ threads: 0, reports: 0 });
  });
});

describe("Intake: reports", () => {
  it("maps the target vocabulary and pseudonymises the ids", async () => {
    const { client } = bind(projectApi);
    const result = await client.createReport(report());
    expect(result).toMatchObject({ ok: true, value: { status: "OPEN", duplicate: false } });
    const row = await testEnv.DB.prepare(
      "SELECT content_type, content_external_id, context_external_id, reason_code, author_ref_hash, reporter_ref_hash FROM reports",
    ).first<Record<string, string>>();
    expect(row).toMatchObject({
      content_type: "waitingMemory",
      content_external_id: "content-1",
      context_external_id: "reunion-1",
      reason_code: "harassment",
    });
    expect(row?.author_ref_hash).not.toBe("author-1");
    expect(row?.reporter_ref_hash).not.toBe("reporter-1");
  });

  it("is idempotent on the project's report id", async () => {
    const { client } = bind(projectApi);
    const first = await client.createReport(report());
    const again = await client.createReport(report());
    expect(again).toMatchObject({ ok: true, value: { duplicate: true } });
    expect(again.ok && first.ok && again.value.reportId).toBe(first.ok && first.value.reportId);
  });
});

describe("Intake: the binding decides which projects", () => {
  it("refuses a binding with no or malformed props", async () => {
    for (const props of [undefined, {}, { caller: "x" }, { caller: "x", projects: "orbit" }]) {
      const { client } = bind(props as never);
      expect(await client.createReport(report())).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(await client.createContact(contact())).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
    }
  });

  it("refuses a project the binding was not granted", async () => {
    const { client } = bind(other);
    expect(await client.createReport(report())).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await client.createContact(contact())).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  it("does not hand back another project's report for a reused id", async () => {
    const first = await bind(projectApi).client.createReport(report());
    expect(first.ok).toBe(true);
    const probe = await bind(other).client.createReport(report({ projectSlug: "margin" }));
    expect(probe).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(JSON.stringify(probe)).not.toContain(first.ok ? first.value.reportId : "-");
  });

  it("does not hand back another project's contact for a reused key", async () => {
    expect((await bind(projectApi).client.createContact(contact())).ok).toBe(true);
    const probe = await bind(other).client.createContact(contact({ projectSlug: "margin" }));
    expect(probe).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
});

describe("Intake: evidence", () => {
  it("stores evidence for its own project's report", async () => {
    const { client } = bind(projectApi);
    const created = await client.createReport(report({ evidenceExpected: true }));
    if (!created.ok) throw new Error("create failed");
    const stored = await client.attachReportEvidence(created.value.reportId, {
      bytes: PNG,
      contentType: "image/png",
    });
    expect(stored).toMatchObject({ ok: true, value: { byteSize: PNG.byteLength } });
  });

  it("answers another project's report exactly like a missing one", async () => {
    const created = await bind(projectApi).client.createReport(report());
    if (!created.ok) throw new Error("create failed");
    const { client } = bind(other);
    const foreign = await client.attachReportEvidence(created.value.reportId, {
      bytes: PNG,
      contentType: "image/png",
    });
    const missing = await client.attachReportEvidence("no-such-report", {
      bytes: PNG,
      contentType: "image/png",
    });
    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("offers no reads: downloads and unknown paths are not found", async () => {
    const created = await bind(projectApi).client.createReport(report());
    if (!created.ok) throw new Error("create failed");
    const { intake } = bind(projectApi);
    for (const [method, path] of [
      ["GET", `/internal/reports/${created.value.reportId}/attachments/x`],
      ["GET", `/internal/reports/${created.value.reportId}/attachments`],
      ["PUT", "/internal/support/messages/m1/attachments"],
    ] as const) {
      const response = await intake.fetch(
        new Request(`https://intake.internal${path}`, {
          method,
          body: method === "PUT" ? PNG : undefined,
        }),
      );
      expect(response.status).toBe(404);
    }
  });

  it("offers no platform methods beyond intake", () => {
    const { intake } = bind(projectApi);
    for (const method of ["listTickets", "getTicket", "addTicketNote", "getSupportThread"]) {
      expect((intake as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
  });
});
