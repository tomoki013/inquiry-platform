import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { IntakeProps, ProjectOperatorProps } from "@inquiry-platform/core";
import {
  createInquiryClient,
  createProjectOperatorClient,
  type IntakeBinding,
  type ProjectOperatorApi,
} from "@inquiry-platform/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { Intake } from "../src/intake";
import { ProjectOperator } from "../src/project-operator";
import { harness, seedApp, testEnv } from "./harness";

/*
 * What this pins: a project's console can work its own tickets through a
 * binding, and nothing else. The binding's props decide which projects; a
 * ticket of another project is indistinguishable from a missing one; only the
 * fields a console decides reach Core; and every change is audited as the
 * calling app and the person inside it.
 */

function operator(props: ProjectOperatorProps | Record<string, unknown> | undefined) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: props });
  const entry = new ProjectOperator(ctx, testEnv as never);
  const api: ProjectOperatorApi = {
    project: entry.project.bind(entry),
    listTickets: entry.listTickets.bind(entry),
    getTicket: entry.getTicket.bind(entry),
    changeTicket: entry.changeTicket.bind(entry),
    addNote: entry.addNote.bind(entry),
    reply: entry.reply.bind(entry),
    setSignature: entry.setSignature.bind(entry),
  };
  return { ctx, api };
}

const orbitConsole: ProjectOperatorProps = { caller: "orbit-api", projects: ["orbit"] };
const person = { id: "sub-1234" };

async function contact(projectSlug: string, key: string, email?: string) {
  const ctx = createExecutionContext();
  const props: IntakeProps = { caller: "form", projects: ["orbit", "prism"] };
  Object.defineProperty(ctx, "props", { value: props });
  const intake = new Intake(ctx, testEnv as never);
  const client = createInquiryClient({
    submitContact: intake.submitContact.bind(intake),
    submitReport: intake.submitReport.bind(intake),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => intake.fetch(new Request(input, init)),
  } as IntakeBinding);
  const result = await client.createContact({
    projectSlug,
    idempotencyKey: key,
    subject: `件名 ${key}`,
    message: `本文 ${key}`,
    ...(email ? { email } : {}),
    channel: "web_form",
  });
  await waitOnExecutionContext(ctx);
  if (!result.ok || !result.value.ticketNumber) throw new Error("fixture contact failed");
  const row = await testEnv.DB.prepare("SELECT id FROM tickets WHERE ticket_number = ?")
    .bind(result.value.ticketNumber)
    .first<{ id: string }>();
  return { id: row?.id ?? "", number: result.value.ticketNumber };
}

beforeEach(async () => {
  const h = await harness();
  await seedApp(h, "orbit");
  await seedApp(h, "prism");
});

describe("ProjectOperator: who may", () => {
  it("refuses a binding without props, and a project it was not granted", async () => {
    expect(await operator(undefined).api.project("orbit")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await operator(orbitConsole).api.project("prism")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await operator({ caller: "x", projects: [] }).api.project("orbit")).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("answers NOT_FOUND for a granted project the platform does not know", async () => {
    const { api } = operator({ caller: "x", projects: ["ghost"] });
    expect(await api.project("ghost")).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("describes its own project", async () => {
    const result = await operator(orbitConsole).api.project("orbit");
    expect(result).toMatchObject({ ok: true, value: { slug: "orbit", signature: "" } });
  });
});

describe("ProjectOperator: its own tickets and no others", () => {
  it("lists only the project's tickets", async () => {
    await contact("orbit", "o-1", "a@example.com");
    await contact("orbit", "o-2", "b@example.com");
    await contact("prism", "p-1", "c@example.com");
    const client = createProjectOperatorClient(operator(orbitConsole).api, "orbit");
    const page = await client.listTickets({ status: "open" });
    expect(page.ok && page.value.total).toBe(2);
    expect(page.ok && page.value.items.map((item) => item.subject).sort()).toEqual([
      "件名 o-1",
      "件名 o-2",
    ]);
  });

  it("finds a ticket by id or by number, and hides another project's", async () => {
    const own = await contact("orbit", "o-1", "a@example.com");
    const theirs = await contact("prism", "p-1", "c@example.com");
    const client = createProjectOperatorClient(operator(orbitConsole).api, "orbit");

    const byId = await client.getTicket(own.id);
    const byNumber = await client.getTicket(own.number);
    expect(byId).toMatchObject({ ok: true, value: { number: own.number, canReply: true } });
    expect(byNumber.ok && byNumber.value.id).toBe(own.id);
    expect(byId.ok && byId.value.timeline.find((item) => item.kind === "message")).toMatchObject({
      kind: "message",
      direction: "inbound",
      body: "本文 o-1",
    });

    for (const ref of [theirs.id, theirs.number, "nope"]) {
      expect(await client.getTicket(ref)).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    }
    expect(
      await client.changeTicket(theirs.id, { revision: 0, status: "ACKNOWLEDGED" }, person),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(
      await client.addNote(theirs.id, { body: "x", idempotencyKey: "note-000001" }, person),
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("ProjectOperator: changes go through Core's rules", () => {
  it("moves a ticket, audits the app and the person, and refuses a stale revision", async () => {
    const own = await contact("orbit", "o-1", "a@example.com");
    const client = createProjectOperatorClient(operator(orbitConsole).api, "orbit");
    const before = await client.getTicket(own.id);
    const revision = before.ok ? before.value.revision : -1;

    const moved = await client.changeTicket(own.id, { revision, status: "ACKNOWLEDGED" }, person);
    expect(moved).toMatchObject({
      ok: true,
      value: { status: "ACKNOWLEDGED", allowedStatuses: ["IN_PROGRESS", "RESOLVED"] },
    });

    const stale = await client.changeTicket(own.id, { revision, status: "IN_PROGRESS" }, person);
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    const actors = await testEnv.DB.prepare(
      "SELECT DISTINCT actor_id FROM ticket_events WHERE ticket_id = ? AND actor_id LIKE 'orbit-api:%'",
    )
      .bind(own.id)
      .all<{ actor_id: string }>();
    expect(actors.results.map((row) => row.actor_id)).toEqual(["orbit-api:sub-1234"]);
  });

  it("refuses a field a console does not decide, and an operator id that is an address", async () => {
    const own = await contact("orbit", "o-1", "a@example.com");
    const { api } = operator(orbitConsole);
    expect(
      await api.changeTicket(
        "orbit",
        own.id,
        { revision: 0, service_id: "prism" } as never,
        person,
      ),
    ).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(
      await api.changeTicket("orbit", own.id, { revision: 0 }, { id: "person@example.com" }),
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("adds an internal note that shows as a note", async () => {
    const own = await contact("orbit", "o-1", "a@example.com");
    const client = createProjectOperatorClient(operator(orbitConsole).api, "orbit");
    const noted = await client.addNote(
      own.id,
      { body: "調査中", idempotencyKey: "note-000001" },
      person,
    );
    expect(
      noted.ok &&
        noted.value.timeline.find((item) => item.kind === "message" && item.direction === "note"),
    ).toMatchObject({
      body: "調査中",
    });
  });

  it("will not reply where there is no address", async () => {
    const own = await contact("orbit", "o-1");
    const client = createProjectOperatorClient(operator(orbitConsole).api, "orbit");
    const replied = await client.reply(
      own.id,
      { body: "こんにちは", idempotencyKey: "reply-000001" },
      person,
    );
    expect(replied).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("sets the project's own signature and leaves others alone", async () => {
    const client = createProjectOperatorClient(operator(orbitConsole).api, "orbit");
    const saved = await client.setSignature("  Orbit\nhttps://orbit.example  ", person);
    expect(saved).toMatchObject({ ok: true, value: { signature: "Orbit\nhttps://orbit.example" } });
    const rows = await testEnv.DB.prepare(
      "SELECT a.slug FROM app_mail_settings m JOIN apps a ON a.id = m.app_id",
    ).all<{ slug: string }>();
    expect(rows.results.map((row) => row.slug)).toEqual(["orbit"]);
  });
});

describe("createProjectOperatorClient", () => {
  it("answers UNAVAILABLE without a binding instead of throwing", async () => {
    const client = createProjectOperatorClient(undefined, "orbit");
    expect(await client.project()).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  });
});
