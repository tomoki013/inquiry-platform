import type {
  ActorRef,
  NotificationOutcome,
  NotificationOverview,
  NotificationSettings,
  PushDeviceSummary,
  PushPayload,
  Result,
  TicketNotificationCategory,
  TicketNotificationEvent,
} from "@tomokichi/admin-contracts";
import {
  fail,
  newId,
  notificationSettingsSchema,
  nowIso,
  ok,
  registerPushSubscriptionInputSchema,
  revokePushSubscriptionInputSchema,
} from "@tomokichi/admin-contracts";
import type { BaseMail, MailProvider } from "@tomokichi/admin-mail";
import type {
  PushDeliveryResult,
  PushSubscriptionTarget,
  VapidSigner,
} from "@tomokichi/admin-push";
import type { AuditRepository } from "../db/audit";
import type { DeliverableSubscription, NotificationRepository } from "../db/notifications";
import { internalFailure, notFound, validationFailure } from "./failures";

/**
 * What a ticket-creating service hands the notifier: an id and a kind.
 *
 * Not the ticket, not the thread, not the input that made it. The notifier
 * reads the ticket *number* and the app's name back from the database itself
 * and that is the whole of what it learns.
 */
export interface TicketCreatedRef {
  ticketId: string;
  category: TicketNotificationCategory;
  /** Both on by default. Inbound mail turns email off: the operator already
   * has the mail itself. */
  channels?: { email?: boolean; push?: boolean };
}

/**
 * Fire-and-forget, from a service's point of view.
 *
 * A service calls this after its batch committed and moves on. Whatever the
 * notifier does happens outside the caller's result, so a mail provider being
 * down or a push service being slow can neither fail nor delay the ticket. In
 * production this is `ctx.waitUntil`; in tests it collects the promises so
 * they can be awaited.
 */
export type NotificationHook = (ref: TicketCreatedRef) => void;

export interface NotificationConfig {
  /** Where the operator alert goes. A Secret. Unset means no mail channel. */
  notifyEmail?: string;
  /** `Name <address>` the alert is sent from. */
  from: string;
  /** `https://admin.tmkch.io` — for the link in the mail. */
  adminOrigin: string;
}

export interface PushTransport {
  vapid?: VapidSigner;
  send(target: PushSubscriptionTarget, payload: string): Promise<PushDeliveryResult>;
}

const PURGE_AFTER_DAYS = 30;

/** The path a notification points at. Ticket number only; no query string. */
export function ticketPath(ticketNumber: string): string {
  return `/tickets/${encodeURIComponent(ticketNumber)}`;
}

const categoryNoun: Record<TicketNotificationCategory, string> = {
  inquiry: "お問い合わせ",
  report: "通報",
};

/**
 * The operator mail, rendered from the event and nothing else.
 *
 * A pure function of {@link TicketNotificationEvent} so the test can prove
 * the property that matters: whatever the ticket says, the mail cannot say
 * it, because the mail was never given it.
 */
export function renderTicketNotificationMail(
  event: TicketNotificationEvent,
  config: Pick<NotificationConfig, "from" | "adminOrigin"> & { to: string },
): BaseMail {
  const noun = categoryNoun[event.category];
  const received = new Date(event.createdAt).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const link = `${config.adminOrigin}${ticketPath(event.ticketNumber)}`;
  return {
    to: config.to,
    from: config.from,
    subject: `[Tomokichi Studio] 新しい${noun}があります`,
    text: [
      `新しい${noun}を受信しました。`,
      "",
      `種別: ${noun}`,
      `対象アプリ: ${event.app}`,
      `受付日時: ${received}`,
      `Ticket ID: #${event.ticketNumber}`,
      "",
      "管理画面で確認",
      link,
      "",
      "このメールは通知のみです。内容は管理画面でご確認ください。",
    ].join("\n"),
    idempotencyKey: `ticket-notify-${event.ticketId}`,
  };
}

export function renderPushPayload(event: TicketNotificationEvent): PushPayload {
  return {
    type: "support.ticket.created",
    ticketNumber: event.ticketNumber,
    category: event.category,
    app: event.app,
    url: ticketPath(event.ticketNumber),
  };
}

export class NotificationService {
  constructor(
    private readonly db: D1Database,
    private readonly repo: NotificationRepository,
    private readonly audit: AuditRepository,
    private readonly mail: MailProvider,
    private readonly push: PushTransport,
    private readonly config: NotificationConfig,
  ) {}

  get pushConfigured(): boolean {
    return Boolean(this.push.vapid);
  }

  // ---- Fan-out ----------------------------------------------------------

  /**
   * Notifies every channel about a ticket that already exists.
   *
   * Never throws and never returns a failure: the caller has already
   * committed, and there is nothing it could do with one. Each channel is
   * tried regardless of the others; the outcome is counts for the log.
   */
  async ticketCreated(ref: TicketCreatedRef): Promise<NotificationOutcome> {
    const outcome: NotificationOutcome = {
      email: "disabled",
      push: { attempted: 0, delivered: 0, revoked: 0, failed: 0 },
    };
    let event: TicketNotificationEvent | null = null;
    try {
      event = await this.eventFor(ref);
    } catch (error) {
      internalFailure("notification.lookup", error);
    }
    if (!event) return outcome;

    const channels = { email: true, push: true, ...ref.channels };
    const [email, push] = await Promise.all([
      channels.email ? this.sendEmail(event) : Promise.resolve("disabled" as const),
      channels.push ? this.sendPush(event) : Promise.resolve(outcome.push),
    ]);
    outcome.email = email;
    outcome.push = push;
    console.log(
      JSON.stringify({
        event: "notification.ticket_created",
        category: event.category,
        email: outcome.email,
        ...outcome.push,
      }),
    );
    return outcome;
  }

  private async eventFor(ref: TicketCreatedRef): Promise<TicketNotificationEvent | null> {
    const row = await this.db
      .prepare(
        `SELECT t.ticket_number, t.created_at, s.name AS app FROM tickets t
         JOIN services s ON s.id = t.service_id WHERE t.id = ?`,
      )
      .bind(ref.ticketId)
      .first<{ ticket_number: string; created_at: string; app: string }>();
    if (!row) return null;
    return {
      type: "support.ticket.created",
      ticketId: ref.ticketId,
      ticketNumber: row.ticket_number,
      category: ref.category,
      app: row.app,
      createdAt: row.created_at,
    };
  }

  private async sendEmail(event: TicketNotificationEvent): Promise<NotificationOutcome["email"]> {
    if (!this.config.notifyEmail || !this.mail.configured) return "unconfigured";
    try {
      if (!(await this.repo.emailWanted())) return "disabled";
      const result = await this.mail.sendAdminNotification(
        renderTicketNotificationMail(event, {
          to: this.config.notifyEmail,
          from: this.config.from,
          adminOrigin: this.config.adminOrigin,
        }),
      );
      if (!result.ok) {
        console.log(JSON.stringify({ event: "notification.email_failed", code: result.code }));
        return "failed";
      }
      return "sent";
    } catch (error) {
      internalFailure("notification.email", error);
      return "failed";
    }
  }

  private async sendPush(event: TicketNotificationEvent): Promise<NotificationOutcome["push"]> {
    const counts = { attempted: 0, delivered: 0, revoked: 0, failed: 0 };
    if (!this.push.vapid) return counts;
    let targets: DeliverableSubscription[];
    try {
      targets = (await this.repo.deliverable()).filter((row) =>
        event.category === "inquiry" ? row.inquiry_push === 1 : row.report_push === 1,
      );
    } catch (error) {
      internalFailure("notification.push_lookup", error);
      return counts;
    }
    const payload = JSON.stringify(renderPushPayload(event));
    const at = nowIso();
    await Promise.all(
      targets.map(async (row) => {
        counts.attempted += 1;
        let result: PushDeliveryResult;
        try {
          result = await this.push.send(
            { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
            payload,
          );
        } catch {
          result = { ok: false, gone: false, reason: "transport" };
        }
        try {
          if (result.ok) {
            counts.delivered += 1;
            await this.repo.markUsed(row.id, at);
          } else if (result.gone) {
            counts.revoked += 1;
            await this.db.batch([
              this.repo.revokeStatement(row.id, at),
              this.audit.statement({
                actor: { type: "system", id: "push-delivery" },
                action: "push.revoked",
                targetType: "system",
                targetId: row.admin_user_id,
                metadata: { subscriptionId: row.id, status: result.status ?? 0 },
              }),
            ]);
          } else {
            counts.failed += 1;
          }
        } catch (error) {
          internalFailure("notification.push_record", error);
        }
      }),
    );
    return counts;
  }

  /** Cron: drop subscriptions revoked long enough ago that nobody will
   * re-register them. */
  async purgeRevoked(): Promise<void> {
    const before = new Date(Date.now() - PURGE_AFTER_DAYS * 86_400_000).toISOString();
    try {
      await this.repo.purgeRevoked(before);
    } catch (error) {
      internalFailure("notification.purge", error);
    }
  }

  // ---- Settings and devices ---------------------------------------------

  private ownerOf(actor: ActorRef): string | null {
    return actor.type === "admin" && actor.id ? actor.id : null;
  }

  async overview(actor: ActorRef): Promise<Result<NotificationOverview>> {
    const owner = this.ownerOf(actor);
    if (!owner) return fail("FORBIDDEN", "運営アカウントでサインインしてください。");
    try {
      return ok({
        pushPublicKey: this.push.vapid?.publicKey,
        emailConfigured: Boolean(this.config.notifyEmail) && this.mail.configured,
        settings: await this.repo.settings(owner),
        devices: await this.repo.devices(owner),
      });
    } catch (error) {
      return internalFailure("notification.overview", error);
    }
  }

  async saveSettings(raw: unknown, actor: ActorRef): Promise<Result<NotificationSettings>> {
    const owner = this.ownerOf(actor);
    if (!owner) return fail("FORBIDDEN", "運営アカウントでサインインしてください。");
    const parsed = notificationSettingsSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      await this.db.batch([
        this.repo.saveSettingsStatement(owner, parsed.data, nowIso()),
        this.audit.statement({
          actor,
          action: "notification.settings_updated",
          targetType: "system",
          targetId: owner,
          metadata: { ...parsed.data },
        }),
      ]);
      return ok(await this.repo.settings(owner));
    } catch (error) {
      return internalFailure("notification.saveSettings", error);
    }
  }

  async register(raw: unknown, actor: ActorRef): Promise<Result<PushDeviceSummary>> {
    const owner = this.ownerOf(actor);
    if (!owner) return fail("FORBIDDEN", "運営アカウントでサインインしてください。");
    if (!this.push.vapid) return fail("CONFLICT", "この環境ではPush通知を利用できません。");
    const parsed = registerPushSubscriptionInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    const input = parsed.data;
    try {
      // The endpoint identifies a device. Somebody else's device cannot be
      // claimed by presenting its endpoint — that is refused, not reassigned.
      const existing = await this.repo.findByEndpoint(input.endpoint);
      if (existing && existing.admin_user_id !== owner) {
        return fail("CONFLICT", "この端末は別のアカウントで登録されています。");
      }
      const id = existing?.id ?? newId();
      const at = nowIso();
      await this.db.batch([
        this.repo.upsertStatement({
          id,
          adminUserId: owner,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent: input.userAgent,
          deviceName: input.deviceName,
          at,
        }),
        this.audit.statement({
          actor,
          action: existing ? "push.resubscribed" : "push.subscribed",
          targetType: "system",
          targetId: owner,
          // The id, never the endpoint: `assertSafeAuditMetadata` refuses it.
          metadata: { subscriptionId: id },
        }),
      ]);
      const device = (await this.repo.devices(owner)).find((row) => row.id === id);
      return device ? ok(device) : notFound("端末");
    } catch (error) {
      return internalFailure("notification.register", error);
    }
  }

  async revoke(raw: unknown, actor: ActorRef): Promise<Result<null>> {
    const owner = this.ownerOf(actor);
    if (!owner) return fail("FORBIDDEN", "運営アカウントでサインインしてください。");
    const parsed = revokePushSubscriptionInputSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    try {
      const row =
        "id" in parsed.data
          ? await this.repo.findOwned(parsed.data.id, owner)
          : await this.repo.findByEndpoint(parsed.data.endpoint);
      // A device that is not the caller's is "not found", whichever way it was
      // named — the answer must not say whether the endpoint exists.
      if (!row || row.admin_user_id !== owner) return notFound("端末");
      if (row.revoked_at) return ok(null);
      await this.db.batch([
        this.repo.revokeStatement(row.id, nowIso()),
        this.audit.statement({
          actor,
          action: "push.unsubscribed",
          targetType: "system",
          targetId: owner,
          metadata: { subscriptionId: row.id },
        }),
      ]);
      return ok(null);
    } catch (error) {
      return internalFailure("notification.revoke", error);
    }
  }
}
