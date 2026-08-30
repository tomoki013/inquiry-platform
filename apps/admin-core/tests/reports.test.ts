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

  it("walks open → reviewing → actioned → closed and records each move", async () => {
    for (const to of ["reviewing", "actioned", "closed"] as const) {
      const moved = await h.reports.changeStatus({ reportId, to }, admin);
      expect(moved.ok).toBe(true);
    }
    const detail = expectOk<ReportDetail>((await h.reports.detail(reportId)) as never);
    expect(detail.status).toBe("closed");
    expect(detail.events.map((event) => event.eventType)).toEqual([
      "created",
      "status_changed",
      "status_changed",
      "status_changed",
    ]);
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
    await h.reports.changeStatus({ reportId, to: "closed" }, admin);
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
