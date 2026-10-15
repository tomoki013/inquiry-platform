import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SupportRepository } from "../src/db/support";
import { Scope } from "../src/domain/scope";
import { TicketService } from "../src/domain/ticket-service";
import { putReportEvidence } from "../src/evidence";
import { Intake } from "../src/intake";
import { ProjectOperator } from "../src/project-operator";
import { buildServices } from "../src/services";
import { aggregateDatabase, ProjectRegistry } from "../src/storage/database";
import {
  type SchemaObject,
  type StorageSchema,
  sealStorageSql,
  storageMigration,
} from "../src/storage/migration";
import {
  rewriteIdentifiers,
  storageTables,
  tableNames,
  validatePrefix,
} from "../src/storage/schema";
import { type Harness, harness, reset, seedApp, splitMigration, testEnv } from "./harness";

let h: Harness;
let schema: StorageSchema;
const db = testEnv.DB;
const actor = { type: "admin" as const, id: "operator-1" };
const order = [
  "ticket_relations",
  "ticket_reports",
  "ticket_events",
  "ticket_messages",
  "ticket_sources",
  "tickets",
  "report_operations",
  "report_attachments",
  "report_events",
  "reports",
  "support_thread_redirects",
  "support_reply_sends",
  "support_reply_attempts",
  "support_drafts",
  "support_attachments",
  "support_messages",
  "support_threads",
] as const;
async function execute(sql: string) {
  return db.batch<Record<string, unknown>>(splitMigration(sql).map((s) => db.prepare(s)));
}
async function plan(slug: string) {
  return storageMigration(schema, { slug, prefix: `p_${slug}` });
}
async function activate(slug: string) {
  const m = await plan(slug);
  await execute(m.prepare);
  await execute(m.copy);
  const verified = await execute(m.verify);
  expect(verified.flatMap((r) => r.results).every((r) => r.mismatches === 0)).toBe(true);
  await execute(m.cutover);
  return m;
}
function bind<T>(Entry: new (ctx: ExecutionContext, env: never) => T, projects: string[]) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: { caller: "console", projects } });
  return { entry: new Entry(ctx, testEnv as never), ctx };
}
const contact = (projectSlug: string, key = "request-1") => ({
  projectSlug,
  idempotencyKey: key,
  subject: "A question",
  message: `private ${projectSlug}`,
  channel: "app" as const,
});
const report = (projectSlug: string, key = "same-external-key") => ({
  projectSlug,
  externalReportId: key,
  targetType: "post",
  targetId: "content-1",
  reason: "spam",
  description: `private report ${projectSlug}`,
});

beforeAll(async () => {
  h = await harness();
  const objects = (
    await db
      .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL")
      .all<SchemaObject>()
  ).results;
  const columns = {} as StorageSchema["columns"];
  for (const table of storageTables)
    columns[table] = (
      await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    ).results.map((r) => r.name);
  schema = { objects, columns };
});
beforeEach(async () => {
  // Retain the generated schema between tests, clear its children before parents.
  const tables = new Set(
    (
      await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()
    ).results.map((r) => r.name),
  );
  for (const slug of ["orbit", "prism", "unassigned"])
    for (const table of order) {
      const physical = tableNames(`p_${slug}`)[table];
      if (tables.has(physical)) await db.prepare(`DELETE FROM ${physical}`).run();
    }
  await db.prepare("DELETE FROM project_storage").run();
  await db.prepare("DELETE FROM project_record_ids").run();
  await reset();
  await seedApp(h, "orbit");
  await seedApp(h, "prism");
});

describe("project storage migration", () => {
  it("preserves every column, stable IDs, histories and retry keys, and is replay-safe", async () => {
    const old = await h.support.createThread(
      {
        appSlug: "orbit",
        source: "web_form",
        requesterEmail: "person@example.com",
        subject: "Before",
        bodyText: "private",
        providerMessageId: "form-before",
      },
      actor,
    );
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    await h.reply.saveDraft({ threadId: old.value.id, bodyText: "draft" });
    await h.support.addInternalNote({ threadId: old.value.id, bodyText: "staff-only" }, actor);
    await h.reports.create(
      {
        appSlug: "orbit",
        externalReportId: "old-report",
        contentType: "post",
        reasonCode: "spam",
        detail: "evidence text",
        priority: "normal",
      },
      actor,
    );
    const m = await activate("orbit");
    await execute(m.prepare);
    await execute(m.copy);
    await execute(m.cutover);
    const services = buildServices(testEnv, () => undefined);
    const found = await services.support.detail(old.value.id);
    expect(found.ok && found.value.messages.map((r) => r.bodyText)).toEqual([
      "private",
      "staff-only",
    ]);
    expect(await services.reply.getDraft(old.value.id)).toMatchObject({
      ok: true,
      value: { bodyText: "draft" },
    });
    expect(await db.prepare("SELECT COUNT(*) n FROM support_threads").first("n")).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) n FROM p_orbit_support_tickets").first("n")).toBe(2);
  });

  it("reuses an accepted or failed legacy provider key after cutover without a new delivery identity", async () => {
    const created = await h.support.createThread(
      {
        appSlug: "orbit",
        source: "email",
        requesterEmail: "person@example.com",
        subject: "Before",
        bodyText: "first",
      },
      actor,
    );
    if (!created.ok) throw new Error("fixture");
    h.mail.failNext = true;
    const send = {
      threadId: created.value.id,
      bodyText: "answer",
      idempotencyKey: "legacy-send-key",
    };
    expect((await h.reply.send(send, actor)).ok).toBe(false);
    await activate("orbit");
    const scoped = await harness({ database: await new ProjectRegistry(db).forSlug("orbit") });
    expect((await scoped.reply.send(send, actor)).ok).toBe(true);
    expect(scoped.mail.sent[0]?.idempotencyKey).toBe("legacy-send-key");
    expect((await scoped.reply.send(send, actor)).ok).toBe(true);
    expect(scoped.mail.sent).toHaveLength(1);
  });

  it("copies while intake continues, including existing parents not yet backfilled", async () => {
    const old = await h.support.createThread(
      { appSlug: "orbit", source: "email", subject: "Before", bodyText: "first" },
      actor,
    );
    if (!old.ok) throw new Error("fixture");
    const m = await plan("orbit");
    await execute(m.prepare);
    await h.support.addMessage(
      { threadId: old.value.id, direction: "inbound", bodyText: "during" },
      actor,
    );
    const during = bind(Intake, ["orbit"]);
    expect(await during.entry.submitContact(contact("orbit", "during"))).toMatchObject({
      ok: true,
    });
    await waitOnExecutionContext(during.ctx);
    await execute(m.copy);
    await execute(m.copy);
    const checks = await execute(m.verify);
    expect(checks.flatMap((r) => r.results).every((r) => r.mismatches === 0)).toBe(true);
    await execute(m.cutover);
    expect(
      await db
        .prepare("SELECT body_text FROM p_orbit_support_messages WHERE thread_id=? ORDER BY rowid")
        .bind(old.value.id)
        .all(),
    ).toMatchObject({ results: [{ body_text: "first" }, { body_text: "during" }] });
    await expect(
      h.support.addMessage(
        { threadId: old.value.id, direction: "inbound", bodyText: "stale" },
        actor,
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it("repairs a mirrored child update deferred until its new parent is copied", async () => {
    const source = await h.support.createThread(
      { appSlug: "orbit", source: "email", subject: "Source", bodyText: "first" },
      actor,
    );
    const target = await h.support.createThread(
      { appSlug: "orbit", source: "email", subject: "Target", bodyText: "target" },
      actor,
    );
    if (!source.ok || !target.ok) throw new Error("fixture");
    const m = await plan("orbit");
    await execute(m.prepare);
    await db
      .prepare("INSERT INTO p_orbit_support_tickets SELECT * FROM support_threads WHERE id=?")
      .bind(source.value.id)
      .run();
    await db
      .prepare(
        "INSERT INTO p_orbit_support_messages SELECT * FROM support_messages WHERE thread_id=?",
      )
      .bind(source.value.id)
      .run();
    await db
      .prepare("UPDATE support_messages SET thread_id=? WHERE thread_id=?")
      .bind(target.value.id, source.value.id)
      .run();
    await execute(m.copy);
    await execute(m.cutover);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM p_orbit_support_messages WHERE thread_id=?")
        .bind(target.value.id)
        .first("n"),
    ).toBe(2);
  });

  it("refuses schema drift instead of silently omitting an unknown column", async () => {
    const incompatible = {
      ...schema,
      columns: { ...schema.columns, support_messages: schema.columns.support_messages.slice(1) },
    };
    const migration = storageMigration(incompatible, { slug: "orbit", prefix: "p_orbit" });
    await expect(execute(migration.prepare)).rejects.toThrow();
    expect(await db.prepare("SELECT state FROM project_storage").first()).toBeNull();
  });

  it("refuses cutover on missing data and rolls back the whole batch, then recovers", async () => {
    await h.support.createThread(
      { appSlug: "orbit", source: "email", subject: "Before", bodyText: "first" },
      actor,
    );
    const m = await plan("orbit");
    await execute(m.prepare);
    await expect(execute(m.cutover)).rejects.toThrow();
    expect(await db.prepare("SELECT state FROM project_storage").first("state")).toBe("copying");
    for (const table of storageTables) {
      let changed = 1;
      while (changed) changed = (await execute(m.backfill(table, 1)))[0]?.meta.changes ?? 0;
    }
    await execute(m.cutover);
    expect(await db.prepare("SELECT state FROM project_storage").first("state")).toBe("active");
  });
});

describe("partitioned entrypoints", () => {
  beforeEach(async () => {
    await activate("orbit");
    await activate("prism");
  });

  it("isolates writes and per-project idempotency keys through the unchanged Intake SDK contract", async () => {
    for (const slug of ["orbit", "prism"]) {
      const { entry, ctx } = bind(Intake, [slug]);
      expect(await entry.submitContact(contact(slug))).toMatchObject({
        ok: true,
        value: { duplicate: false },
      });
      expect(await entry.submitReport(report(slug))).toMatchObject({
        ok: true,
        value: { duplicate: false },
      });
      expect(await entry.submitReport(report(slug))).toMatchObject({
        ok: true,
        value: { duplicate: true },
      });
      expect(await entry.submitContact(contact(slug))).toMatchObject({
        ok: true,
        value: { duplicate: true },
      });
      await waitOnExecutionContext(ctx);
    }
    expect(await db.prepare("SELECT COUNT(*) n FROM support_threads").first("n")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) n FROM tickets").first("n")).toBe(0);
    for (const slug of ["orbit", "prism"]) {
      expect(
        await db.prepare(`SELECT COUNT(*) n FROM p_${slug}_moderation_reports`).first("n"),
      ).toBe(1);
      const bodies = JSON.stringify(
        (await db.prepare(`SELECT * FROM p_${slug}_support_messages`).all()).results,
      );
      expect(bodies).toContain(`private ${slug}`);
      expect(bodies).not.toContain(`private ${slug === "orbit" ? "prism" : "orbit"}`);
    }
  });

  it("enforces props, ID isolation, listing pagination, notes, audit and old ProjectOperator methods", async () => {
    const one = bind(Intake, ["orbit"]);
    const two = bind(Intake, ["prism"]);
    const a = await one.entry.submitContact(contact("orbit"));
    const b = await two.entry.submitContact(contact("prism"));
    if (!a.ok || !b.ok) throw new Error("fixtures");
    await waitOnExecutionContext(one.ctx);
    await waitOnExecutionContext(two.ctx);
    const operator = bind(ProjectOperator, ["orbit"]).entry;
    expect(await operator.getTicket("orbit", b.value.ticketNumber ?? "")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await operator.getTicket("prism", b.value.ticketNumber ?? "")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const list = await operator.listTickets("orbit", {});
    expect(list.ok && list.value.total).toBe(1);
    const detail = await operator.getTicket("orbit", a.value.ticketNumber ?? "");
    if (!detail.ok) throw new Error(JSON.stringify(detail));
    expect(
      await operator.addNote(
        "orbit",
        detail.value.id,
        { body: "internal-only", idempotencyKey: "note-1" },
        { id: "person-1" },
      ),
    ).toMatchObject({ ok: true });
    const all = buildServices(testEnv, () => undefined);
    const page = await all.tickets.list({ limit: 1 });
    expect(page.ok && page.value.total).toBe(2);
    expect(page.ok && page.value.items.length).toBe(1);
    expect(await one.entry.submitContact(contact("prism"))).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await bind(Intake, ["unknown"]).entry.submitContact(contact("unknown"))).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await db.prepare("SELECT COUNT(*) n FROM delivery_jobs").first("n")).toBe(4);
  });

  it("preserves project mail settings, separates provider keys and never mails internal notes", async () => {
    const keys: string[] = [];
    for (const slug of ["orbit", "prism"]) {
      const scoped = await harness({ database: await new ProjectRegistry(db).forSlug(slug) });
      const app = await db
        .prepare("SELECT id FROM apps WHERE slug=?")
        .bind(slug)
        .first<{ id: string }>();
      if (!app) throw new Error("fixture");
      await db
        .prepare(
          "INSERT INTO app_mail_settings(app_id,signature_text,support_email,from_name,updated_at) VALUES(?,?,?,?,?)",
        )
        .bind(app.id, `${slug} signature`, `${slug}@example.com`, slug, new Date().toISOString())
        .run();
      const created = await scoped.support.createThread(
        {
          appSlug: slug,
          source: "email",
          requesterEmail: "person@example.com",
          subject: "Question",
          bodyText: "first",
        },
        actor,
      );
      if (!created.ok) throw new Error("fixture");
      expect(
        (
          await scoped.support.addInternalNote(
            { threadId: created.value.id, bodyText: "internal-only" },
            actor,
          )
        ).ok,
      ).toBe(true);
      expect(scoped.mail.sent).toHaveLength(0);
      expect(
        (
          await scoped.reply.send(
            { threadId: created.value.id, bodyText: "answer", idempotencyKey: "same-send-key" },
            actor,
          )
        ).ok,
      ).toBe(true);
      const mail = scoped.mail.sent[0];
      expect(mail?.from).toBe(`${slug} <${slug}@example.com>`);
      expect(mail?.text).toContain(`${slug} signature`);
      expect(mail?.text).not.toContain("internal-only");
      keys.push(mail?.idempotencyKey ?? "");
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("routes replies from a shared mailbox by verified sender and retains evidence ownership", async () => {
    const scoped = await harness({ database: await new ProjectRegistry(db).forSlug("orbit") });
    const thread = await scoped.support.createThread(
      {
        appSlug: "orbit",
        source: "email",
        requesterEmail: "person@example.com",
        subject: "Question",
        bodyText: "first",
      },
      actor,
    );
    if (!thread.ok) throw new Error("fixture");
    const root = buildServices(testEnv, () => undefined);
    expect(
      await root.support.ingestInboundEmail(
        {
          from: "person@example.com",
          subject: `Re: [受付ID:${thread.value.id}]`,
          bodyText: "followup",
          messageId: "<shared@example.com>",
        },
        { type: "email" },
      ),
    ).toMatchObject({ ok: true, value: { threadId: thread.value.id, newThread: false } });
    expect(await db.prepare("SELECT COUNT(*) n FROM p_orbit_support_messages").first("n")).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) n FROM p_prism_support_messages").first("n")).toBe(0);
    const created = await bind(Intake, ["orbit"]).entry.submitReport(report("orbit"));
    if (!created.ok) throw new Error("fixture");
    const request = () =>
      new Request("https://internal/internal/reports/x/attachments", {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: new Uint8Array([1, 2, 3]),
      });
    expect((await putReportEvidence(testEnv, created.value.reportId, request())).status).toBe(201);
    const attachment = await db
      .prepare("SELECT r2_key FROM p_orbit_moderation_evidence")
      .first<{ r2_key: string }>();
    expect(attachment?.r2_key).toContain("/moderation/");
    expect(
      (
        await bind(Intake, ["prism"]).entry.fetch(
          new Request(`https://internal/internal/reports/${created.value.reportId}/attachments`, {
            method: "PUT",
            body: new Uint8Array([1]),
          }),
        )
      ).status,
    ).toBe(404);
    const scope = await Scope.resolve(db, { scope: { services: ["prism"] } });
    expect(
      await aggregateDatabase(new ProjectRegistry(db), scope)
        .prepare("SELECT COUNT(*) n FROM reports")
        .first("n"),
    ).toBe(0);
  });

  it("blocks cross-owner rows, foreign keys, ambiguous IDs and aggregate writes", async () => {
    const entry = bind(Intake, ["orbit"]).entry;
    await entry.submitContact(contact("orbit"));
    const row = await db
      .prepare("SELECT * FROM p_orbit_support_tickets")
      .first<{ id: string; app_id: string }>();
    if (!row) throw new Error("fixture");
    const registry = new ProjectRegistry(db);
    const prism = await registry.forSlug("prism");
    const repo = new SupportRepository(prism);
    await expect(
      repo
        .insertThreadStatement({
          id: "wrong-owner",
          appId: row.app_id,
          source: "internal",
          subject: "x",
          at: new Date().toISOString(),
        })
        .run(),
    ).rejects.toThrow(/Ownership/);
    await expect(
      repo
        .insertThreadStatement({
          id: row.id,
          source: "internal",
          subject: "x",
          at: new Date().toISOString(),
        })
        .run(),
    ).rejects.toThrow(/Collision/);
    await expect(
      repo
        .insertMessageStatement({
          id: "cross-child",
          threadId: row.id,
          direction: "inbound",
          bodyText: "x",
          at: new Date().toISOString(),
        })
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      aggregateDatabase(registry).prepare("UPDATE tickets SET subject='oops'").run(),
    ).rejects.toThrow(/ReadOnly/);
    await expect(registry.forSlug("unregistered")).rejects.toThrow();
    expect(() => validatePrefix("p_x; DROP TABLE tickets")).toThrow();
    expect(
      rewriteIdentifiers("SELECT * FROM reports WHERE detail='reports' -- reports", {
        reports: "p_x_moderation_reports",
      }),
    ).toBe("SELECT * FROM p_x_moderation_reports WHERE detail='reports' -- reports");
  });

  it("seals all legacy writes only after every service has active storage", async () => {
    await expect(execute(sealStorageSql())).rejects.toThrow();
    expect(
      await db
        .prepare("SELECT value FROM platform_settings WHERE key='project_storage_required'")
        .first(),
    ).toBeNull();
    await activate("unassigned");
    await execute(sealStorageSql());
    expect(
      await db
        .prepare("SELECT value FROM platform_settings WHERE key='project_storage_required'")
        .first("value"),
    ).toBe("1");
    const input = {
      id: "stale",
      source: "internal" as const,
      subject: "old Worker",
      at: new Date().toISOString(),
    };
    await expect(new SupportRepository(db).insertThreadStatement(input).run()).rejects.toThrow(
      /Storage/,
    );
    const submitted = await bind(Intake, ["orbit"]).entry.submitContact(
      contact("orbit", "after-seal"),
    );
    expect(submitted.ok).toBe(true);
    await seedApp(h, "new-project");
    await expect(new ProjectRegistry(db).forSlug("new-project")).rejects.toThrow(/Unavailable/);
  });

  it("keeps report decisions independent from support mail and general ticket changes", async () => {
    const entry = bind(Intake, ["orbit"]).entry;
    const result = await entry.submitReport(report("orbit"));
    if (!result.ok) throw new Error("fixture");
    const services = buildServices(testEnv, () => undefined);
    const reviewed = await services.reports.changeStatus(
      { reportId: result.value.reportId, to: "reviewing" },
      actor,
    );
    expect(reviewed.ok).toBe(true);
    const local = await services.registry.forSlug("orbit");
    const tickets = new TicketService(local);
    const source = await tickets.source("report", result.value.reportId);
    if (!source.ok) throw new Error("fixture");
    const row = await tickets.row(source.value.id);
    if (!row) throw new Error("fixture");
    expect(
      await tickets.change(
        { id: row.id, revision: row.revision, status: "RESOLVED", resolution: "CONTENT_REMOVED" },
        actor,
      ),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const detail = await services.reports.detail(result.value.reportId);
    if (!detail.ok || !detail.value.supportThreadId) throw new Error("fixture");
    await services.support.setStatus(
      { threadId: detail.value.supportThreadId, status: "resolved" },
      actor,
    );
    await services.support.addMessage(
      {
        threadId: detail.value.supportThreadId,
        direction: "inbound",
        bodyText: "more information",
      },
      actor,
    );
    expect(await services.reports.detail(result.value.reportId)).toMatchObject({
      ok: true,
      value: { status: "reviewing" },
    });
  });
});
