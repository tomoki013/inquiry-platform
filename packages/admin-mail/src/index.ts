/**
 * Sending mail, without the Domain Layer knowing who sends it.
 *
 * Support replies, operator notifications and anything transactional all go
 * through {@link MailProvider}. Admin Core holds one, built once from the
 * environment; `SupportService` calls `sendSupportReply` and has never heard of
 * Resend. Swapping to Google Workspace or Cloudflare Email is a new file in
 * this package and one line in `providerFromEnv`.
 *
 * `Result`-shaped rather than throwing, for the same reason as everything else
 * crossing a boundary here: the caller has to decide what to do about a failed
 * send (keep the draft, tell the operator, do not delete anything), and a
 * thrown provider error is an easy thing to accidentally swallow.
 */
export type MailFailureCode = "NOT_CONFIGURED" | "REJECTED" | "TRANSPORT_ERROR";

export type MailResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; code: MailFailureCode /** For the log, never for the screen. */; detail: string };

export interface MailAddress {
  /** RFC 5322 address, optionally with a display name: `Name <a@b.c>`. */
  address: string;
}

export interface BaseMail {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  /** The source of truth for every mail this system sends. HTML, where a
   * provider needs it, is derived from this and never edited separately. */
  text: string;
  /** Deduplicates a retried send at the provider, on top of Admin Core's own
   * check. Two layers because neither alone survives every failure mode. */
  idempotencyKey: string;
}

export interface SupportReplyMail extends BaseMail {
  /** The `Message-ID` of the customer's message being answered. */
  inReplyTo?: string;
  /** Oldest first, as the header is written. */
  references?: string[];
}

export interface MailProvider {
  /** False when the environment has no credentials. The composer stays usable
   * — drafts, templates and internal notes all work — and only the send button
   * is disabled. */
  readonly configured: boolean;
  readonly name: string;
  sendTransactional(mail: BaseMail): Promise<MailResult>;
  sendSupportReply(mail: SupportReplyMail): Promise<MailResult>;
  sendAdminNotification(mail: BaseMail): Promise<MailResult>;
}

/**
 * What every environment without mail credentials gets.
 *
 * A real object rather than `undefined`, so no call site has to null-check and
 * no call site can forget to. It refuses, clearly, every time.
 */
export class UnconfiguredMailProvider implements MailProvider {
  readonly configured = false;
  readonly name = "unconfigured";

  private refuse(): Promise<MailResult> {
    return Promise.resolve({
      ok: false,
      code: "NOT_CONFIGURED",
      detail: "no mail provider is configured in this environment",
    });
  }

  sendTransactional(): Promise<MailResult> {
    return this.refuse();
  }
  sendSupportReply(): Promise<MailResult> {
    return this.refuse();
  }
  sendAdminNotification(): Promise<MailResult> {
    return this.refuse();
  }
}

export { plainTextToSafeHtml } from "./html";
export { ResendMailProvider } from "./resend";
