import type { NotificationSettings, PushDeviceSummary } from "@tomokichi/admin-contracts";
import { defaultNotificationSettings } from "@tomokichi/admin-contracts";

export interface SubscriptionRow {
  id: string;
  admin_user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** A live subscription with its owner's preferences, for the fan-out. */
export interface DeliverableSubscription extends SubscriptionRow {
  inquiry_push: number;
  report_push: number;
}

interface SettingsRow {
  admin_user_id: string;
  inquiry_push: number;
  report_push: number;
  email_enabled: number;
}

/**
 * Push subscriptions and notification settings.
 *
 * Two shapes leave this class: {@link PushDeviceSummary}, which is what a
 * browser is allowed to see, and {@link DeliverableSubscription}, which is
 * what the notifier needs and which never goes anywhere else. There is no
 * method that returns an endpoint to a caller that asked by device id — the
 * only readers of `endpoint` are the fan-out and the owner check on revoke.
 */
export class NotificationRepository {
  constructor(private readonly db: D1Database) {}

  async settings(adminUserId: string): Promise<NotificationSettings> {
    const row = await this.db
      .prepare("SELECT * FROM admin_notification_settings WHERE admin_user_id = ?")
      .bind(adminUserId)
      .first<SettingsRow>();
    return row
      ? {
          inquiryPush: row.inquiry_push === 1,
          reportPush: row.report_push === 1,
          emailEnabled: row.email_enabled === 1,
        }
      : { ...defaultNotificationSettings };
  }

  saveSettingsStatement(
    adminUserId: string,
    settings: NotificationSettings,
    at: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO admin_notification_settings (admin_user_id, inquiry_push, report_push, email_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(admin_user_id) DO UPDATE SET
           inquiry_push = excluded.inquiry_push,
           report_push = excluded.report_push,
           email_enabled = excluded.email_enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(
        adminUserId,
        settings.inquiryPush ? 1 : 0,
        settings.reportPush ? 1 : 0,
        settings.emailEnabled ? 1 : 0,
        at,
      );
  }

  /**
   * Whether the operator mail should go.
   *
   * With nobody having saved settings it goes; once anybody has, it goes if
   * at least one operator still wants it. There is one address and one
   * operator today, so this is exactly the toggle on the screen.
   */
  async emailWanted(): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(email_enabled) AS enabled FROM admin_notification_settings",
      )
      .first<{ total: number; enabled: number | null }>();
    return !row || row.total === 0 || (row.enabled ?? 0) > 0;
  }

  async deliverable(): Promise<DeliverableSubscription[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.*, COALESCE(n.inquiry_push, 1) AS inquiry_push, COALESCE(n.report_push, 1) AS report_push
         FROM push_subscriptions s
         LEFT JOIN admin_notification_settings n ON n.admin_user_id = s.admin_user_id
         WHERE s.revoked_at IS NULL
         ORDER BY s.created_at`,
      )
      .all<DeliverableSubscription>();
    return results;
  }

  async findByEndpoint(endpoint: string): Promise<SubscriptionRow | null> {
    return await this.db
      .prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?")
      .bind(endpoint)
      .first<SubscriptionRow>();
  }

  async findOwned(id: string, adminUserId: string): Promise<SubscriptionRow | null> {
    return await this.db
      .prepare("SELECT * FROM push_subscriptions WHERE id = ? AND admin_user_id = ?")
      .bind(id, adminUserId)
      .first<SubscriptionRow>();
  }

  async devices(adminUserId: string): Promise<PushDeviceSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, device_name, user_agent, created_at, last_used_at FROM push_subscriptions
         WHERE admin_user_id = ? AND revoked_at IS NULL ORDER BY created_at`,
      )
      .bind(adminUserId)
      .all<
        Pick<SubscriptionRow, "id" | "device_name" | "user_agent" | "created_at" | "last_used_at">
      >();
    return results.map((row) => ({
      id: row.id,
      deviceName: row.device_name ?? undefined,
      userAgent: row.user_agent ?? undefined,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
    }));
  }

  /** A re-subscribe from the same device (same endpoint, possibly new keys)
   * replaces the keys and un-revokes rather than creating a second row. */
  upsertStatement(values: {
    id: string;
    adminUserId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string;
    deviceName?: string;
    at: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO push_subscriptions
           (id, admin_user_id, endpoint, p256dh, auth, user_agent, device_name, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent,
           device_name = COALESCE(excluded.device_name, push_subscriptions.device_name),
           revoked_at = NULL
         WHERE push_subscriptions.admin_user_id = excluded.admin_user_id`,
      )
      .bind(
        values.id,
        values.adminUserId,
        values.endpoint,
        values.p256dh,
        values.auth,
        values.userAgent ?? null,
        values.deviceName ?? null,
        values.at,
      );
  }

  revokeStatement(id: string, at: string): D1PreparedStatement {
    return this.db
      .prepare("UPDATE push_subscriptions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(at, id);
  }

  async markUsed(id: string, at: string): Promise<void> {
    await this.db
      .prepare("UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?")
      .bind(at, id)
      .run();
  }

  /** Revoked rows are kept briefly so a device that re-registers keeps its
   * name, then dropped: a dead endpoint is not worth holding on to. */
  async purgeRevoked(before: string): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM push_subscriptions WHERE revoked_at IS NOT NULL AND revoked_at < ?")
      .bind(before)
      .run();
    return result.meta.changes ?? 0;
  }
}
