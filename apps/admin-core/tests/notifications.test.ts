import { describe, expect, it } from "vitest";
import {
  admin,
  appActor,
  expectOk,
  FakeMailProvider,
  FakePushTransport,
  harness,
  seedApp,
} from "./harness";

/*
 * What these tests pin, in order of how much it would cost to get wrong:
 *
 *   1. A notification — mail or push — never carries what the ticket says.
 *      Not the message, not the reporter's comment, not a name, not an
 *      address. It carries a ticket number and a link.
 *   2. Notifying is not part of creating. A mail provider that refuses, a
 *      push service that is down, a transport that throws: the ticket exists
 *      and the caller hears `ok`.
 *   3. A subscription belongs to the operator who registered it. Nobody else
 *      can list it, revoke it, or claim its endpoint.
 */

const requester = {
  email: "kaori.private@example.com",
  name: "佐藤 香織",
  body: "アプリを開くとクラッシュします。口座番号は 1234-5678 です。",
};

async function inquiry(h: Awaited<ReturnType<typeof harness>>, requestId = crypto.randomUUID()) {
  const thread = expectOk<{ id: string }>(
    (await h.support.createThread(
      {
        appSlug: "remeet",
        source: "web_form",
        requesterEmail: requester.email,
        requesterName: requester.name,
        subject: `[bug] ${requestId}`,
        bodyText: requester.body,
        providerMessageId: `form-${requestId}`,
      },
      appActor,
    )) as never,
  );
  await h.settled();
  const ticket = await h.db
    .prepare("SELECT ticket_number FROM tickets WHERE id = ?")
    .bind(thread.id)
    .first<{ ticket_number: string }>();
  return { threadId: thread.id, ticketNumber: ticket?.ticket_number ?? "" };
}

const secrets = [requester.email, requester.name, "クラッシュ", "1234-5678", "kaori", "香織"];

async function subscribe(h: Awaited<ReturnType<typeof harness>>, endpoint: string, actor = admin) {
  return expectOk<{ id: string }>(
    (await h.notifications.register(
      {
        endpoint,
        keys: {
          p256dh:
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
          auth: "BTBZMqHH6r4Tts7J_aSIgg",
        },
        deviceName: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone)",
      },
      actor,
    )) as never,
  );
}

describe("ticket notifications carry a reference, never content", () => {
  it("mails and pushes a ticket number and a link for a new inquiry", async () => {
    const h = await harness({ notifyEmail: "operator@example.com" });
    await seedApp(h);
    await subscribe(h, "https://push.example/a");

    const { ticketNumber } = await inquiry(h);
    expect(ticketNumber).toMatch(/^TK-\d{6}$/);

    expect(h.mail.sent).toHaveLength(1);
    const mail = h.mail.sent[0] as NonNullable<(typeof h.mail.sent)[0]>;
    expect(mail.to).toBe("operator@example.com");
    expect(mail.subject).toBe("[Tomokichi Studio] 新しいお問い合わせがあります");
    expect(mail.text).toContain(`Ticket ID: #${ticketNumber}`);
    expect(mail.text).toContain(`https://admin.tmkch.io/tickets/${ticketNumber}`);
    expect(mail.text).toContain("対象アプリ: remeet");
    expect(mail.replyTo).toBeUndefined();
    for (const secret of secrets) expect(mail.text).not.toContain(secret);
    expect(mail.subject).not.toContain(requester.name);

    expect(h.push.sent).toHaveLength(1);
    const payload = JSON.parse(h.push.sent[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({
      type: "support.ticket.created",
      ticketNumber,
      category: "inquiry",
      app: "remeet",
      url: `/tickets/${ticketNumber}`,
    });
    expect(String(payload.url)).not.toContain("?");
    for (const secret of secrets) expect(h.push.sent[0]?.payload).not.toContain(secret);
  });

  it("says 通報 for a report and leaves the reason, the comment and the reporter out", async () => {
    const h = await harness({ notifyEmail: "operator@example.com" });
    await seedApp(h);
    await subscribe(h, "https://push.example/a");

    const created = expectOk<{ reportId: string }>(
      (await h.reports.create(
        {
          appSlug: "remeet",
          externalReportId: crypto.randomUUID(),
          contentType: "wish",
          contentExternalId: "content-1",
          reporterRefHash: "reporter-raw-id",
          reasonCode: "harassment",
          reporterEmail: "reporter.secret@example.com",
          detail: "この人にしつこく連絡されています",
          snapshotText: "通報された本文そのもの",
          priority: "high",
        },
        appActor,
      )) as never,
    );
    await h.settled();

    // The receipt to the reporter is a different mail; the operator alert is
    // the one addressed to the operator.
    const alert = h.mail.sent.find((mail) => mail.to === "operator@example.com");
    expect(alert).toBeDefined();
    expect(alert?.subject).toBe("[Tomokichi Studio] 新しい通報があります");
    expect(alert?.text).toContain("種別: 通報");
    for (const secret of [
      "harassment",
      "しつこく",
      "通報された本文",
      "reporter.secret",
      "reporter-raw-id",
      "content-1",
      created.reportId,
    ]) {
      expect(alert?.text).not.toContain(secret);
      expect(h.push.sent[0]?.payload).not.toContain(secret);
    }
    expect(JSON.parse(h.push.sent[0]?.payload ?? "{}")).toMatchObject({ category: "report" });
  });

  it("pushes but does not mail when the ticket came in as mail", async () => {
    const h = await harness({ notifyEmail: "operator@example.com" });
    await subscribe(h, "https://push.example/a");
    expectOk(
      (await h.support.ingestInboundEmail(
        {
          from: "someone@example.com",
          to: "support@tmkch.io",
          subject: "質問",
          bodyText: "本文",
          messageId: "<m1@example.com>",
        },
        { type: "email", id: "mail-ingress" },
      )) as never,
    );
    await h.settled();
    expect(h.mail.sent).toHaveLength(0);
    expect(h.push.sent).toHaveLength(1);
  });
});

describe("notification failure is not ticket failure", () => {
  it("creates the ticket and still pushes when the mail provider refuses", async () => {
    const mail = new FakeMailProvider();
    mail.failNext = true;
    const h = await harness({ mail, notifyEmail: "operator@example.com" });
    await seedApp(h);
    await subscribe(h, "https://push.example/a");

    const { threadId } = await inquiry(h);
    expect(
      await h.db.prepare("SELECT id FROM tickets WHERE id = ?").bind(threadId).first(),
    ).not.toBeNull();
    expect(h.mail.sent).toHaveLength(0);
    expect(h.push.sent).toHaveLength(1);
  });

  it("creates the ticket and still mails when the push transport throws", async () => {
    const push = new FakePushTransport();
    push.throwNext = true;
    const h = await harness({ push, notifyEmail: "operator@example.com" });
    await seedApp(h);
    await subscribe(h, "https://push.example/a");

    const { threadId } = await inquiry(h);
    expect(
      await h.db.prepare("SELECT id FROM tickets WHERE id = ?").bind(threadId).first(),
    ).not.toBeNull();
    expect(h.mail.sent).toHaveLength(1);
    // A thrown transport is a failed delivery, not a dead subscription.
    const overview = expectOk<{ devices: unknown[] }>(
      (await h.notifications.overview(admin)) as never,
    );
    expect(overview.devices).toHaveLength(1);
  });

  it("works with no mail channel at all", async () => {
    const h = await harness();
    await seedApp(h);
    await subscribe(h, "https://push.example/a");
    await inquiry(h);
    expect(h.mail.sent).toHaveLength(0);
    expect(h.push.sent).toHaveLength(1);
  });

  it("records one ticket and one notification for a retried form submission", async () => {
    const h = await harness({ notifyEmail: "operator@example.com" });
    await seedApp(h);
    const requestId = crypto.randomUUID();
    const first = await inquiry(h, requestId);
    const second = await inquiry(h, requestId);
    expect(second.threadId).toBe(first.threadId);
    expect(h.mail.sent).toHaveLength(1);
  });
});

describe("dead subscriptions", () => {
  it("revokes a subscription the push service reports gone and keeps the rest", async () => {
    const push = new FakePushTransport();
    push.answers.set("https://push.example/gone", { ok: false, gone: true, status: 410 });
    push.answers.set("https://push.example/busy", {
      ok: false,
      gone: false,
      status: 429,
      reason: "rejected",
    });
    const h = await harness({ push });
    await seedApp(h);
    await subscribe(h, "https://push.example/gone");
    await subscribe(h, "https://push.example/busy");
    await subscribe(h, "https://push.example/fine");

    await inquiry(h);
    expect(push.sent).toHaveLength(3);

    const devices = expectOk<{ devices: Array<{ id: string; lastUsedAt?: string }> }>(
      (await h.notifications.overview(admin)) as never,
    ).devices;
    expect(devices).toHaveLength(2);
    expect(devices.filter((d) => d.lastUsedAt)).toHaveLength(1);

    // The next ticket no longer tries the dead one.
    await inquiry(h);
    expect(push.sent.filter((s) => s.endpoint.endsWith("/gone"))).toHaveLength(1);

    const revoked = await h.db
      .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'push.revoked'")
      .all<{ metadata_json: string }>();
    expect(revoked.results).toHaveLength(1);
    expect(revoked.results[0]?.metadata_json).not.toContain("push.example");
  });

  it("purges subscriptions revoked long ago and keeps recent ones", async () => {
    const h = await harness();
    const device = await subscribe(h, "https://push.example/old");
    await h.db
      .prepare("UPDATE push_subscriptions SET revoked_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(device.id)
      .run();
    const recent = await subscribe(h, "https://push.example/recent");
    expectOk((await h.notifications.revoke({ id: recent.id }, admin)) as never);
    await h.notifications.purgeRevoked();
    const rows = await h.db.prepare("SELECT id FROM push_subscriptions").all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual([recent.id]);
  });
});

describe("settings", () => {
  it("honours the per-category push toggles and the mail toggle", async () => {
    const h = await harness({ notifyEmail: "operator@example.com" });
    await seedApp(h);
    await subscribe(h, "https://push.example/a");
    expectOk(
      (await h.notifications.saveSettings(
        { inquiryPush: false, reportPush: true, emailEnabled: false },
        admin,
      )) as never,
    );

    await inquiry(h);
    expect(h.push.sent).toHaveLength(0);
    expect(h.mail.sent).toHaveLength(0);

    expectOk(
      (await h.reports.create(
        {
          appSlug: "remeet",
          externalReportId: crypto.randomUUID(),
          contentType: "wish",
          contentExternalId: "c",
          reasonCode: "spam",
        },
        appActor,
      )) as never,
    );
    await h.settled();
    expect(h.push.sent).toHaveLength(1);
    expect(h.mail.sent.filter((m) => m.to === "operator@example.com")).toHaveLength(0);
  });

  it("reports whether push is available and validates what it is given", async () => {
    const h = await harness({ push: new FakePushTransport(false) });
    const overview = expectOk<{ pushPublicKey?: string; emailConfigured: boolean }>(
      (await h.notifications.overview(admin)) as never,
    );
    expect(overview.pushPublicKey).toBeUndefined();
    expect(overview.emailConfigured).toBe(false);
    const refused = await h.notifications.register(
      { endpoint: "https://push.example/a", keys: { p256dh: "x", auth: "y" } },
      admin,
    );
    expect(refused.ok).toBe(false);

    const bad = await h.notifications.saveSettings({ inquiryPush: "yes" }, admin);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("a subscription belongs to the operator who registered it", () => {
  const other = { type: "admin", id: "other-operator" } as const;

  it("hides, refuses to revoke, and refuses to reassign another operator's device", async () => {
    const h = await harness();
    const device = await subscribe(h, "https://push.example/mine");

    const theirs = expectOk<{ devices: unknown[] }>(
      (await h.notifications.overview(other)) as never,
    );
    expect(theirs.devices).toEqual([]);

    const byId = await h.notifications.revoke({ id: device.id }, other);
    expect(byId.ok).toBe(false);
    const byEndpoint = await h.notifications.revoke(
      { endpoint: "https://push.example/mine" },
      other,
    );
    expect(byEndpoint.ok).toBe(false);
    if (!byEndpoint.ok) expect(byEndpoint.error.code).toBe("NOT_FOUND");

    const claim = await h.notifications.register(
      {
        endpoint: "https://push.example/mine",
        keys: {
          p256dh:
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
          auth: "BTBZMqHH6r4Tts7J_aSIgg",
        },
      },
      other,
    );
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.error.code).toBe("CONFLICT");

    // Still mine, still one of it.
    const mine = expectOk<{ devices: Array<{ id: string }> }>(
      (await h.notifications.overview(admin)) as never,
    );
    expect(mine.devices.map((d) => d.id)).toEqual([device.id]);
    expectOk(
      (await h.notifications.revoke({ endpoint: "https://push.example/mine" }, admin)) as never,
    );
    expect(
      expectOk<{ devices: unknown[] }>((await h.notifications.overview(admin)) as never).devices,
    ).toEqual([]);
  });

  it("refuses anything that is not a signed-in operator", async () => {
    const h = await harness();
    for (const result of [
      await h.notifications.overview(appActor),
      await h.notifications.saveSettings(
        { inquiryPush: true, reportPush: true, emailEnabled: true },
        appActor,
      ),
      await h.notifications.register(
        {
          endpoint: "https://push.example/a",
          keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
        },
        { type: "system" },
      ),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    }
  });

  it("re-registering the same device replaces its keys rather than adding a row", async () => {
    const h = await harness();
    const first = await subscribe(h, "https://push.example/a");
    const again = await subscribe(h, "https://push.example/a");
    expect(again.id).toBe(first.id);
    const rows = await h.db
      .prepare("SELECT COUNT(*) AS n FROM push_subscriptions")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("writes an audit row for every change, naming the operator and never the endpoint", async () => {
    const h = await harness();
    const device = await subscribe(h, "https://push.example/a");
    expectOk(
      (await h.notifications.saveSettings(
        { inquiryPush: true, reportPush: false, emailEnabled: true },
        admin,
      )) as never,
    );
    expectOk((await h.notifications.revoke({ id: device.id }, admin)) as never);
    const rows = await h.db
      .prepare(
        "SELECT action, actor_id, metadata_json FROM audit_logs WHERE actor_id = ? ORDER BY created_at",
      )
      .bind(admin.id)
      .all<{ action: string; actor_id: string; metadata_json: string }>();
    expect(rows.results.map((r) => r.action)).toEqual([
      "push.subscribed",
      "notification.settings_updated",
      "push.unsubscribed",
    ]);
    for (const row of rows.results) expect(row.metadata_json).not.toContain("push.example");
  });
});
