import type { AppDetail, AppSummary, DashboardSummary } from "@tomokichi/admin-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { admin, appActor, expectOk, type Harness, harness } from "./harness";

let h: Harness;

const app = (overrides: Record<string, unknown> = {}) => ({
  slug: "colorvia",
  name: "Colorvia",
  platform: "ios",
  status: "live",
  bundleId: "io.tmkch.colorvia",
  publicUrl: "https://colorvia.tmkch.io",
  ...overrides,
});

beforeEach(async () => {
  h = await harness();
});

describe("apps", () => {
  it("creates one and reads it back", async () => {
    const created = expectOk<AppDetail>((await h.apps.create(app(), admin)) as never);
    expect(created.slug).toBe("colorvia");
    expect(created.bundleId).toBe("io.tmkch.colorvia");
    expect(created.openReports).toBe(0);
  });

  it("refuses a duplicate slug", async () => {
    await h.apps.create(app(), admin);
    const again = await h.apps.create(app({ name: "別物" }), admin);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("CONFLICT");
  });

  it("refuses a status outside the closed list", async () => {
    const result = await h.apps.create(app({ status: "shipping-soon" }), admin);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a URL that is not https and one carrying a credential", async () => {
    expect((await h.apps.create(app({ publicUrl: "http://colorvia.tmkch.io" }), admin)).ok).toBe(
      false,
    );
    expect(
      (await h.apps.create(app({ publicUrl: "https://a:b@colorvia.tmkch.io" }), admin)).ok,
    ).toBe(false);
  });

  it("updates only the fields that were sent", async () => {
    const created = expectOk<AppDetail>((await h.apps.create(app(), admin)) as never);
    const updated = expectOk<AppDetail>(
      (await h.apps.update(created.id, { status: "paused" }, admin)) as never,
    );
    expect(updated.status).toBe("paused");
    expect(updated.name).toBe("Colorvia");
    expect(updated.bundleId).toBe("io.tmkch.colorvia");
  });

  /**
   * Archive, never delete: reports and threads hold a foreign key here, and an
   * app that was withdrawn still has a moderation history somebody may have to
   * answer for.
   */
  it("archives and restores without losing the row", async () => {
    const created = expectOk<AppDetail>((await h.apps.create(app(), admin)) as never);
    await h.reports.create(
      {
        appSlug: "colorvia",
        externalReportId: "ext-1",
        contentType: "post",
        reasonCode: "spam",
      },
      appActor,
    );

    const archived = expectOk<AppDetail>(
      (await h.apps.setArchived(created.id, true, admin)) as never,
    );
    expect(archived.archivedAt).toBeTruthy();

    const visible = expectOk<AppSummary[]>(
      (await h.apps.list({ includeArchived: false })) as never,
    );
    expect(visible).toHaveLength(0);

    const all = expectOk<AppSummary[]>((await h.apps.list({ includeArchived: true })) as never);
    expect(all).toHaveLength(1);

    // The report is still there and still points at the app.
    const reports = expectOk<{ total: number }>(
      (await h.reports.list({ appId: created.id })) as never,
    );
    expect(reports.total).toBe(1);

    const restored = expectOk<AppDetail>(
      (await h.apps.setArchived(created.id, false, admin)) as never,
    );
    expect(restored.archivedAt).toBeUndefined();
  });

  it("counts what is outstanding per app", async () => {
    const created = expectOk<AppDetail>((await h.apps.create(app(), admin)) as never);
    await h.reports.create(
      { appSlug: "colorvia", externalReportId: "ext-2", contentType: "post", reasonCode: "spam" },
      appActor,
    );
    const summaries = expectOk<AppSummary[]>(
      (await h.apps.list({ includeArchived: false })) as never,
    );
    expect(summaries[0]?.openReports).toBe(1);
    expect(summaries[0]?.id).toBe(created.id);
  });
});

describe("app links", () => {
  it("adds and removes links, and validates the URL", async () => {
    const created = expectOk<AppDetail>((await h.apps.create(app(), admin)) as never);

    const bad = await h.apps.addLink(
      { appId: created.id, type: "brand", label: "x", url: "not a url", sortOrder: 0 },
      admin,
    );
    expect(bad.ok).toBe(false);

    const withLink = expectOk<AppDetail>(
      (await h.apps.addLink(
        {
          appId: created.id,
          type: "app_store",
          label: "App Store",
          url: "https://apps.apple.com/app/id6798378768",
          sortOrder: 0,
        },
        admin,
      )) as never,
    );
    expect(withLink.links).toHaveLength(1);

    const removed = expectOk<AppDetail>(
      (await h.apps.removeLink(withLink.links[0]?.id as string, admin)) as never,
    );
    expect(removed.links).toHaveLength(0);
  });
});

describe("dashboard", () => {
  it("says nothing about support until support exists", async () => {
    const empty = expectOk<DashboardSummary>((await h.dashboard.summary()) as never);
    expect(empty.supportConfigured).toBe(false);

    await h.support.ingestInboundEmail(
      {
        from: "a@example.com",
        subject: "hello",
        bodyText: "hi",
        messageId: "<a@example.com>",
        references: [],
      },
      { type: "email" },
    );

    const withSupport = expectOk<DashboardSummary>((await h.dashboard.summary()) as never);
    expect(withSupport.supportConfigured).toBe(true);
    expect(withSupport.openSupport).toBe(1);
  });

  it("counts open and reviewing reports separately", async () => {
    await h.apps.create(app(), admin);
    const first = await h.reports.create(
      { appSlug: "colorvia", externalReportId: "e1", contentType: "post", reasonCode: "spam" },
      appActor,
    );
    await h.reports.create(
      { appSlug: "colorvia", externalReportId: "e2", contentType: "post", reasonCode: "spam" },
      appActor,
    );
    if (first.ok)
      await h.reports.changeStatus({ reportId: first.value.reportId, to: "reviewing" }, admin);

    const summary = expectOk<DashboardSummary>((await h.dashboard.summary()) as never);
    expect(summary.openReports).toBe(1);
    expect(summary.reviewingReports).toBe(1);
    expect(summary.recentActivity.length).toBeGreaterThan(0);
  });
});

describe("activity", () => {
  it("gathers everything belonging to one app", async () => {
    const created = expectOk<AppDetail>((await h.apps.create(app(), admin)) as never);
    await h.reports.create(
      { appSlug: "colorvia", externalReportId: "e3", contentType: "post", reasonCode: "spam" },
      appActor,
    );

    const activity = await h.audit.list({ appId: created.id, limit: 50, offset: 0 });
    const actions = activity.map((entry) => entry.action);
    expect(actions).toContain("app.created");
    expect(actions).toContain("report.created");
  });
});
