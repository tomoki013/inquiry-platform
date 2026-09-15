import type { CreateReportResult, ReportDetail } from "@tomokichi/admin-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, appActor, expectOk, type Harness, harness, seedApp } from "./harness";

let h: Harness;

const report = (overrides: Record<string, unknown> = {}) => ({
  appSlug: "remeet",
  externalReportId: "11111111-1111-4111-8111-111111111111",
  contentType: "waitingMemory",
  reasonCode: "harassment",
  contentExternalId: "content-1",
  contextExternalId: "reunion-1",
  reporterRefHash: "reporter-raw-id",
  authorRefHash: "author-raw-id",
  snapshotText: "報告された本文",
  detail: "通報者のコメント",
  ...overrides,
});

beforeEach(async () => {
  h = await harness();
  await seedApp(h);
});

describe("createReport", () => {
  it("stores a report against a known app", async () => {
    const created = expectOk<CreateReportResult>(
      (await h.reports.create(report(), appActor)) as never,
    );
    expect(created.duplicate).toBe(false);

    const detail = expectOk<ReportDetail>((await h.reports.detail(created.reportId)) as never);
    expect(detail.status).toBe("open");
    expect(detail.appSlug).toBe("remeet");
    expect(detail.snapshotText).toBe("報告された本文");
    expect(detail.events.map((event) => event.eventType)).toEqual(["created"]);
  });

  it("pseudonymises the reporting app's ids rather than storing them", async () => {
    const created = expectOk<CreateReportResult>(
      (await h.reports.create(report(), appActor)) as never,
    );
    const detail = expectOk<ReportDetail>((await h.reports.detail(created.reportId)) as never);

    // The raw ids the app sent must not be findable in this database.
    expect(detail.reporterRefHash).not.toBe("reporter-raw-id");
    expect(detail.authorRefHash).not.toBe("author-raw-id");
    expect(detail.reporterRefHash).toMatch(/^[0-9a-f]{64}$/);
    // Stable, so "the same author again" is still answerable.
    const second = expectOk<CreateReportResult>(
      (await h.reports.create(
        report({ externalReportId: "22222222-2222-4222-8222-222222222222" }),
        appActor,
      )) as never,
    );
    const secondDetail = expectOk<ReportDetail>((await h.reports.detail(second.reportId)) as never);
    expect(secondDetail.authorRefHash).toBe(detail.authorRefHash);
  });

  it("answers a retried report with the first one, not an error", async () => {
    const first = expectOk<CreateReportResult>(
      (await h.reports.create(report(), appActor)) as never,
    );
    const again = expectOk<CreateReportResult>(
      (await h.reports.create(report(), appActor)) as never,
    );

    expect(again.duplicate).toBe(true);
    expect(again.reportId).toBe(first.reportId);

    const listed = expectOk<{ total: number }>((await h.reports.list({})) as never);
    expect(listed.total).toBe(1);
  });

  it("refuses a report for an app that is not registered", async () => {
    const result = await h.reports.create(report({ appSlug: "nope" }), appActor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("refuses a snapshot longer than the limit", async () => {
    const result = await h.reports.create(report({ snapshotText: "x".repeat(9000) }), appActor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("listReports", () => {
  beforeEach(async () => {
    await h.reports.create(report(), appActor);
    await h.reports.create(
      report({
        externalReportId: "33333333-3333-4333-8333-333333333333",
        reasonCode: "spam",
        contentType: "wish",
      }),
      appActor,
    );
  });

  it("filters by reason and content type", async () => {
    const byReason = expectOk<{ total: number }>(
      (await h.reports.list({ reasonCode: "spam" })) as never,
    );
    expect(byReason.total).toBe(1);
    const byType = expectOk<{ total: number }>(
      (await h.reports.list({ contentType: "waitingMemory" })) as never,
    );
    expect(byType.total).toBe(1);
  });

  it("finds a report by the id an operator pasted out of a mail", async () => {
    const found = expectOk<{ items: { externalReportId: string }[] }>(
      (await h.reports.list({ query: "33333333-3333-4333-8333-333333333333" })) as never,
    );
    expect(found.items).toHaveLength(1);
  });

  /**
   * Every filter goes through a bound parameter. This is here so that a future
   * refactor to string concatenation fails loudly rather than quietly.
   */
  it("treats a SQL payload as a value, not as SQL", async () => {
    const injected = expectOk<{ total: number }>(
      (await h.reports.list({ query: "' OR 1=1 --" })) as never,
    );
    expect(injected.total).toBe(0);

    const stillThere = expectOk<{ total: number }>((await h.reports.list({})) as never);
    expect(stillThere.total).toBe(2);
  });
});

describe("status transitions", () => {
  let reportId: string;

  beforeEach(async () => {
    reportId = expectOk<CreateReportResult>(
      (await h.reports.create(report(), appActor)) as never,
    ).reportId;
  });

  it("requires a signed content decision instead of merely marking Remeet actioned or closed", async () => {
    expect((await h.reports.changeStatus({ reportId, to: "closed" }, admin)).ok).toBe(false);
    expect((await h.reports.changeStatus({ reportId, to: "reviewing" }, admin)).ok).toBe(true);
    expect((await h.reports.changeStatus({ reportId, to: "actioned" }, admin)).ok).toBe(false);
  });

  it("refuses a move that would skip review", async () => {
    const result = await h.reports.changeStatus({ reportId, to: "actioned" }, admin);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_STATUS_TRANSITION");

    // And nothing was written: the update, the event and the audit row share a
    // batch, so a refused move leaves no trace of a half-applied one.
    const detail = expectOk<ReportDetail>((await h.reports.detail(reportId)) as never);
    expect(detail.status).toBe("open");
    expect(detail.events).toHaveLength(1);
  });

  it("refuses a move to the status it is already in", async () => {
    const result = await h.reports.changeStatus({ reportId, to: "open" }, admin);
    expect(result.ok).toBe(false);
  });

  it("records a reopen as its own event type", async () => {
    await h.db.prepare("UPDATE reports SET status = 'closed' WHERE id = ?").bind(reportId).run();
    await h.reports.changeStatus({ reportId, to: "reviewing" }, admin);
    const detail = expectOk<ReportDetail>((await h.reports.detail(reportId)) as never);
    expect(detail.events.at(-1)?.eventType).toBe("reopened");
    // Reopening clears the resolution timestamp — "when was this finished" must
    // not answer about something that is open again.
    expect(detail.resolvedAt).toBeUndefined();
  });

  it("keeps notes and resolutions in the timeline", async () => {
    await h.reports.addNote({ reportId, note: "確認した" }, admin);
    await h.reports.updateResolution(
      { reportId, resolutionCode: "content_hidden", resolutionNote: "非表示にした" },
      admin,
    );
    const detail = expectOk<ReportDetail>((await h.reports.detail(reportId)) as never);
    expect(detail.resolutionCode).toBe("content_hidden");
    expect(detail.events.map((event) => event.eventType)).toContain("note_added");
    expect(detail.events.map((event) => event.eventType)).toContain("resolution_updated");
  });
});

describe("audit", () => {
  it("records the operator's moves without the words they typed", async () => {
    const reportId = expectOk<CreateReportResult>(
      (await h.reports.create(report(), appActor)) as never,
    ).reportId;
    await h.reports.addNote({ reportId, note: "極めて秘密のメモ" }, admin);

    const entries = await h.audit.list({
      targetType: "report",
      targetId: reportId,
      limit: 50,
      offset: 0,
    });
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain("report.created");
    expect(actions).toContain("report.note_added");
    expect(JSON.stringify(entries)).not.toContain("極めて秘密のメモ");
  });
});

describe("report email", () => {
  it("sends a receipt once, with a signature, and links future replies", async () => {
    const input = report({ reporterEmail: "reporter@example.com" });
    const created = await h.reports.create(input, appActor);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await h.reports.create(input, appActor);
    expect(h.mail.sendCount).toBe(1);
    expect(h.mail.sent[0]?.to).toBe("reporter@example.com");
    expect(h.mail.sent[0]?.subject).toBe(
      `[remeet] 通報の受付・対応について [通報ID:${input.externalReportId}]`,
    );
    expect(h.mail.sent[0]?.text).toContain("髙木友喜 / Tomoki Takagi");
    expect(h.mail.sent[0]?.text).not.toContain("報告された本文");
    const detail = await h.reports.detail(created.value.reportId);
    if (!detail.ok) throw new Error("missing report");
    const inbound = await h.support.ingestInboundEmail(
      {
        from: "reporter@example.com",
        subject: "Re: 通報",
        bodyText: "追加の情報",
        messageId: "<reply@example.com>",
        inReplyTo: "<sent-1@test>",
      },
      { type: "email" },
    );
    expect(inbound.ok && inbound.value.threadId).toBe(detail.value.supportThreadId);
    const reply = await h.reply.send(
      {
        threadId: detail.value.supportThreadId,
        bodyText: "確認しました",
        idempotencyKey: "report-response",
      },
      admin,
    );
    expect(reply.ok).toBe(true);
    expect(h.mail.sent[1]?.subject).toBe(
      `Re: [remeet] 通報の受付・対応について [通報ID:${input.externalReportId}]`,
    );
    expect(h.mail.sent[1]?.inReplyTo).toBe("<reply@example.com>");
    expect(h.mail.sent[1]?.text).toContain(`受付ID: ${input.externalReportId}`);
  });
  it("accepts reports without an address and never sends a receipt", async () => {
    expect((await h.reports.create(report(), appActor)).ok).toBe(true);
    await h.reports.retryReceipts();
    expect(h.mail.sendCount).toBe(0);
  });
  it("retains the report when mail fails and retries the receipt", async () => {
    h.mail.failNext = true;
    const created = await h.reports.create(
      report({ reporterEmail: "reporter@example.com" }),
      appActor,
    );
    expect(created.ok).toBe(true);
    expect(h.mail.sendCount).toBe(0);
    await h.reports.retryReceipts();
    await h.reports.retryReceipts();
    expect(h.mail.sendCount).toBe(1);
  });
});

describe("moderation decisions", () => {
  async function setup() {
    let revision = 2;
    let fails = false;
    h = await harness({
      moderation: {
        prepare: async (input) => ({
          id: crypto.randomUUID(),
          payload: JSON.stringify(input),
          keyID: "test",
          decision: input.decision,
        }),
        complete: async () => {
          if (fails) throw new Error("publish failed");
          return { revision };
        },
      },
    });
    await seedApp(h);
    const result = await h.reports.create(report(), appActor);
    if (!result.ok) throw new Error("create failed");
    return {
      id: result.value.reportId,
      setRevision: (value: number) => {
        revision = value;
      },
      setFailure: () => {
        fails = true;
      },
    };
  }
  it("binds the operation to its report and records a published dismissal", async () => {
    const { id } = await setup();
    const proposal = await h.reports.prepareDecision({ reportId: id, decision: "dismiss" }, admin);
    if (!proposal.ok) throw new Error("prepare failed");
    expect(JSON.parse(proposal.value.payload).contentId).toBe("content-1");
    expect(
      (
        await h.reports.completeDecision(
          { reportId: "wrong", operationId: proposal.value.id, envelope: "signed" },
          admin,
        )
      ).ok,
    ).toBe(false);
    const result = await h.reports.completeDecision(
      { reportId: id, operationId: proposal.value.id, envelope: "signed" },
      admin,
    );
    expect(result.ok && result.value.status).toBe("closed");
    expect(result.ok && result.value.resolutionCode).toBe("no_action");
  });
  it("leaves the report open when publishing fails", async () => {
    const setupResult = await setup();
    const proposal = await h.reports.prepareDecision(
      { reportId: setupResult.id, decision: "delete" },
      admin,
    );
    if (!proposal.ok) throw new Error("prepare failed");
    setupResult.setFailure();
    expect(
      (
        await h.reports.completeDecision(
          { reportId: setupResult.id, operationId: proposal.value.id, envelope: "signed" },
          admin,
        )
      ).ok,
    ).toBe(false);
    const detail = await h.reports.detail(setupResult.id);
    expect(detail.ok && detail.value.status).toBe("open");
  });
  it("does not overwrite a newer decision when an earlier RPC completes late", async () => {
    const { id, setRevision } = await setup();
    const older = await h.reports.prepareDecision({ reportId: id, decision: "dismiss" }, admin);
    const newer = await h.reports.prepareDecision({ reportId: id, decision: "delete" }, admin);
    if (!older.ok || !newer.ok) throw new Error("prepare failed");
    await h.reports.completeDecision(
      { reportId: id, operationId: newer.value.id, envelope: "new" },
      admin,
    );
    setRevision(1);
    const result = await h.reports.completeDecision(
      { reportId: id, operationId: older.value.id, envelope: "old" },
      admin,
    );
    expect(result.ok && result.value.status).toBe("actioned");
    expect(result.ok && result.value.resolutionCode).toBe("content_deleted");
  });
});

describe("report reply correlation without provider headers", () => {
  async function create(
    email = "reporter@example.com",
    externalReportId = "11111111-1111-4111-8111-111111111111",
  ) {
    const result = await h.reports.create(
      report({ reporterEmail: email, externalReportId }),
      appActor,
    );
    if (!result.ok) throw new Error("report failed");
    const detail = await h.reports.detail(result.value.reportId);
    if (!detail.ok) throw new Error("missing report");
    return detail.value.supportThreadId!;
  }
  it("uses the report ID and sender, even without In-Reply-To and References", async () => {
    const first = await create();
    await create("reporter@example.com", "22222222-2222-4222-8222-222222222222");
    const result = await h.support.ingestInboundEmail(
      {
        from: "REPORTER@example.com",
        subject: `Re: ${h.mail.sent[0]!.subject}`,
        bodyText: "追記です",
        messageId: "<report-followup@example.com>",
      },
      { type: "email" },
    );
    expect(result.ok && result.value.threadId).toBe(first);
    expect(result.ok && result.value.newThread).toBe(false);
  });
  it("never merges a different sender by a copied report ID", async () => {
    const first = await create();
    const result = await h.support.ingestInboundEmail(
      {
        from: "other@example.com",
        subject: `Re: ${h.mail.sent[0]!.subject}`,
        bodyText: "追記です",
      },
      { type: "email" },
    );
    expect(result.ok && result.value.threadId).not.toBe(first);
    expect(result.ok && result.value.newThread).toBe(true);
  });
  it("recognizes earlier receipts by their quoted ID, subject, and sender", async () => {
    const first = await create();
    await h.db
      .prepare("UPDATE support_threads SET subject=? WHERE id=?")
      .bind("[Remeet] 通報の受付・対応について", first)
      .run();
    const result = await h.support.ingestInboundEmail(
      {
        from: "reporter@example.com",
        subject: "Re: [Remeet] 通報の受付・対応について",
        bodyText:
          "追記です\n> 受付ID: 11111111-1111-4111-8111-111111111111\n> ありがとうございます",
      },
      { type: "email" },
    );
    expect(result.ok && result.value.threadId).toBe(first);
  });
  it("does not guess when multiple report IDs are quoted", async () => {
    const first = await create();
    const result = await h.support.ingestInboundEmail(
      {
        from: "reporter@example.com",
        subject:
          "Re: [通報ID:11111111-1111-4111-8111-111111111111] [通報ID:22222222-2222-4222-8222-222222222222]",
        bodyText: "どちらでしょう",
      },
      { type: "email" },
    );
    expect(result.ok && result.value.threadId).not.toBe(first);
  });
});
