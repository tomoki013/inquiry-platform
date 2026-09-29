import { parseBranding } from "@inquiry-platform/core";
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
import { ModerationRegistry } from "./domain/moderation";
import { NotificationService, type TicketCreatedRef } from "./domain/notification-service";
import { ReplyService } from "./domain/reply-service";
import { ReportService } from "./domain/report-service";
import { SupportService } from "./domain/support-service";
import type { AdminCoreEnv } from "./env";

// Wiring: every service the entrypoints use, built from the environment.
/**
 * @param schedule Runs notification work outside the caller's result —
 * `ctx.waitUntil` in the Worker. The ticket is committed before this is
 * called, so nothing here can fail it; it only decides whether the caller
 * waits.
 */
export function buildServices(env: AdminCoreEnv, schedule: (work: Promise<unknown>) => void) {
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
          notifyEmail: settings.notificationEmail ?? env.NOTIFICATION_EMAIL,
          from: `${settings.fromName ?? env.SUPPORT_FROM_NAME} <${settings.noreplyEmail ?? env.NOREPLY_EMAIL}>`,
          ...(settings.ticketUrlTemplate ? { ticketUrlTemplate: settings.ticketUrlTemplate } : {}),
        };
      },
    },
  );
  const notify = (ref: TicketCreatedRef) => schedule(notifications.ticketCreated(ref));

  const supportService = new SupportService(env.DB, support, apps, audit, notify);

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
    },
  );

  return {
    branding,
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
