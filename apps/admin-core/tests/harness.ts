/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import type { RemeetModerationApi } from "@tomokichi/admin-contracts";
import type { MailProvider, MailResult, SupportReplyMail } from "@tomokichi/admin-mail";
import type { PushDeliveryResult, PushSubscriptionTarget } from "@tomokichi/admin-push";
import { AppRepository } from "../src/db/apps";
import { AuditRepository } from "../src/db/audit";
import { NotificationRepository } from "../src/db/notifications";
import { ReportRepository } from "../src/db/reports";
import { SupportRepository } from "../src/db/support";
import { TemplateRepository } from "../src/db/templates";
import { AppService } from "../src/domain/app-service";
import { DashboardService } from "../src/domain/dashboard-service";
import { NotificationService, type PushTransport } from "../src/domain/notification-service";
import { ReplyService } from "../src/domain/reply-service";
import { ReportService } from "../src/domain/report-service";
import { SupportService } from "../src/domain/support-service";
import type { AdminCoreEnv } from "../src/env";

export const testEnv = env as unknown as AdminCoreEnv;

/**
 * Every migration file, in filename order.
 *
 * A glob rather than a list of imports: the suite failed the day a second
 * migration was added, because the harness was still applying only the first
 * and every test met a column that existed in production and not here. A new
 * file is now picked up by existing.
 *
 * `import.meta.glob` is Vite's, which is why `vite` is a declared devDependency
 * of this package rather than something inherited from vitest by accident.
 */
const migrations = Object.entries(
  import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, sql]) => sql as string);

/**
 * Applies the real migration files to the test database.
 *
 * The schema under test is the schema that ships — a hand-written `CREATE
 * TABLE` in a fixture is how a test suite ends up passing against a database
 * that does not exist.
 */
export function splitMigration(sql: string): string[] {
  const statements: string[] = [];
  let buffer = "";
  let trigger = false;
  for (const line of sql.split("\n")) {
    if (line.trimStart().startsWith("--")) continue;
    if (/^CREATE TRIGGER/i.test(line.trim())) trigger = true;
    buffer += `${line}\n`;
    if (trigger) {
      if (line.trim() === "END;") {
        statements.push(buffer.trim());
        buffer = "";
        trigger = false;
      }
    } else if (buffer.includes(";")) {
      const parts = buffer.split(";");
      buffer = parts.pop() ?? "";
      statements.push(...parts.map((part) => part.trim()).filter(Boolean));
    }
  }
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

export async function migrate(): Promise<void> {
  const statements = migrations.flatMap(splitMigration);
  for (const statement of statements) {
    try {
      await testEnv.DB.prepare(statement).run();
    } catch (error) {
      // The schema outlives a single test file, so `migrate` runs against a
      // database that may already be up to date. `CREATE TABLE IF NOT EXISTS`
      // says so itself; `ALTER TABLE ADD COLUMN` has no such spelling and fails
      // the second time. Swallowing exactly that one message keeps the harness
      // idempotent without turning it into something that ignores real schema
      // errors.
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
  await reset();
}

/**
 * Empties every table between tests.
 *
 * The migration is `CREATE TABLE IF NOT EXISTS`, so the schema survives from
 * one test to the next — which is what makes a leftover row from a previous
 * test look like a bug in the one that is running. Deleting in child-first
 * order keeps the foreign keys satisfied on the way down.
 */
export async function reset(): Promise<void> {
  const tables = [
    "ticket_relations",
    "ticket_reports",
    "ticket_events",
    "ticket_messages",
    "ticket_sources",
    "tickets",
    "ticket_numbers",
    "push_subscriptions",
    "admin_notification_settings",
    "service_components",
    "ticket_categories",
    "ticket_assignees",
    "support_thread_redirects",
    "support_reply_sends",
    "support_drafts",
    "support_attachments",
    "support_messages",
    "report_operations",
    "report_attachments",
    "report_events",
    "reports",
    "support_threads",
    "reply_templates",
    "app_mail_settings",
    "app_links",
    "audit_logs",
    "apps",
    "services",
  ];
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM ${table}`)));
  await testEnv.DB.prepare("INSERT INTO services VALUES ('studio','tmkch.io','tmkch-io',1)").run();
}

/**
 * A mail provider that records instead of sending.
 *
 * `sendCount` is the assertion that matters most in this suite: the internal
 * note tests exist to prove it stays at zero.
 */
export class FakeMailProvider implements MailProvider {
  readonly name = "fake";
  sent: SupportReplyMail[] = [];
  failNext = false;

  constructor(readonly configured = true) {}

  get sendCount(): number {
    return this.sent.length;
  }

  private record(mail: SupportReplyMail): Promise<MailResult> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve({ ok: false, code: "REJECTED", detail: "test failure" });
    }
    this.sent.push(mail);
    return Promise.resolve({ ok: true, providerMessageId: `<sent-${this.sent.length}@test>` });
  }

  sendTransactional(mail: SupportReplyMail) {
    return this.record(mail);
  }
  sendSupportReply(mail: SupportReplyMail) {
    return this.record(mail);
  }
  sendAdminNotification(mail: SupportReplyMail) {
    return this.record(mail);
  }
}

/**
 * A push transport that records instead of posting.
 *
 * `answer` decides what the push service "said" for an endpoint; the default
 * is acceptance. `sent` holds the payload exactly as it would have been
 * encrypted, which is what the PII tests read.
 */
export class FakePushTransport implements PushTransport {
  sent: Array<{ endpoint: string; payload: string }> = [];
  answers = new Map<string, PushDeliveryResult>();
  throwNext = false;

  readonly vapid: PushTransport["vapid"];

  /** `configured: false` is an environment with no VAPID keys. */
  constructor(configured = true) {
    this.vapid = configured
      ? { publicKey: "BFAKE-public-key", authorization: () => Promise.resolve("vapid") }
      : undefined;
  }

  send(target: PushSubscriptionTarget, payload: string): Promise<PushDeliveryResult> {
    if (this.throwNext) {
      this.throwNext = false;
      return Promise.reject(new Error("push transport exploded"));
    }
    this.sent.push({ endpoint: target.endpoint, payload });
    return Promise.resolve(this.answers.get(target.endpoint) ?? { ok: true, status: 201 });
  }
}

export interface Harness {
  reports: ReportService;
  support: SupportService;
  reply: ReplyService;
  apps: AppService;
  dashboard: DashboardService;
  audit: AuditRepository;
  mail: FakeMailProvider;
  push: FakePushTransport;
  notifications: NotificationService;
  /** Waits for every notification the services fired so far. Production runs
   * them in `ctx.waitUntil`; here they are collected instead. */
  settled(): Promise<void>;
  db: D1Database;
}

export async function harness(
  options: {
    mail?: FakeMailProvider;
    moderation?: RemeetModerationApi;
    push?: FakePushTransport;
    /** Unset means "no mail channel", like an environment without the Secret. */
    notifyEmail?: string;
  } = {},
): Promise<Harness> {
  await migrate();
  const db = testEnv.DB;
  const appRepo = new AppRepository(db);
  const reportRepo = new ReportRepository(db);
  const supportRepo = new SupportRepository(db);
  const templateRepo = new TemplateRepository(db);
  const auditRepo = new AuditRepository(db);
  const mail = options.mail ?? new FakeMailProvider();
  const push = options.push ?? new FakePushTransport();
  const notifications = new NotificationService(
    db,
    new NotificationRepository(db),
    auditRepo,
    mail,
    push,
    {
      notifyEmail: options.notifyEmail,
      from: "Tomokichi Studio Support <notification@tmkch.io>",
      adminOrigin: "https://admin.tmkch.io",
    },
  );
  const pending: Promise<unknown>[] = [];
  const notify = (ref: Parameters<NotificationService["ticketCreated"]>[0]) => {
    pending.push(notifications.ticketCreated(ref));
  };
  const supportService = new SupportService(db, supportRepo, appRepo, auditRepo, notify);

  const replyService = new ReplyService(
    db,
    supportRepo,
    supportService,
    templateRepo,
    appRepo,
    auditRepo,
    mail,
    {
      supportEmail: "support@tmkch.io",
      fromName: "Tomokichi Studio Support",
      defaultSupportUrl: "https://tmkch.io/support",
    },
  );

  return {
    db,
    mail,
    push,
    notifications,
    settled: async () => {
      await Promise.all(pending.splice(0));
    },
    audit: auditRepo,
    apps: new AppService(db, appRepo, auditRepo),
    reports: new ReportService(
      db,
      reportRepo,
      appRepo,
      auditRepo,
      "test-pepper",
      supportRepo,
      replyService,
      options.moderation,
      notify,
    ),
    support: supportService,
    reply: replyService,
    dashboard: new DashboardService(reportRepo, supportRepo, appRepo, auditRepo),
  };
}

export const admin = { type: "admin", id: "test-admin" } as const;
export const appActor = { type: "app", id: "test-app" } as const;

export function expectOk<T>(result: { ok: boolean } & Record<string, unknown>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return (result as unknown as { value: T }).value;
}

export async function seedApp(h: Harness, slug = "remeet"): Promise<string> {
  const created = await h.apps.create(
    { slug, name: slug, platform: "ios", status: "testflight" },
    admin,
  );
  return expectOk<{ id: string }>(created as never).id;
}
