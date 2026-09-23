import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { IntakeProps } from "@inquiry-platform/core";
import { createInquiryClient, type IntakeBinding } from "@inquiry-platform/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { Intake } from "../src/intake";
import { harness, seedApp, testEnv } from "./harness";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** An `Intake` as a project's binding sees it: `props` fixed by the binding. */
function bind(props: IntakeProps | Record<string, unknown> | undefined) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: props });
  const intake = new Intake(ctx, testEnv as never);
  // What a Service Binding does on the way in: RPC methods as they are, and
  // `fetch(url, init)` delivered to the entrypoint as one `Request`.
  const binding = {
    submitContact: intake.submitContact.bind(intake),
    submitReport: intake.submitReport.bind(intake),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => intake.fetch(new Request(input, init)),
  } as IntakeBinding;
  return { intake, ctx, client: createInquiryClient(binding) };
}

const studio: IntakeProps = {
  caller: "studio-api",
  projects: ["remeet", "colorvia"],
  allowUnassigned: true,
};
const other: IntakeProps = { caller: "other-api", projects: ["yohaku"] };

const contact = (overrides: Record<string, unknown> = {}) => ({
  projectSlug: "colorvia",
  idempotencyKey: "req-1",
  subject: "[不具合] req-1",
  message: "地図が開きません",
  email: "someone@example.com",
  channel: "app" as const,
  ...overrides,
});

const report = (overrides: Record<string, unknown> = {}) => ({
  projectSlug: "remeet",
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
  await seedApp(h, "remeet");
  await seedApp(h, "colorvia");
  await seedApp(h, "yohaku");
});

describe("Intake: contacts", () => {
  it("creates a ticket and answers in the public vocabulary", async () => {
    const { client, ctx } = bind(studio);
    const result = await client.createContact(contact());
    await waitOnExecutionContext(ctx);
    expect(result).toMatchObject({ ok: true, value: { status: "OPEN", duplicate: false } });
    expect(result.ok && result.value.ticketNumber).toBeTruthy();
    // The receipt is a reference number, never the message back.
    expect(JSON.stringify(result)).not.toContain("地図が開きません");
  });

  it("returns the first ticket for a retried key", async () => {
    const { client } = bind(studio);
    const first = await client.createContact(contact());
    const again = await client.createContact(contact());
    expect(again).toMatchObject({ ok: true, value: { duplicate: true } });
    expect(again.ok && first.ok && again.value.ticketNumber).toBe(
      first.ok && first.value.ticketNumber,
    );
  });

  it("accepts an unassigned contact only from a binding that allows it", async () => {
    const unassigned = contact({ projectSlug: undefined, idempotencyKey: "req-2" });
    expect((await bind(studio).client.createContact(unassigned)).ok).toBe(true);
    const refused = await bind({ ...studio, allowUnassigned: false }).client.createContact(
      contact({ projectSlug: undefined, idempotencyKey: "req-3" }),
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});

describe("Intake: unregistered projects", () => {
  it("refuses a granted but unregistered project without writing anything", async () => {
    const { client } = bind({ ...studio, projects: ["remeet", "colorvia", "not-registered"] });
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
    const { client } = bind(studio);
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
    const { client } = bind(studio);
    const first = await client.createReport(report());
    const again = await client.createReport(report());
    expect(again).toMatchObject({ ok: true, value: { duplicate: true } });
    expect(again.ok && first.ok && again.value.reportId).toBe(first.ok && first.value.reportId);
  });
});

describe("Intake: the binding decides which projects", () => {
  it("refuses a binding with no or malformed props", async () => {
    for (const props of [undefined, {}, { caller: "x" }, { caller: "x", projects: "remeet" }]) {
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
    const first = await bind(studio).client.createReport(report());
    expect(first.ok).toBe(true);
    const probe = await bind(other).client.createReport(report({ projectSlug: "yohaku" }));
    expect(probe).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(JSON.stringify(probe)).not.toContain(first.ok ? first.value.reportId : "-");
  });

  it("does not hand back another project's contact for a reused key", async () => {
    expect((await bind(studio).client.createContact(contact())).ok).toBe(true);
    const probe = await bind(other).client.createContact(contact({ projectSlug: "yohaku" }));
    expect(probe).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
});

describe("Intake: evidence", () => {
  it("stores evidence for its own project's report", async () => {
    const { client } = bind(studio);
    const created = await client.createReport(report({ evidenceExpected: true }));
    if (!created.ok) throw new Error("create failed");
    const stored = await client.attachReportEvidence(created.value.reportId, {
      bytes: PNG,
      contentType: "image/png",
    });
    expect(stored).toMatchObject({ ok: true, value: { byteSize: PNG.byteLength } });
  });

  it("answers another project's report exactly like a missing one", async () => {
    const created = await bind(studio).client.createReport(report());
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
    const created = await bind(studio).client.createReport(report());
    if (!created.ok) throw new Error("create failed");
    const { intake } = bind(studio);
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
    const { intake } = bind(studio);
    for (const method of ["listTickets", "getTicket", "addTicketNote", "getSupportThread"]) {
      expect((intake as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
  });
});
