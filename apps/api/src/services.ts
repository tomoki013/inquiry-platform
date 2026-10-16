import { fail, parseBranding } from "@inquiry-platform/core";
import type { MailProvider } from "@inquiry-platform/notification/mail";
import { ResendMailProvider, UnconfiguredMailProvider } from "@inquiry-platform/notification/mail";
import { importVapid, sendWebPush, type VapidSigner } from "@inquiry-platform/notification/push";
import { AppRepository } from "./db/apps";
import { AuditRepository } from "./db/audit";
import { NotificationRepository } from "./db/notifications";
import { ReportRepository } from "./db/reports";
import { SupportRepository } from "./db/support";
import { TemplateRepository } from "./db/templates";
import { AppService } from "./domain/app-service";
import { DashboardService } from "./domain/dashboard-service";
import { DeliveryError, DeliveryJobs } from "./domain/delivery-jobs";
import { InboundJobs } from "./domain/inbound-jobs";
import { ModerationRegistry } from "./domain/moderation";
import { NotificationService, type TicketCreatedRef } from "./domain/notification-service";
import { ReplyService } from "./domain/reply-service";
import { ReportService } from "./domain/report-service";
import { findReportReplyThread } from "./domain/report-threading";
import type { Scope } from "./domain/scope";
import { SupportService } from "./domain/support-service";
import { TicketService } from "./domain/ticket-service";
import { findReceiptReplyThread, findTicketReplyThread } from "./domain/ticket-threading";
import type { AdminCoreEnv } from "./env";
import { privateCipher, privateDatabase } from "./privacy/crypto";
import { privateBucket } from "./privacy/files";
import { projectMailResolver } from "./project-mail";
import { aggregateDatabase, ProjectRegistry } from "./storage/database";
import { namespacedSupportKey } from "./storage/files";

// Wiring: every service the entrypoints use, built from the environment.
/**
 * @param schedule Runs notification work outside the caller's result —
 * `ctx.waitUntil` in the Worker. The ticket is committed before this is
 * called, so nothing here can fail it; it only decides whether the caller
 * waits.
 */
function buildLocalServices(
  env: AdminCoreEnv,
  schedule: (work: Promise<unknown>) => void,
  registry?: ProjectRegistry,
) {
  const branding = parseBranding(env.BRANDING);
  const moderation = ModerationRegistry.fromEnv(env.SIGNED_MODERATION, env);
  const apps = new AppRepository(env.DB);
  const reports = new ReportRepository(env.DB);
  const support = new SupportRepository(env.DB);
  const templates = new TemplateRepository(env.DB);
  const audit = new AuditRepository(env.DB);

  // One decision, made once: with no key, every send refuses and every other
  // part of the support API still works.
  const mail: MailProvider = env.MAIL_API_KEY
    ? new ResendMailProvider(env.MAIL_API_KEY, undefined, branding.mailLogo)
    : new UnconfiguredMailProvider();
  const delivery = projectMailResolver(env.PROJECT_MAIL_PROVIDERS, env, mail);

  const vapid = lazyVapid(env);
  const notifications = new NotificationService(
    env.DB,
    new NotificationRepository(env.DB),
    audit,
    mail,
    {
      vapid,
      send: (target, payload) =>
        vapid
          ? sendWebPush(target, payload, vapid)
          : Promise.resolve({ ok: false, gone: false, reason: "payload" }),
    },
    {
      notifyEmail: env.NOTIFICATION_EMAIL,
      from: `${env.SUPPORT_FROM_NAME} <${env.NOREPLY_EMAIL}>`,
      ticketUrlTemplate:
        env.OPERATOR_TICKET_URL_TEMPLATE ?? `${env.ADMIN_ORIGIN}/tickets/{ticketNumber}`,
      resolve: async (appId) => {
        const settings = await templates.mailSettings(appId);
        return {
          mail: delivery(appId).mail,
          notifyEmail: settings.notificationEmail ?? env.NOTIFICATION_EMAIL,
          from: `${settings.fromName ?? env.SUPPORT_FROM_NAME} <${settings.noreplyEmail ?? env.NOREPLY_EMAIL}>`,
          ...(settings.ticketUrlTemplate ? { ticketUrlTemplate: settings.ticketUrlTemplate } : {}),
          ...(settings.notifyByEmail === false ? { emailEnabled: false } : {}),
        };
      },
    },
  );
  let inbound: InboundJobs;
  const jobs = new DeliveryJobs(env.DB, async (row) => {
    if (row.kind === "inbound_email") return inbound.process(row);
    const payload = JSON.parse(row.payload);
    if (row.kind === "failure_alert") {
      const original = await env.DB.prepare(
        "SELECT id,service_id,kind,generation FROM delivery_jobs WHERE id=? AND generation=? AND last_error IS NOT NULL AND state<>'completed'",
      )
        .bind(payload.jobId, payload.generation)
        .first<{ id: string; service_id: string; kind: string; generation: number }>();
      if (original && !(await notifications.failureAlert(original)))
        throw new DeliveryError("ALERT_DELIVERY_FAILED");
      return;
    }
    const channel = row.kind === "notification_email" ? "email" : "push";
    const outcome = await notifications.ticketCreated({
      ...payload,
      deliveryJobId: row.id,
      channels: { email: channel === "email", push: channel === "push" },
    });
    if (outcome.email === "unconfigured" && (await notifications.emailExpected(row.service_id)))
      throw new DeliveryError("MAIL_UNCONFIGURED");
    if (outcome.email === "failed" || outcome.push.failed)
      throw new DeliveryError("NOTIFICATION_FAILED");
  });
  const notify = Object.assign((ref: TicketCreatedRef) => schedule(jobs.enqueueNotification(ref)), {
    statements: (ref: TicketCreatedRef) => jobs.notificationStatements(ref),
  });

  const supportService = new SupportService(env.DB, support, apps, audit, notify);

  inbound = new InboundJobs(
    env,
    jobs,
    supportService,
    support,
    registry ? async (id) => registry.forRecord("message", id) : undefined,
    registry
      ? (message, thread, attachment) => namespacedSupportKey(registry, message, thread, attachment)
      : undefined,
  );

  const replyService = new ReplyService(
    env.DB,
    support,
    supportService,
    templates,
    apps,
    audit,
    mail,
    {
      supportEmail: env.SUPPORT_EMAIL,
      fromName: env.SUPPORT_FROM_NAME,
      defaultSupportUrl: env.DEFAULT_SUPPORT_URL,
      defaultSignature: branding.defaultSignature,
      legacySignatures: branding.legacySignatures,
      resolve: async (appId) => templates.mailSettings(appId),
      delivery,
    },
  );

  return {
    branding,
    jobs,
    inbound,
    moderation,
    apps: new AppService(env.DB, apps, audit),
    reports: new ReportService(
      env.DB,
      reports,
      apps,
      audit,
      env.HASH_PEPPER,
      support,
      replyService,
      moderation,
      notify,
    ),
    support: supportService,
    reply: replyService,
    dashboard: new DashboardService(reports, support, apps, audit),
    audit,
    notifications,
  };
}

/**
 * The VAPID signer, imported on first use.
 *
 * `importVapid` is asynchronous and `buildServices` is not; the public key is
 * known synchronously either way, which is all an API consumer needs before
 * registering a subscription. A malformed private key surfaces as a
 * failed first send in the log, not as a Worker that will not start.
 */
function lazyVapid(env: AdminCoreEnv): VapidSigner | undefined {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return undefined;
  const config = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT ?? `mailto:${env.SUPPORT_EMAIL}`,
  };
  let signer: Promise<VapidSigner> | undefined;
  return {
    publicKey: config.publicKey,
    authorization(endpoint, now) {
      signer ??= importVapid(config);
      return signer.then((ready) => ready.authorization(endpoint, now));
    },
  };
}

/** Route mutations before constructing a repository; aggregate SQL cannot write
 * business data. All routes are server-authored, never selected by request SQL. */
export function buildServices(
  env: AdminCoreEnv,
  schedule: (work: Promise<unknown>) => void,
  scope?: Scope | Promise<Scope>,
) {
  const cipher = privateCipher(env);
  env = {
    ...env,
    DB: privateDatabase(env.DB, cipher),
    PRIVATE_FILES: privateBucket(env.PRIVATE_FILES, cipher),
  };
  const registry = new ProjectRegistry(env.DB, cipher);
  const db = privateDatabase(aggregateDatabase(registry, scope), cipher, "platform", false);
  const base = buildLocalServices({ ...env, DB: db }, schedule, registry);
  const tickets = new TicketService(db, base.moderation);
  const missing = () => fail("NOT_FOUND", "対象が見つかりません。");
  type Selector = (...args: unknown[]) => Promise<D1Database | null>;
  const fieldValue = (input: unknown, field: string): unknown =>
    input && typeof input === "object" ? (input as Record<string, unknown>)[field] : undefined;
  const record =
    (kind: "ticket" | "thread" | "report", field?: string): Selector =>
    async (input) =>
      registry.forRecord(kind, field ? fieldValue(input, field) : input, await scope);
  const slug: Selector = async (input) => registry.forSlug(fieldValue(input, "appSlug"));
  const project: Selector = async (input) =>
    registry.forProject(String(fieldValue(input, "service_id") ?? ""));
  const local = (database: D1Database) => buildLocalServices({ ...env, DB: database }, schedule);
  const inbound: Selector = async (raw) => {
    const input = raw as {
      appSlug?: string;
      from?: string;
      subject?: string;
      bodyText?: string;
      inReplyTo?: string;
      references?: string[];
    } | null;
    if (input?.appSlug || typeof input?.from !== "string") return slug(raw);
    // A shared mailbox may reply to a project thread without a route hint.
    // Resolve only unambiguous references from that thread's requester.
    const candidates = [
      input.inReplyTo,
      ...(Array.isArray(input.references) ? input.references : []),
    ].filter((v): v is string => typeof v === "string");
    for (const candidate of candidates) {
      const rows = await db
        .prepare(
          `SELECT t.id,t.requester_email FROM support_messages m JOIN support_threads t ON t.id=m.thread_id AND t.__project_id=m.__project_id WHERE m.provider_message_id=? LIMIT 64`,
        )
        .bind(candidate)
        .all<{ id: string; requester_email: string }>();
      const matches = rows.results.filter(
        (row) => row.requester_email.trim().toLowerCase() === input.from!.trim().toLowerCase(),
      );
      if (rows.results.length < 64 && matches.length === 1 && matches[0])
        return registry.forRecord("thread", matches[0].id, await scope);
    }
    const reply = {
      from: input.from,
      subject: input.subject ?? "",
      bodyText: input.bodyText ?? "",
    };
    const thread =
      (await findReportReplyThread(db, reply)) ??
      (await findReceiptReplyThread(db, reply)) ??
      (await findTicketReplyThread(db, reply));
    return thread ? registry.forRecord("thread", thread, await scope) : registry.forSlug(undefined);
  };

  // Methods not mentioned here only read aggregate data or modify shared config.
  // Repositories refuse a future business write accidentally left unclassified.
  function route<T extends object>(
    target: T,
    routes: Record<string, Selector>,
    pick: (database: D1Database) => T,
    nullMethods: string[] = [],
  ) {
    for (const [name, select] of Object.entries(routes)) {
      Object.defineProperty(target, name, {
        configurable: true,
        value: async (...args: unknown[]) => {
          try {
            const database = await select(...args);
            if (!database) return nullMethods.includes(name) ? null : missing();
            const service = pick(database);
            const method: unknown = Reflect.get(service, name);
            if (typeof method !== "function") throw new Error("InvalidStorageRoute");
            return await Reflect.apply(method, service, args);
          } catch {
            // Identifiers/configuration failures never fall back to shared tables.
            console.log(JSON.stringify({ event: "storage.route_failed", method: name }));
            if (nullMethods.includes(name)) return null;
            return fail("NOT_FOUND", "Project の保存先を利用できません。");
          }
        },
      });
    }
  }
  route(
    base.support,
    {
      createThread: slug,
      ingestInboundEmail: inbound,
      detail: record("thread"),
      threadForReply: record("thread"),
      addMessage: record("thread", "threadId"),
      addInternalNote: record("thread", "threadId"),
      setStatus: record("thread", "threadId"),
      assignApp: record("thread", "threadId"),
    },
    (database) => local(database).support,
    ["threadForReply"],
  );
  route(
    base.reports,
    {
      create: slug,
      detail: record("report"),
      sendReceipt: record("report"),
      prepareDecision: record("report", "reportId"),
      completeDecision: record("report", "reportId"),
      changeStatus: record("report", "reportId"),
      addNote: record("report", "reportId"),
      updateResolution: record("report", "reportId"),
    },
    (database) => local(database).reports,
  );
  route(
    base.reply,
    {
      send: record("thread", "threadId"),
      getDraft: record("thread"),
      deleteDraft: record("thread"),
      saveDraft: record("thread", "threadId"),
      applyTemplate: record("thread", "threadId"),
      projectReportReceipt: record("thread"),
    },
    (database) => local(database).reply,
  );
  route(
    tickets,
    {
      row: record("ticket"),
      detail: record("ticket"),
      ack: record("ticket"),
      change: record("ticket", "id"),
      note: record("ticket", "id"),
      create: project,
      merge: record("ticket", "id"),
      relation: record("ticket", "id"),
      source: async (kind, id) =>
        registry.forRecord(kind === "report" ? "report" : "thread", id, await scope),
    },
    (database) => new TicketService(database, base.moderation),
    ["row"],
  );

  base.reply.refreshMessageIds = async (threadId?: string) => {
    if (threadId) {
      const database = await registry.forRecord("thread", threadId, await scope);
      if (database) await local(database).reply.refreshMessageIds(threadId);
      return;
    }
    // Query once through aggregate storage; route each update by message owner.
    const rows = await db
      .prepare(
        "SELECT id FROM support_messages WHERE provider_message_id IS NULL AND transport_id IS NOT NULL ORDER BY message_id_checked_at,created_at DESC LIMIT 50",
      )
      .all<{ id: string }>();
    for (const row of rows.results) {
      const database = await registry.forRecord("message", row.id, await scope);
      if (!database) continue;
      const thread = await new SupportRepository(database).messageThreadId(row.id);
      if (thread) await local(database).reply.refreshMessageIds(thread);
    }
  };
  base.reports.retryReceipts = async () => {
    const rows = await db
      .prepare(
        `SELECT r.id FROM reports r JOIN support_threads t ON t.id=r.support_thread_id AND t.__project_id=r.__project_id WHERE t.requester_email<>'' AND t.status='open' AND NOT EXISTS(SELECT 1 FROM support_reply_sends s WHERE s.idempotency_key='report-receipt-'||r.id AND s.__project_id=r.__project_id) ORDER BY r.created_at LIMIT 25`,
      )
      .all<{ id: string }>();
    for (const row of rows.results) await base.reports.sendReceipt(row.id);
  };
  return { ...base, tickets, db, registry };
}
