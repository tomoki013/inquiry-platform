import { z } from "zod";

/**
 * Notifications about new tickets, and the devices that receive them.
 *
 * The rule this file exists to hold: **a notification carries a reference,
 * never content.** {@link TicketNotificationEvent} is everything the mail and
 * push channels are ever told about a ticket — a number, a kind, an app and an
 * internal project reference used only for delivery configuration.
 * There is no field for a subject, a body, a name, an address or a timestamp,
 * and adding one is the change this design forbids. The person follows the
 * configured link into their own operator client, behind Access.
 */
export const ticketNotificationCategories = ["inquiry", "report"] as const;
export type TicketNotificationCategory = (typeof ticketNotificationCategories)[number];

export interface TicketNotificationEvent {
  type: "support.ticket.created";
  /** The ticket's UUID. Only used to look things up; never shown. */
  ticketId: string;
  /** `TK-000123` — what the notification shows and the link resolves. */
  ticketNumber: string;
  category: TicketNotificationCategory;
  /** The Project's display name for the notification line. */
  app: string;
  /** Project/service id used only to resolve project-scoped delivery config. */
  appId?: string;
}

/**
 * What a push message says on the wire, once decrypted by the device.
 *
 * Shown on a lock screen, so it contains no requester, subject or body.
 */
export interface PushPayload {
  type: "support.ticket.created";
  ticketNumber: string;
  category: TicketNotificationCategory;
  app: string;
  /** A short label made only from the ticket kind and number. */
  title: string;
  /** A deployment-provided operator-client URL. No query string is added. */
  url: string;
}

// ---- Settings -----------------------------------------------------------

export const notificationSettingsSchema = z.object({
  inquiryPush: z.boolean(),
  reportPush: z.boolean(),
  emailEnabled: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const defaultNotificationSettings: NotificationSettings = {
  inquiryPush: true,
  reportPush: true,
  emailEnabled: true,
};

// ---- Push subscriptions -------------------------------------------------

/** The endpoint is a capability URL: anybody holding it can push to the
 * device. It is stored, used and never returned to a browser or a log. */
export const registerPushSubscriptionInputSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine((value) => value.startsWith("https://"), "endpoint must be https"),
  keys: z.object({
    p256dh: z.string().min(80).max(120),
    auth: z.string().min(16).max(32),
  }),
  deviceName: z.string().trim().max(80).optional(),
  /** Taken from the request, not the body, by the API gateway. */
  userAgent: z.string().max(300).optional(),
});
export type RegisterPushSubscriptionInput = z.infer<typeof registerPushSubscriptionInputSchema>;

export const revokePushSubscriptionInputSchema = z.union([
  z.object({ id: z.string().min(1) }),
  z.object({ endpoint: z.string().url().max(2048) }),
]);
export type RevokePushSubscriptionInput = z.infer<typeof revokePushSubscriptionInputSchema>;

/** A device summary for API consumers. Deliberately without `endpoint`,
 * `p256dh` or `auth`. */
export interface PushDeviceSummary {
  id: string;
  deviceName?: string;
  userAgent?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface NotificationOverview {
  /** Absent when Core has no VAPID keys; API consumers can decide how to
   * present that unavailable channel. */
  pushPublicKey?: string;
  emailConfigured: boolean;
  settings: NotificationSettings;
  devices: PushDeviceSummary[];
}

/** How a notification fan-out went. Counts only. */
export interface NotificationOutcome {
  email: "sent" | "failed" | "disabled" | "unconfigured";
  push: { attempted: number; delivered: number; revoked: number; failed: number };
}
