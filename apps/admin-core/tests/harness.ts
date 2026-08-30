import { env } from "cloudflare:test";
import type { MailProvider, MailResult, SupportReplyMail } from "@tomokichi/admin-mail";
import { AppRepository } from "../src/db/apps";
import { AuditRepository } from "../src/db/audit";
import { ReportRepository } from "../src/db/reports";
import { SupportRepository } from "../src/db/support";
import { TemplateRepository } from "../src/db/templates";
import { AppService } from "../src/domain/app-service";
import { DashboardService } from "../src/domain/dashboard-service";
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
export async function migrate(): Promise<void> {
  const statements = migrations
    .join("\n;\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
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
    "support_reply_sends",
    "support_drafts",
    "support_attachments",
    "support_messages",
    "support_threads",
    "report_attachments",
    "report_events",
    "reports",
    "reply_templates",
    "app_mail_settings",
    "app_links",
    "audit_logs",
    "apps",
  ];
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM ${table}`)));
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

export interface Harness {
  reports: ReportService;
  support: SupportService;
  reply: ReplyService;
  apps: AppService;
  dashboard: DashboardService;
  audit: AuditRepository;
  mail: FakeMailProvider;
  db: D1Database;
}

export async function harness(options: { mail?: FakeMailProvider } = {}): Promise<Harness> {
  await migrate();
  const db = testEnv.DB;
  const appRepo = new AppRepository(db);
  const reportRepo = new ReportRepository(db);
  const supportRepo = new SupportRepository(db);
  const templateRepo = new TemplateRepository(db);
  const auditRepo = new AuditRepository(db);
  const mail = options.mail ?? new FakeMailProvider();
  const supportService = new SupportService(db, supportRepo, appRepo, auditRepo);

  return {
    db,
    mail,
    audit: auditRepo,
    apps: new AppService(db, appRepo, auditRepo),
    reports: new ReportService(db, reportRepo, appRepo, auditRepo, "test-pepper"),
    support: supportService,
    reply: new ReplyService(
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
    ),
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
