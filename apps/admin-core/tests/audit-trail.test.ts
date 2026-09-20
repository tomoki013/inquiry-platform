import type { Result } from "@tomokichi/admin-contracts";
import { describe, expect, it } from "vitest";
import { TicketService } from "../src/domain/ticket-service";
import { admin, harness, seedApp } from "./harness";

/*
 * Why this exists: the audit story of the admin is "every change leaves a row
 * that says who did it, in the same transaction". The individual ticket tests
 * touch on that as a side effect; nothing checked it across *every* mutating
 * method, so a new method — or a refactor that moved an event out of the
 * batch — could silently produce changes with nobody's name on them.
 *
 * The rule pinned here, per operation: the number of audit rows that carry the
 * actor's id grows by at least one for a change that succeeded, by exactly
 * zero for a read, and by exactly zero for a change the service refused.
 * `ticket_events` is where Ticket operations write; `audit_logs` is where the
 * master-data changes write. Both are counted, because an operator reading the
 * activity screen does not care which table the answer came from.
 */

function value<T>(r: Result<T>): T {
  if (!r.ok) throw Error(JSON.stringify(r.error));
  return r.value;
}

const second = { type: "admin", id: "second-operator" } as const;

async function actorRows(db: D1Database, actorId: string): Promise<number> {
  const events = await db
    .prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE actor_id=?")
    .bind(actorId)
    .first<{ n: number }>();
  const audits = await db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id=?")
    .bind(actorId)
    .first<{ n: number }>();
  return (events?.n ?? 0) + (audits?.n ?? 0);
}

describe("audit trail across every Ticket mutation", () => {
  it("records the acting operator for each change, and nothing for reads or refused changes", async () => {
    const h = await harness();
    const app = await seedApp(h);
    const tickets = new TicketService(h.db);
    const db = h.db as unknown as D1Database;

    let before = await actorRows(db, second.id);
    const step = async (label: string, run: () => Promise<unknown>, expectGrowth: boolean) => {
      await run();
      const after = await actorRows(db, second.id);
      if (expectGrowth) {
        expect(after, `${label} left no audit row for ${second.id}`).toBeGreaterThan(before);
      } else {
        expect(after, `${label} wrote an audit row it should not have`).toBe(before);
      }
      before = after;
    };

    // Every row below is written by `second`, so the count starts at zero and
    // only this operator's rows are counted — the seed app was made by `admin`.
    expect(before).toBe(0);

    let ticket = value(
      await tickets.create(
        { service_id: app, type: "INQUIRY", subject: "監査", requester_email: "p@example.com" },
        second,
      ),
    ).ticket;
    // `create` writes TICKET_CREATED through the trigger with no actor; the
    // service's own creation event carries the operator. Either way, one of
    // them must name `second`.
    await step("create", async () => {}, true);

    await step(
      "ack",
      async () => (ticket = value(await tickets.ack(ticket.id, second)).ticket),
      true,
    );
    await step(
      "status change",
      async () =>
        (ticket = value(
          await tickets.change(
            { id: ticket.id, revision: ticket.revision, status: "IN_PROGRESS" },
            second,
          ),
        ).ticket),
      true,
    );
    await step(
      "detail change",
      async () =>
        (ticket = value(
          await tickets.change(
            { id: ticket.id, revision: ticket.revision, subject: "件名を直す" },
            second,
          ),
        ).ticket),
      true,
    );
    await step(
      "priority change",
      async () =>
        (ticket = value(
          await tickets.change(
            {
              id: ticket.id,
              revision: ticket.revision,
              priority: "P1",
              override_reason: "安全上の懸念",
            },
            second,
          ),
        ).ticket),
      true,
    );
    await step(
      "internal note",
      async () =>
        (ticket = value(
          await tickets.note(
            { id: ticket.id, body: "内部メモ", idempotencyKey: "audit-note-1" },
            second,
          ),
        ).ticket),
      true,
    );

    // Reads never write.
    await step("list", () => tickets.list({}), false);
    await step("detail", () => tickets.detail(ticket.id), false);
    await step("dashboard", () => tickets.dashboard(), false);

    // A refused change writes nothing — the batch is all-or-nothing.
    await step(
      "stale revision",
      async () => {
        const refused = await tickets.change(
          { id: ticket.id, revision: ticket.revision - 1, subject: "stale" },
          second,
        );
        expect(refused.ok).toBe(false);
      },
      false,
    );
    await step(
      "invalid transition",
      async () => {
        const refused = await tickets.change(
          { id: ticket.id, revision: ticket.revision, status: "CLOSED" },
          second,
        );
        expect(refused.ok).toBe(false);
      },
      false,
    );

    const other = value(
      await tickets.create(
        { service_id: app, type: "BUG", subject: "関連", requester_email: "p@example.com" },
        second,
      ),
    ).ticket;
    await step("create (second ticket)", async () => {}, true);
    await step(
      "relation",
      async () =>
        value(
          await tickets.relation(
            { id: ticket.id, target_id: other.id, relation_type: "RELATED" },
            second,
          ),
        ),
      true,
    );
    await step(
      "merge",
      async () =>
        value(
          await tickets.merge(
            {
              id: other.id,
              target_id: ticket.id,
              revision: other.revision,
              target_revision: ticket.revision,
            },
            second,
          ),
        ),
      true,
    );
    await step(
      "master data",
      async () =>
        value(
          await tickets.saveMaster(
            { kind: "group", id: "audit-group", name: "Audit", is_active: true },
            second,
          ),
        ),
      true,
    );
  });

  /*
   * Master-data changes are audited, but the row says only which record was
   * touched — not what it said before or after. The audit (§8-5) asks for
   * from/to like the ticket field changes carry. Marked `fails` until that is
   * implemented; flip to `it` in the same change.
   */
  it.fails("keeps the previous and new value when master data is edited", async () => {
    const h = await harness();
    const tickets = new TicketService(h.db);
    value(
      await tickets.saveMaster(
        { kind: "group", id: "renamed-group", name: "Before", is_active: true },
        admin,
      ),
    );
    value(
      await tickets.saveMaster(
        { kind: "group", id: "renamed-group", name: "After", is_active: true },
        admin,
      ),
    );
    const row = await (h.db as unknown as D1Database)
      .prepare(
        "SELECT metadata_json FROM audit_logs WHERE target_id=? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .bind("renamed-group")
      .first<{ metadata_json: string }>();
    const metadata = JSON.parse(row?.metadata_json ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({ from: { name: "Before" }, to: { name: "After" } });
  });
});
