import type { Result, SupportThreadDetail } from "@tomokichi/admin-contracts";
import { defaultSlaGoals, slaClock, ticketPriority } from "@tomokichi/admin-contracts";
import { describe, expect, it } from "vitest";
import migration from "../migrations/0006_ticket_core.sql?raw";
import receiptMigration from "../migrations/0008_report_receipt_first_response.sql?raw";
import { TicketService } from "../src/domain/ticket-service";
import { admin, appActor, harness, seedApp, splitMigration } from "./harness";

function value<T>(r: Result<T>): T {
  if (!r.ok) throw Error(JSON.stringify(r.error));
  return r.value;
}
async function setup() {
  const h = await harness();
  const app = await seedApp(h);
  const tickets = new TicketService(h.db);
  const ticket = value(
    await tickets.create(
      { service_id: app, type: "INQUIRY", subject: "質問", requester_email: "person@example.com" },
      admin,
    ),
  ).ticket;
  return { h, app, tickets, ticket };
}

describe("Ticket domain", () => {
  it("uses the complete priority matrix", () => {
    const levels = ["HIGH", "MEDIUM", "LOW"] as const;
    expect(levels.map((i) => levels.map((u) => ticketPriority(i, u)))).toEqual([
      ["P1", "P2", "P2"],
      ["P2", "P3", "P3"],
      ["P3", "P3", "P4"],
    ]);
  });
  it("calculates risk, breach and completed timers", () => {
    const start = "2026-09-17T00:00:00.000Z";
    expect(slaClock(start, null, 15, Date.parse(start) + 12 * 60000).state).toBe("AT_RISK");
    expect(slaClock(start, null, 15, Date.parse(start) + 15 * 60000).state).toBe("BREACHED");
    expect(
      slaClock(start, "2026-09-17T00:05:00.000Z", 15, Date.parse(start) + 86400000).state,
    ).toBe("OK");
    expect(defaultSlaGoals.P4.resolution).toBeNull();
  });
});
describe("Ticket operations", () => {
  it("creates, ACKs once, works, waits, resolves, closes and reopens with history", async () => {
    const { tickets, ticket, h } = await setup();
    let t = ticket;
    expect(t.ticket_number).toMatch(/^TK-\d+$/);
    t = value(await tickets.ack(t.id, admin)).ticket;
    const ack = t.acknowledged_at;
    expect(value(await tickets.ack(t.id, admin)).ticket.revision).toBe(t.revision);
    for (const status of [
      "IN_PROGRESS",
      "WAITING_CUSTOMER",
      "IN_PROGRESS",
      "WAITING_INTERNAL",
      "IN_PROGRESS",
      "RESOLVED",
      "CLOSED",
      "IN_PROGRESS",
    ] as const) {
      t = value(
        await tickets.change(
          {
            id: t.id,
            revision: t.revision,
            status,
            ...(status === "RESOLVED" ? { resolution: "FIXED" } : {}),
          },
          admin,
        ),
      ).ticket;
    }
    expect(t.resolution).toBeNull();
    expect(t.acknowledged_at).toBe(ack);
    const events = await h.db
      .prepare("SELECT event_type FROM ticket_events WHERE ticket_id=?")
      .bind(t.id)
      .all<{ event_type: string }>();
    expect(events.results.filter((e) => e.event_type === "ACKNOWLEDGED")).toHaveLength(1);
    expect(events.results.some((e) => e.event_type === "REOPENED")).toBe(true);
  });
  it("rejects missing resolution, invalid transitions and stale updates", async () => {
    const { tickets, ticket } = await setup();
    expect(
      (await tickets.change({ id: ticket.id, revision: ticket.revision, status: "CLOSED" }, admin))
        .ok,
    ).toBe(false);
    expect(
      (
        await tickets.change(
          { id: ticket.id, revision: ticket.revision, status: "RESOLVED" },
          admin,
        )
      ).ok,
    ).toBe(false);
    value(await tickets.ack(ticket.id, admin));
    expect(
      (await tickets.change({ id: ticket.id, revision: ticket.revision, subject: "stale" }, admin))
        .ok,
    ).toBe(false);
  });
  it("requires priority override reasons and isolates component/category scope", async () => {
    const { tickets, ticket, h } = await setup();
    expect(
      (await tickets.change({ id: ticket.id, revision: ticket.revision, priority: "P1" }, admin))
        .ok,
    ).toBe(false);
    const t = value(
      await tickets.change(
        {
          id: ticket.id,
          revision: ticket.revision,
          priority: "P1",
          override_reason: "重大な安全上の懸念",
        },
        admin,
      ),
    ).ticket;
    expect(t.sla_ack_minutes).toBe(15);
    const other = await seedApp(h, "other-app");
    value(
      await tickets.saveMaster(
        { kind: "component", id: "foreign", service_id: other, name: "iOS", slug: "ios" },
        admin,
      ),
    );
    expect(
      (await tickets.change({ id: t.id, revision: t.revision, component_id: "foreign" }, admin)).ok,
    ).toBe(false);
  });
  it("writes private notes idempotently without reaching mail and indexes body search", async () => {
    const { tickets, ticket, h } = await setup();
    const input = { id: ticket.id, body: "内部調査メモ secretneedle", idempotencyKey: "note-one" };
    value(await tickets.note(input, admin));
    value(await tickets.note(input, admin));
    expect(h.mail.sendCount).toBe(0);
    const d = value(await tickets.detail(ticket.id));
    const notes = d.timeline.filter((x) => x.kind === "message");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.value).toMatchObject({ visibility: "INTERNAL", recipient: null });
    expect(value(await tickets.list({ query: "secretneedle" })).total).toBe(1);
    expect((await tickets.note({ ...input, visibility: "PUBLIC" }, admin)).ok).toBe(false);
  });
  it("counts a successful automatic receipt as first response and preserves it after a manual reply", async () => {
    const h = await harness(),
      app = await seedApp(h),
      tickets = new TicketService(h.db);
    const report = value(
      await h.reports.create(
        {
          appSlug: "remeet",
          externalReportId: "report-1",
          contentType: "wish",
          reasonCode: "spam",
          reporterEmail: "person@example.com",
        },
        appActor,
      ),
    );
    const source = value(await tickets.source("report", report.reportId));
    const t = value(await tickets.detail(source.id)).ticket;
    expect(t.type).toBe("REPORT");
    expect(t.first_response_at).not.toBeNull();
    expect(value(await tickets.list({})).total).toBe(1);
    value(
      await h.reply.send(
        {
          threadId: t.thread_id ?? "missing-thread",
          bodyText: "確認します",
          idempotencyKey: "operator-1",
        },
        admin,
      ),
    );
    expect(value(await tickets.detail(t.id)).ticket.first_response_at).toBe(t.first_response_at);
    expect(app).toBe(t.service_id);
  });
  it("reopens the Ticket when a customer replies to a closed conversation", async () => {
    const { tickets, ticket, h } = await setup();
    value(
      await h.support.addMessage(
        {
          threadId: ticket.thread_id ?? "missing-thread",
          direction: "inbound",
          bodyText: "first",
          providerMessageId: "<first@example.com>",
        },
        appActor,
      ),
    );
    let t = value(await tickets.detail(ticket.id)).ticket;
    t = value(
      await tickets.change(
        { id: t.id, revision: t.revision, status: "RESOLVED", resolution: "RESOLVED" },
        admin,
      ),
    ).ticket;
    t = value(
      await tickets.change({ id: t.id, revision: t.revision, status: "CLOSED" }, admin),
    ).ticket;
    value(
      await h.support.ingestInboundEmail(
        {
          from: "person@example.com",
          subject: "Re: 質問",
          bodyText: "again",
          messageId: "<second@example.com>",
          inReplyTo: "<first@example.com>",
        },
        appActor,
      ),
    );
    expect(value(await tickets.detail(t.id)).ticket).toMatchObject({
      status: "IN_PROGRESS",
      resolution: null,
      closed_at: null,
    });
  });
  it("retains source data and records merge relations", async () => {
    const { tickets, ticket, h, app } = await setup();
    const target = value(
      await tickets.create(
        { service_id: app, type: "BUG", subject: "target", requester_email: "person@example.com" },
        admin,
      ),
    ).ticket;
    const merged = value(
      await tickets.merge(
        {
          id: ticket.id,
          target_id: target.id,
          revision: ticket.revision,
          target_revision: target.revision,
        },
        admin,
      ),
    );
    expect(merged.ticket).toMatchObject({
      status: "CLOSED",
      resolution: "DUPLICATE",
      merged_into: target.id,
    });
    expect(merged.relations[0]?.relation_type).toBe("DUPLICATE");
    expect(
      await h.db.prepare("SELECT id FROM support_threads WHERE id=?").bind(ticket.id).first(),
    ).not.toBeNull();
  });
  it("lists, filters and paginates without loading message bodies", async () => {
    const { tickets, ticket, app } = await setup();
    value(await tickets.create({ service_id: app, type: "INCIDENT", subject: "incident" }, admin));
    const page = value(await tickets.list({ limit: 1 }));
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty("body");
    expect(value(await tickets.list({ type: "INCIDENT" })).total).toBe(1);
    value(
      await tickets.change(
        {
          id: ticket.id,
          revision: ticket.revision,
          next_action: "確認",
          next_action_at: "2026-01-01T00:00:00Z",
        },
        admin,
      ),
    );
    expect(value(await tickets.dashboard()).overdue).toBe(1);
  });
  it("backfills old statuses and safely replays without losing operator edits", async () => {
    const h = await harness(),
      app = await seedApp(h);
    const triggers = await h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ticket_%'")
      .all<{ name: string }>();
    for (const t of triggers.results) await h.db.prepare(`DROP TRIGGER ${t.name}`).run();
    const a = value<SupportThreadDetail>(
      await h.support.createThread(
        { source: "web_form", appSlug: "remeet", subject: "old", bodyText: "legacy body" },
        appActor,
      ),
    );
    value(await h.support.setStatus({ threadId: a.id, status: "spam" }, admin));
    for (const statement of splitMigration(migration)) await h.db.prepare(statement).run();
    const tickets = new TicketService(h.db);
    let t = value(await tickets.detail(a.id)).ticket;
    expect(t).toMatchObject({ status: "CLOSED", resolution: "SPAM", service_id: app });
    t = value(
      await tickets.change({ id: t.id, revision: t.revision, status: "IN_PROGRESS" }, admin),
    ).ticket;
    for (const statement of splitMigration(migration)) await h.db.prepare(statement).run();
    expect(value(await tickets.detail(a.id)).ticket).toMatchObject({
      status: "IN_PROGRESS",
      ticket_number: t.ticket_number,
    });
    expect(
      value(await tickets.detail(a.id)).timeline.filter((x) => x.kind === "message"),
    ).toHaveLength(1);
  });
});

it("routes replies after a merge to the target while retaining the source history", async () => {
  const { tickets, ticket, h, app } = await setup();
  value(
    await h.support.addMessage(
      {
        threadId: ticket.thread_id ?? "missing-thread",
        direction: "inbound",
        bodyText: "source history",
        providerMessageId: "<merge-origin@example.com>",
      },
      appActor,
    ),
  );
  const source = value(await tickets.detail(ticket.id)).ticket;
  const target = value(
    await tickets.create(
      {
        service_id: app,
        type: "INQUIRY",
        subject: "canonical",
        requester_email: "person@example.com",
      },
      admin,
    ),
  ).ticket;
  value(
    await tickets.merge(
      {
        id: source.id,
        target_id: target.id,
        revision: source.revision,
        target_revision: target.revision,
      },
      admin,
    ),
  );
  value(
    await h.support.ingestInboundEmail(
      {
        from: "person@example.com",
        subject: "Re",
        bodyText: "after merge",
        inReplyTo: "<merge-origin@example.com>",
        messageId: "<merge-new@example.com>",
      },
      appActor,
    ),
  );
  expect(value(await tickets.detail(source.id)).ticket.status).toBe("CLOSED");
  expect(
    value(await tickets.detail(target.id)).timeline.some(
      (x) => x.kind === "message" && x.value.body === "after merge",
    ),
  ).toBe(true);
  expect(
    value(await tickets.detail(source.id)).timeline.some(
      (x) => x.kind === "message" && x.value.body === "source history",
    ),
  ).toBe(true);
});

it("requires signed moderation instead of closing a report with a label", async () => {
  const h = await harness();
  await seedApp(h);
  const tickets = new TicketService(h.db);
  const report = value(
    await h.reports.create(
      {
        appSlug: "remeet",
        externalReportId: "pending-report",
        contentType: "wish",
        reasonCode: "spam",
        priority: "high",
      },
      appActor,
    ),
  );
  const t = value(
    await tickets.detail(value(await tickets.source("report", report.reportId)).id),
  ).ticket;
  expect(t.priority).toBe("P2");
  expect(t.sla_ack_minutes).toBe(60);
  expect(
    (
      await tickets.change(
        { id: t.id, revision: t.revision, status: "RESOLVED", resolution: "NO_ACTION_REQUIRED" },
        admin,
      )
    ).ok,
  ).toBe(false);
});

it("maps every legacy support status without changing the source records", async () => {
  const h = await harness();
  await seedApp(h);
  const triggers = await h.db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'ticket_%'")
    .all<{ name: string }>();
  for (const trigger of triggers.results) await h.db.prepare(`DROP TRIGGER ${trigger.name}`).run();
  const mappings = [
    ["open", "NEW", null],
    ["pending_user", "WAITING_CUSTOMER", null],
    ["resolved", "CLOSED", "RESOLVED"],
    ["spam", "CLOSED", "SPAM"],
  ] as const;
  for (const [oldStatus, status, resolution] of mappings) {
    const thread = value(
      await h.support.createThread(
        {
          source: "web_form",
          appSlug: "remeet",
          subject: `old-${oldStatus}`,
          bodyText: "retained",
        },
        appActor,
      ),
    );
    await h.db
      .prepare("UPDATE support_threads SET status=? WHERE id=?")
      .bind(oldStatus, thread.id)
      .run();
    for (const statement of splitMigration(migration)) await h.db.prepare(statement).run();
    expect(value(await new TicketService(h.db).detail(thread.id)).ticket).toMatchObject({
      status,
      resolution,
    });
    expect(
      await h.db.prepare("SELECT status FROM support_threads WHERE id=?").bind(thread.id).first(),
    ).toEqual({ status: oldStatus });
    // Disable the newly installed input bridge again to simulate the next old row.
    for (const trigger of triggers.results)
      await h.db.prepare(`DROP TRIGGER ${trigger.name}`).run();
  }
  for (const statement of splitMigration(migration)) await h.db.prepare(statement).run();
});

it("rejects concurrent stale changes without writing phantom events", async () => {
  const { tickets, ticket, h } = await setup();
  const results = await Promise.all([
    tickets.change({ id: ticket.id, revision: ticket.revision, subject: "first edit" }, admin),
    tickets.change({ id: ticket.id, revision: ticket.revision, subject: "second edit" }, admin),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  const events = await h.db
    .prepare(
      "SELECT metadata FROM ticket_events WHERE ticket_id=? AND json_extract(metadata,'$.field')='subject'",
    )
    .bind(ticket.id)
    .all();
  expect(events.results).toHaveLength(1);
});

it("refuses merges across requesters and terminal edits before reopening", async () => {
  const { tickets, ticket, app } = await setup();
  const other = value(
    await tickets.create(
      {
        service_id: app,
        type: "INQUIRY",
        subject: "other",
        requester_email: "different@example.com",
      },
      admin,
    ),
  ).ticket;
  expect(
    (
      await tickets.merge(
        {
          id: ticket.id,
          revision: ticket.revision,
          target_id: other.id,
          target_revision: other.revision,
        },
        admin,
      )
    ).ok,
  ).toBe(false);
  let t = value(
    await tickets.change(
      { id: ticket.id, revision: ticket.revision, status: "RESOLVED", resolution: "INVALID" },
      admin,
    ),
  ).ticket;
  t = value(
    await tickets.change({ id: t.id, revision: t.revision, status: "CLOSED" }, admin),
  ).ticket;
  expect(
    (await tickets.change({ id: t.id, revision: t.revision, subject: "cannot change" }, admin)).ok,
  ).toBe(false);
  expect(
    (await tickets.note({ id: t.id, body: "cannot add", idempotencyKey: "closed-note" }, admin)).ok,
  ).toBe(false);
});

it("leaves failed/no-address receipts unanswered, then records the successful retry", async () => {
  const h = await harness();
  await seedApp(h);
  const tickets = new TicketService(h.db);
  const input = {
    appSlug: "remeet",
    externalReportId: "failed-receipt",
    contentType: "wish",
    reasonCode: "spam",
    reporterEmail: "person@example.com",
  };
  h.mail.failNext = true;
  const report = value(await h.reports.create(input, appActor));
  const source = value(await tickets.source("report", report.reportId));
  expect(value(await tickets.detail(source.id)).ticket.first_response_at).toBeNull();
  await h.reports.sendReceipt(report.reportId);
  const at = value(await tickets.detail(source.id)).ticket.first_response_at;
  expect(at).not.toBeNull();
  await h.reports.sendReceipt(report.reportId);
  expect(value(await tickets.detail(source.id)).ticket.first_response_at).toBe(at);
  const noEmail = value(
    await h.reports.create(
      { ...input, externalReportId: "no-email", reporterEmail: undefined },
      appActor,
    ),
  );
  const noEmailSource = value(await tickets.source("report", noEmail.reportId));
  expect(value(await tickets.detail(noEmailSource.id)).ticket.first_response_at).toBeNull();
});

it("backfills an earlier receipt safely even when a manual response was already recorded", async () => {
  const h = await harness();
  await seedApp(h);
  const tickets = new TicketService(h.db);
  const report = value(
    await h.reports.create(
      {
        appSlug: "remeet",
        externalReportId: "backfill",
        contentType: "wish",
        reasonCode: "spam",
        reporterEmail: "person@example.com",
      },
      appActor,
    ),
  );
  const source = value(await tickets.source("report", report.reportId));
  const original = value(await tickets.detail(source.id)).ticket.first_response_at;
  await h.db
    .prepare("UPDATE tickets SET first_response_at='2099-01-01T00:00:00.000Z' WHERE id=?")
    .bind(source.id)
    .run();
  for (let i = 0; i < 2; i++) {
    for (const sql of splitMigration(receiptMigration)) await h.db.prepare(sql).run();
    expect(value(await tickets.detail(source.id)).ticket.first_response_at).toBe(original);
  }
});
