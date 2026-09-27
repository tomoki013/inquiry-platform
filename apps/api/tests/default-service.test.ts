import type { IngestInboundEmailResult } from "@inquiry-platform/core";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0010_default_service_setting.sql?raw";
import { expectOk, type Harness, harness, splitMigration } from "./harness";

let h: Harness;

const inbound = {
  from: "someone@example.com",
  to: "support@example.com",
  subject: "質問があります",
  bodyText: "どのアプリの話でもありません。",
  messageId: "<unassigned@example.com>",
  references: [],
};

async function ticketServiceFor(threadId: string): Promise<string | undefined> {
  const row = await h.db
    .prepare("SELECT service_id FROM tickets WHERE id = ?")
    .bind(threadId)
    .first<{ service_id: string }>();
  return row?.service_id;
}

async function openUnassignedThread(): Promise<string> {
  return expectOk<IngestInboundEmailResult>(
    (await h.support.ingestInboundEmail(inbound, { type: "email" })) as never,
  ).threadId;
}

async function apply(sql: string): Promise<void> {
  for (const statement of splitMigration(sql)) await h.db.prepare(statement).run();
}

beforeEach(async () => {
  h = await harness();
});

describe("the default service for contacts without a Project", () => {
  it("is the built-in 'unassigned' service when the deployment has not chosen one", async () => {
    expect(await ticketServiceFor(await openUnassignedThread())).toBe("unassigned");
  });

  it("is the service the deployment names in platform_settings", async () => {
    await h.db.prepare("INSERT INTO services VALUES ('general','General','general',1)").run();
    await h.db
      .prepare("INSERT INTO platform_settings VALUES ('default_service_id','general')")
      .run();
    expect(await ticketServiceFor(await openUnassignedThread())).toBe("general");
  });

  it("carries forward a default written into an older trigger", async () => {
    // What a database created before 0010 has: the default as a literal.
    const current = migration.slice(migration.indexOf("CREATE TRIGGER"));
    const setting =
      "COALESCE(NEW.app_id,(SELECT value FROM platform_settings WHERE key='default_service_id'),'unassigned')";
    expect(current).toContain(setting);
    await h.db.prepare("INSERT INTO services VALUES ('legacy','Legacy','legacy',1)").run();
    await h.db.prepare("DELETE FROM platform_settings").run();
    await apply(
      `DROP TRIGGER IF EXISTS ticket_support_insert;\n${current.replace(setting, "COALESCE(NEW.app_id,'legacy')")}`,
    );

    await apply(migration);

    const saved = await h.db
      .prepare("SELECT value FROM platform_settings WHERE key = 'default_service_id'")
      .first<{ value: string }>();
    expect(saved?.value).toBe("legacy");
    expect(await ticketServiceFor(await openUnassignedThread())).toBe("legacy");
  });

  it("changes nothing when applied again", async () => {
    await apply(migration);
    await apply(migration);
    expect(
      await h.db.prepare("SELECT COUNT(*) AS n FROM platform_settings").first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(await ticketServiceFor(await openUnassignedThread())).toBe("unassigned");
  });
});
