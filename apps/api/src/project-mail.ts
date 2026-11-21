import {
  type MailProvider,
  ResendMailProvider,
  UnconfiguredMailProvider,
} from "@inquiry-platform/notification/mail";
import { z } from "zod";

const configSchema = z.object({
  apiKeyBinding: z.string().regex(/^MAIL_API_KEY_[A-Z0-9_]+$/),
  defaultSignature: z.string().max(2000).default(""),
  supportEmail: z.email().optional(),
  supportUrl: z.url({ protocol: /^https$/ }).optional(),
  logo: z.object({ url: z.url({ protocol: /^https$/ }), alt: z.string().max(80) }).optional(),
  lookupMessageIds: z.boolean().default(false),
  signatureAccentColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  /** Key of one of this project's reply templates to write its report
   * receipts with, instead of the platform's generic wording. */
  reportReceiptTemplate: z
    .string()
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
    .optional(),
  /** False: this project's inquiries get no automatic receipt. Superseded by
   * the project's mail settings (`app_mail_settings.inquiry_receipt`), which
   * win when set; kept for deployments configured with v0.10.0. */
  inquiryReceipt: z.boolean().default(true),
  /** Where the ticket number goes in the subject of a form's receipt:
   * `[TK-000123] お問い合わせを受け付けました: …` (`start`, the default) or
   * `お問い合わせを受け付けました: … [TK-000123]` (`end`). Either way a reply
   * naming it in its subject is filed under the ticket. */
  inquiryReceiptNumberAt: z.enum(["start", "end"]).default("start"),
  /** Opt-in customer receipt containing only the original message body. */
  inquiryReceiptQuoteBody: z.boolean().default(false),
  /** Do not send a separate conversation when a sent parent is awaiting its real ID. */
  requireVerifiedReplyParent: z.boolean().default(false),
  /** Copy the receipt to the private notification recipient for email reply-all. */
  inquiryReceiptCopyToNotification: z.boolean().default(false),
  /** True: every operator reply also goes to this project's own support
   * address (`supportEmail`) on Cc, so the conversation is kept in that
   * mailbox too. Mail-ingress receives that copy and never files it — mail
   * from this deployment's own addresses opens no inquiry and joins none. */
  replyCcSupport: z.boolean().default(false),
  /** This project's closing line instead of the deployment's
   * (`Branding.replyClosing`); an empty string means none. */
  replyClosing: z.string().trim().max(200).optional(),
  /** The same for the receipt a new inquiry gets. Superseded, like
   * `inquiryReceipt`, by `app_mail_settings.inquiry_receipt_template`. */
  inquiryReceiptTemplate: z
    .string()
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
    .optional(),
});

export interface ProjectMailDelivery {
  mail: MailProvider;
  defaultSignature?: string;
  supportEmail?: string;
  supportUrl?: string;
  reportReceiptTemplate?: string;
  inquiryReceiptTemplate?: string;
  inquiryReceipt?: boolean;
  inquiryReceiptQuoteBody?: boolean;
  inquiryReceiptNumberAt?: "start" | "end";
  requireVerifiedReplyParent?: boolean;
  inquiryReceiptCopyToNotification?: boolean;
  replyCcSupport?: boolean;
  replyClosing?: string;
}

/** Deployment-owned routing by immutable project id. Credentials live only in
 * Worker Secrets; neither the database nor an RPC request can choose a binding.
 * An explicit route never falls back to another project's credential or logo. */
export function projectMailResolver(
  raw: unknown,
  secrets: object,
  fallback: MailProvider,
  fetcher?: typeof fetch,
): (appId: string | undefined) => ProjectMailDelivery {
  const routes =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const cache = new Map<string, ProjectMailDelivery>();
  return (appId) => {
    if (!appId || !Object.hasOwn(routes, appId)) return { mail: fallback };
    const existing = cache.get(appId);
    if (existing) return existing;
    const parsed = configSchema.safeParse(routes[appId]);
    const key =
      parsed.success && Object.hasOwn(secrets, parsed.data.apiKeyBinding)
        ? (secrets as Record<string, unknown>)[parsed.data.apiKeyBinding]
        : undefined;
    const delivery: ProjectMailDelivery = {
      mail:
        parsed.success && typeof key === "string" && key.trim()
          ? new ResendMailProvider(
              key,
              fetcher,
              parsed.data.logo,
              parsed.data.lookupMessageIds,
              parsed.data.signatureAccentColor,
            )
          : new UnconfiguredMailProvider(),
      // Missing or invalid routes have no deployment branding fallback.
      defaultSignature: parsed.success ? parsed.data.defaultSignature : "",
      supportEmail: parsed.success ? parsed.data.supportEmail : undefined,
      supportUrl: parsed.success ? parsed.data.supportUrl : undefined,
      reportReceiptTemplate: parsed.success ? parsed.data.reportReceiptTemplate : undefined,
      inquiryReceiptTemplate: parsed.success ? parsed.data.inquiryReceiptTemplate : undefined,
      // An unreadable route sends no receipt rather than one in the wrong voice.
      inquiryReceipt: parsed.success ? parsed.data.inquiryReceipt : false,
      inquiryReceiptQuoteBody: parsed.success && parsed.data.inquiryReceiptQuoteBody,
      inquiryReceiptNumberAt: parsed.success ? parsed.data.inquiryReceiptNumberAt : "start",
      requireVerifiedReplyParent: parsed.success && parsed.data.requireVerifiedReplyParent,
      inquiryReceiptCopyToNotification:
        parsed.success && parsed.data.inquiryReceiptCopyToNotification,
      replyCcSupport: parsed.success && parsed.data.replyCcSupport,
      replyClosing: parsed.success ? parsed.data.replyClosing : undefined,
    };
    cache.set(appId, delivery);
    return delivery;
  };
}

/** Every support address a project route names: this deployment's own, never a customer's. */
export function projectSupportAddresses(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  // Read leniently: a route too broken to send with still names our address.
  return Object.values(raw as Record<string, unknown>).flatMap((route) => {
    const address =
      route && typeof route === "object"
        ? (route as { supportEmail?: unknown }).supportEmail
        : undefined;
    return typeof address === "string" && address.includes("@") ? [address.trim()] : [];
  });
}
