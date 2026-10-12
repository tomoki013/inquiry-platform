import { beforeEach, expect, it } from "vitest";
import { AppRepository } from "../src/db/apps";
import { SupportRepository } from "../src/db/support";
import { DeliveryJobs } from "../src/domain/delivery-jobs";
import { InboundJobs } from "../src/domain/inbound-jobs";
import { Scope } from "../src/domain/scope";
import { SupportService } from "../src/domain/support-service";
import { admin, type Harness, harness, testEnv } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await harness();
  const leftovers = await testEnv.PRIVATE_FILES.list({ prefix: "inbound-jobs/" });
  if (leftovers.objects.length)
    await testEnv.PRIVATE_FILES.delete(leftovers.objects.map((row) => row.key));
});
const raw = new TextEncoder().encode(
  [
    "From: Reader <reader@example.com>",
    "To: support@example.com",
    "Subject: private subject",
    "Message-ID: <persisted@example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "private question",
  ].join("\r\n"),
);

it("claims once when two workers race and allows only the lease owner to finish", async () => {
  let count = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const jobs = new DeliveryJobs(h.db, async () => {
    count++;
    await blocked;
  });
  await jobs.statement("job-one", "unassigned", "notification_email", {}).run();
  const first = jobs.run("job-one");
  while (!count) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(await jobs.run("job-one")).toBe(false);
  release();
  await first;
  expect(count).toBe(1);
  expect(
    (await h.db.prepare("SELECT state FROM delivery_jobs WHERE id=?").bind("job-one").first())
      ?.state,
  ).toBe("completed");
});

it("backs off, records terminal failure, exposes no content and audits manual retry", async () => {
  let clock = Date.now();
  let failed = true;
  const jobs = new DeliveryJobs(
    h.db,
    async () => {
      if (failed) throw new Error("reader@example.com private question");
    },
    () => clock,
  );
  await jobs
    .statement("private-job", "unassigned", "notification_email", {
      body: "private question",
      recipient: "reader@example.com",
    })
    .run();
  await jobs.run("private-job");
  expect(await jobs.run("private-job")).toBe(false);
  for (let attempt = 1; attempt < 8; attempt++) {
    clock += 24 * 3600_000;
    await jobs.run("private-job");
  }
  const view = await jobs.list(Scope.all);
  expect(view.ok).toBe(true);
  if (!view.ok) throw new Error("list");
  const row = view.value.items.find((row) => row.id === "private-job")!;
  expect(row.state).toBe("failed");
  expect(row.attempts).toBe(8);
  expect(row.lastError).toBe("INTERNAL_ERROR");
  expect(JSON.stringify(view)).not.toContain("private question");
  expect(JSON.stringify(view)).not.toContain("reader@example.com");
  expect(
    (
      await h.db
        .prepare("SELECT count(*) AS n FROM delivery_jobs WHERE kind='failure_alert'")
        .first()
    )?.n,
  ).toBe(1);
  expect((await jobs.retry("private-job", Scope.service("another-project"), admin)).ok).toBe(false);
  expect((await jobs.retry("private-job", Scope.all, admin)).ok).toBe(true);
  expect(
    (
      await h.db
        .prepare("SELECT count(*) AS n FROM audit_logs WHERE action='delivery.retried'")
        .first()
    )?.n,
  ).toBe(1);
  failed = false;
  await jobs.run("private-job");
  expect(
    await h.db
      .prepare("SELECT state,payload FROM delivery_jobs WHERE id=?")
      .bind("private-job")
      .first(),
  ).toMatchObject({ state: "completed", payload: "{}" });
});

it("persists notification intents in the transaction creating the ticket", async () => {
  const jobs = new DeliveryJobs(h.db, async () => {});
  const notify = Object.assign(() => {}, {
    statements: (ref: { ticketId: string; category: string }) => jobs.notificationStatements(ref),
  });
  const service = new SupportService(
    h.db,
    new SupportRepository(h.db),
    new AppRepository(h.db),
    h.audit,
    notify,
  );
  const input = {
    requesterEmail: "reader@example.com",
    subject: "private subject",
    bodyText: "private question",
    source: "web_form",
    providerMessageId: "one-submit",
  };
  expect((await service.createThread(input, admin)).ok).toBe(true);
  expect((await service.createThread(input, admin)).ok).toBe(true);
  expect(
    (
      await h.db
        .prepare("SELECT count(*) AS n FROM delivery_jobs WHERE kind LIKE 'notification_%'")
        .first()
    )?.n,
  ).toBe(2);
});

it("recovers a raw-mail orphan and deduplicates replay without forwarding again", async () => {
  let inbound!: InboundJobs;
  const jobs = new DeliveryJobs(h.db, (row) => inbound.process(row));
  inbound = new InboundJobs(testEnv, jobs, h.support, new SupportRepository(h.db));
  const response = await inbound.store(
    new Request("https://internal.invalid/internal/mail-ingress/raw", {
      method: "PUT",
      headers: { "X-Mail-To": "support@example.com" },
      body: raw,
    }),
  );
  expect(response.status).toBe(202);
  const { jobId } = (await response.json()) as { jobId: string };
  await h.db.prepare("DELETE FROM delivery_jobs WHERE id=?").bind(jobId).run();
  await inbound.reconcile();
  await jobs.run(jobId);
  expect((await h.db.prepare("SELECT count(*) AS n FROM support_messages").first())?.n).toBe(1);
  expect(
    (await h.db.prepare("SELECT state FROM delivery_jobs WHERE id=?").bind(jobId).first())?.state,
  ).toBe("completed");
  expect((await testEnv.PRIVATE_FILES.list({ prefix: "inbound-jobs/" })).objects).toHaveLength(0);
  expect(
    (
      await inbound.store(
        new Request("https://internal.invalid/internal/mail-ingress/raw", {
          method: "PUT",
          headers: { "X-Mail-To": "support@example.com" },
          body: raw,
        }),
      )
    ).status,
  ).toBe(202);
  await jobs.run(jobId);
  expect((await h.db.prepare("SELECT count(*) AS n FROM support_messages").first())?.n).toBe(1);
});

it("keeps raw mail on parsing failure and never reveals it in the failure list", async () => {
  let inbound!: InboundJobs;
  const jobs = new DeliveryJobs(h.db, (row) => inbound.process(row));
  inbound = new InboundJobs(testEnv, jobs, h.support, new SupportRepository(h.db));
  const response = await inbound.store(
    new Request("https://internal.invalid/internal/mail-ingress/raw", {
      method: "PUT",
      headers: { "X-Mail-To": "support@example.com" },
      body: "not a usable mail",
    }),
  );
  const { jobId } = (await response.json()) as { jobId: string };
  await jobs.run(jobId);
  const row = await h.db
    .prepare("SELECT last_error FROM delivery_jobs WHERE id=?")
    .bind(jobId)
    .first();
  expect(row?.last_error).toBe("MAIL_SENDER_MISSING");
  expect((await testEnv.PRIVATE_FILES.list({ prefix: "inbound-jobs/" })).objects).toHaveLength(1);
  expect(JSON.stringify(await jobs.list(Scope.all))).not.toContain("not a usable mail");
});

it("fences an expired worker and never attempts a crashed job more than eight times", async () => {
  let clock = Date.now(),
    calls = 0,
    release!: () => void,
    start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const jobs = new DeliveryJobs(
    h.db,
    async () => {
      calls++;
      if (calls === 1) {
        start();
        await blocked;
        throw new Error("old worker");
      }
    },
    () => clock,
  );
  await jobs.statement("lease-job", "unassigned", "notification_email", {}).run();
  const stale = jobs.run("lease-job");
  await started;
  clock += 11 * 60_000;
  await jobs.run("lease-job");
  release();
  await stale;
  expect(
    await h.db
      .prepare("SELECT state,last_error,attempts FROM delivery_jobs WHERE id=?")
      .bind("lease-job")
      .first(),
  ).toMatchObject({ state: "completed", last_error: null, attempts: 2 });
  await jobs.statement("crashed-job", "unassigned", "notification_email", {}).run();
  await h.db
    .prepare(
      "UPDATE delivery_jobs SET state='running',attempts=8,lease_until='2020-01-01' WHERE id='crashed-job'",
    )
    .run();
  await jobs.run("crashed-job");
  expect(calls).toBe(2);
  expect(
    await h.db
      .prepare("SELECT state,last_error,attempts FROM delivery_jobs WHERE id='crashed-job'")
      .first(),
  ).toMatchObject({ state: "failed", last_error: "LEASE_EXPIRED", attempts: 8 });
});

it("reconstructs a lost alert intent and keeps its deduplication marker until recovery", async () => {
  const jobs = new DeliveryJobs(h.db, async () => {});
  await jobs.statement("failed-one", "unassigned", "notification_email", {}).run();
  await h.db
    .prepare(
      "UPDATE delivery_jobs SET state='failed',last_error='INTERNAL_ERROR' WHERE id='failed-one'",
    )
    .run();
  await jobs.drain();
  await h.db
    .prepare("UPDATE delivery_jobs SET completed_at='2020-01-01' WHERE id='alert-failed-one-0'")
    .run();
  await jobs.purge();
  await jobs.drain();
  expect(
    (
      await h.db
        .prepare("SELECT count(*) AS n FROM delivery_jobs WHERE kind='failure_alert'")
        .first()
    )?.n,
  ).toBe(1);
  expect(
    (await h.db.prepare("SELECT state FROM delivery_jobs WHERE id='alert-failed-one-0'").first())
      ?.state,
  ).toBe("completed");
  const retries = await Promise.all([
    jobs.retry("failed-one", Scope.all, admin),
    jobs.retry("failed-one", Scope.all, admin),
  ]);
  expect(retries.filter((result) => result.ok)).toHaveLength(1);
  expect(
    (
      await h.db
        .prepare("SELECT count(*) AS n FROM audit_logs WHERE action='delivery.retried'")
        .first()
    )?.n,
  ).toBe(1);
});

it("expires an orphan without exposing its raw content or allowing a destructive retry", async () => {
  const jobs = new DeliveryJobs(h.db, async () => {});
  const inbound = new InboundJobs(testEnv, jobs, h.support, new SupportRepository(h.db));
  const response = await inbound.store(
    new Request("https://internal.invalid/internal/mail-ingress/raw", {
      method: "PUT",
      headers: { "X-Mail-To": "support@example.com" },
      body: raw,
    }),
  );
  const { jobId } = (await response.json()) as { jobId: string };
  const key = "inbound-jobs/" + jobId;
  const object = (await testEnv.PRIVATE_FILES.head(key))!;
  await testEnv.PRIVATE_FILES.put(key, raw, {
    customMetadata: { ...object.customMetadata, createdAt: "2020-01-01T00:00:00.000Z" },
  });
  await h.db.prepare("DELETE FROM delivery_jobs WHERE id=?").bind(jobId).run();
  await inbound.reconcile();
  expect(await testEnv.PRIVATE_FILES.head(key)).toBeNull();
  expect(
    await h.db
      .prepare("SELECT state,last_error,payload FROM delivery_jobs WHERE id=?")
      .bind(jobId)
      .first(),
  ).toMatchObject({ state: "failed", last_error: "MAIL_EXPIRED", payload: "{}" });
  expect(await jobs.retry(jobId, Scope.all, admin)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
});

it("does not let a removed project block orphan recovery or the retention deadline", async () => {
  const jobs = new DeliveryJobs(h.db, async () => {});
  const inbound = new InboundJobs(testEnv, jobs, h.support, new SupportRepository(h.db));
  await expect(
    inbound.store(
      new Request("https://internal.invalid/internal/mail-ingress/raw", {
        method: "PUT",
        headers: { "X-Mail-To": "support@example.com", "X-Mail-Project": "removed" },
        body: raw,
      }),
    ),
  ).rejects.toThrow("PROJECT_UNAVAILABLE");
  const [orphan] = (await testEnv.PRIVATE_FILES.list({ prefix: "inbound-jobs/" })).objects;
  if (!orphan) throw new Error("raw original missing");
  await inbound.store(
    new Request("https://internal.invalid/internal/mail-ingress/raw", {
      method: "PUT",
      headers: { "X-Mail-To": "another@example.com" },
      body: raw,
    }),
  );
  await inbound.reconcile();
  expect(
    (
      await h.db
        .prepare("SELECT count(*) AS n FROM delivery_jobs WHERE kind='inbound_email'")
        .first()
    )?.n,
  ).toBe(1);
  const meta = (await testEnv.PRIVATE_FILES.head(orphan.key))!.customMetadata;
  await testEnv.PRIVATE_FILES.put(orphan.key, raw, {
    customMetadata: { ...meta, createdAt: "2020-01-01T00:00:00.000Z" },
  });
  await inbound.reconcile();
  expect(await testEnv.PRIVATE_FILES.head(orphan.key)).toBeNull();
  expect(
    (
      await h.db
        .prepare("SELECT count(*) AS n FROM delivery_jobs WHERE last_error='MAIL_EXPIRED'")
        .first()
    )?.n,
  ).toBe(1);
});
