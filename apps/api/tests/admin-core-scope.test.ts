import { createExecutionContext } from "cloudflare:test";
import type { AdminCoreProps } from "@inquiry-platform/core";
import { beforeEach, describe, expect, it } from "vitest";
import AdminCore from "../src/index";
import { admin, appActor, expectOk, type Harness, harness, seedApp, testEnv } from "./harness";

/*
 * What this pins: an AdminCore binding with a `scope` in its props is a console
 * for some of the deployment's services. Lists and counts hold only those
 * services; a record of any other service is indistinguishable from a missing
 * one, for reading and for changing; deployment-wide settings are read-only.
 * A binding without a scope still sees everything.
 */

function core(props: AdminCoreProps | Record<string, unknown> | undefined) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: props });
  return new AdminCore(ctx, testEnv as never);
}

const orbitConsole: AdminCoreProps = { scope: { services: ["orbit", "general"] } };

let h: Harness;
let orbit: string;
let prism: string;

async function thread(appSlug: string | undefined, subject: string) {
  const created = await h.support.createThread(
    { ...(appSlug ? { appSlug } : {}), source: "web_form", subject, bodyText: `本文 ${subject}` },
    appActor,
  );
  return expectOk<{ id: string }>(created as never).id;
}

async function report(appSlug: string, externalReportId: string) {
  const created = await h.reports.create(
    {
      appSlug,
      externalReportId,
      contentType: "post",
      reasonCode: "spam",
      contentExternalId: `content-${externalReportId}`,
      reporterRefHash: "reporter",
      authorRefHash: "author",
      snapshotText: "本文",
    },
    appActor,
  );
  return expectOk<{ reportId: string }>(created as never).reportId;
}

let orbitThread: string;
let prismThread: string;
let generalThread: string;
let orbitReport: string;
let prismReport: string;

beforeEach(async () => {
  h = await harness();
  orbit = await seedApp(h, "orbit");
  prism = await seedApp(h, "prism");
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO services(id,name,slug,is_active) VALUES ('general','General','general',1)",
    ),
    testEnv.DB.prepare(
      "INSERT OR REPLACE INTO platform_settings(key,value) VALUES ('default_service_id','general')",
    ),
  ]);
  orbitThread = await thread("orbit", "orbit の質問");
  prismThread = await thread("prism", "prism の質問");
  generalThread = await thread(undefined, "全般の質問");
  orbitReport = await report("orbit", "11111111-1111-4111-8111-111111111111");
  prismReport = await report("prism", "22222222-2222-4222-8222-222222222222");
  await h.settled();
});

describe("AdminCore scope: lists and counts", () => {
  it("lists only the scope's tickets, threads, reports and apps", async () => {
    const scoped = core(orbitConsole);
    const tickets = expectOk<{ items: { service_id: string }[]; total: number }>(
      (await scoped.listTickets({})) as never,
    );
    expect(new Set(tickets.items.map((t) => t.service_id))).toEqual(new Set([orbit, "general"]));
    expect(tickets.total).toBe(tickets.items.length);

    const threads = expectOk<{ items: { id: string }[]; total: number }>(
      (await scoped.listSupportThreads({})) as never,
    );
    // A report's receipt thread belongs to its app, so it is here too.
    const ids = threads.items.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([orbitThread, generalThread]));
    expect(ids).not.toContain(prismThread);
    expect(threads.total).toBe(ids.length);

    const reports = expectOk<{ items: { id: string }[]; total: number }>(
      (await scoped.listReports({})) as never,
    );
    expect(reports.items.map((r) => r.id)).toEqual([orbitReport]);

    const apps = expectOk<{ id: string }[]>((await scoped.listApps({})) as never);
    expect(apps.map((a) => a.id)).toEqual([orbit]);

    const masters = expectOk<{ services: { id: string }[] }>(
      (await scoped.ticketMasters()) as never,
    );
    expect(masters.services.map((s) => s.id).sort()).toEqual([orbit, "general"].sort());
  });

  it("counts only the scope on both dashboards", async () => {
    const all = expectOk<{ open: number }>((await core(undefined).ticketDashboard()) as never);
    const scoped = expectOk<{ open: number; priorityQueue: { service_id: string }[] }>(
      (await core(orbitConsole).ticketDashboard()) as never,
    );
    expect(scoped.open).toBeLessThan(all.open);
    expect(scoped.priorityQueue.every((t) => [orbit, "general"].includes(t.service_id))).toBe(true);

    const summary = expectOk<{ openReports: number; openSupport: number; apps: { id: string }[] }>(
      (await core(orbitConsole).getDashboard()) as never,
    );
    const everything = expectOk<{ openReports: number; openSupport: number }>(
      (await core(undefined).getDashboard()) as never,
    );
    const threads = expectOk<{ total: number }>(
      (await core(orbitConsole).listSupportThreads({})) as never,
    );
    expect(summary.openReports).toBe(1);
    expect(everything.openReports).toBe(2);
    expect(summary.openSupport).toBe(threads.total);
    expect(summary.openSupport).toBeLessThan(everything.openSupport);
    expect(summary.apps.map((a) => a.id)).toEqual([orbit]);
  });

  it("keeps other services out of the activity feed", async () => {
    const entries = expectOk<{ targetType: string; targetId: string }[]>(
      (await core(orbitConsole).listActivity({ limit: 100 })) as never,
    );
    const targets = entries.map((e) => e.targetId);
    expect(targets).not.toContain(prism);
    expect(targets).not.toContain(prismReport);
    expect(targets).not.toContain(prismThread);
    expect(entries.some((e) => e.targetType === "system")).toBe(false);
  });

  it("leaves an unscoped binding with everything", async () => {
    const apps = expectOk<{ id: string }[]>((await core(undefined).listApps({})) as never);
    expect(apps.map((a) => a.id).sort()).toEqual([orbit, prism].sort());
    const reports = expectOk<{ total: number }>((await core({}).listReports({})) as never);
    expect(reports.total).toBe(2);
  });

  it("fails closed on a malformed scope", async () => {
    const broken = core({ scope: { services: "orbit" } });
    const apps = expectOk<unknown[]>((await broken.listApps({})) as never);
    expect(apps).toEqual([]);
    const tickets = expectOk<{ total: number }>((await broken.listTickets({})) as never);
    expect(tickets.total).toBe(0);
  });
});

describe("AdminCore scope: one record", () => {
  it("answers NOT_FOUND for another service's ticket, thread, report and app", async () => {
    const scoped = core(orbitConsole);
    const notFound = { ok: false, error: { code: "NOT_FOUND" } };
    expect(await scoped.getTicket(prismThread)).toMatchObject(notFound);
    expect(await scoped.getSupportThread(prismThread)).toMatchObject(notFound);
    expect(await scoped.getReport(prismReport)).toMatchObject(notFound);
    expect(await scoped.getApp(prism)).toMatchObject(notFound);
    expect(await scoped.getSupportDraft(prismThread)).toMatchObject(notFound);

    expect(await scoped.getTicket(orbitThread)).toMatchObject({ ok: true });
    expect(await scoped.getSupportThread(generalThread)).toMatchObject({ ok: true });
    expect(await scoped.getReport(orbitReport)).toMatchObject({ ok: true });
  });

  it("refuses changes to another service's records", async () => {
    const scoped = core(orbitConsole);
    const notFound = { ok: false, error: { code: "NOT_FOUND" } };
    expect(await scoped.acknowledgeTicket(prismThread, admin)).toMatchObject(notFound);
    expect(
      await scoped.addTicketNote({ id: prismThread, body: "x", idempotencyKey: "k1" }, admin),
    ).toMatchObject(notFound);
    expect(await scoped.addReportNote({ reportId: prismReport, note: "x" }, admin)).toMatchObject(
      notFound,
    );
    expect(await scoped.updateApp(prism, { name: "renamed" }, admin)).toMatchObject(notFound);
    // Moving a ticket of the scope into another service is the same refusal.
    expect(
      await scoped.changeTicket({ id: orbitThread, revision: 0, service_id: prism }, admin),
    ).toMatchObject(notFound);
    // Merging across the boundary too.
    expect(
      await scoped.mergeTickets(
        { id: orbitThread, target_id: prismThread, revision: 0, target_revision: 0 },
        admin,
      ),
    ).toMatchObject(notFound);

    const untouched = await testEnv.DB.prepare("SELECT name FROM apps WHERE id=?")
      .bind(prism)
      .first<{ name: string }>();
    expect(untouched?.name).toBe("prism");
  });

  it("makes deployment-wide settings read-only", async () => {
    const scoped = core(orbitConsole);
    const forbidden = { ok: false, error: { code: "FORBIDDEN" } };
    expect(
      await scoped.createApp(
        { slug: "nova", name: "nova", platform: "ios", status: "testflight" },
        admin,
      ),
    ).toMatchObject(forbidden);
    expect(
      await scoped.saveTicketMaster({ kind: "assignee", id: "a1", name: "A" }, admin),
    ).toMatchObject(forbidden);
    expect(
      await scoped.setAppMailSettings({ appId: null, signatureText: "x" }, admin),
    ).toMatchObject({ ok: false });
    expect(
      await scoped.setAppMailSettings({ appId: orbit, signatureText: "orbit" }, admin),
    ).toMatchObject({ ok: true });
  });

  it("serves attachments only for the scope", async () => {
    const scoped = core(orbitConsole);
    const response = await scoped.fetch(
      new Request(`https://core.internal/internal/reports/${prismReport}/attachments/none`),
    );
    expect(response.status).toBe(404);
    const upload = await scoped.fetch(
      new Request(`https://core.internal/internal/reports/${orbitReport}/attachments`, {
        method: "PUT",
        body: "x",
      }),
    );
    expect(upload.status).toBe(404);
  });
});
