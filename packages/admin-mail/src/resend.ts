import { plainTextToSafeHtml } from "./html";
import type { BaseMail, MailProvider, MailResult, SupportReplyMail } from "./index";

/**
 * Resend, which is what the Studio already sends support notifications with.
 *
 * Deliberately a thin adapter and not a shared package with `apps/api`: that
 * Worker's `sendSupportEmail` throws, has its own bindings and is covered by
 * its own tests, and pulling it into a common module would mean editing a live
 * mail path to serve a new admin screen. The duplicated fetch is ten lines; the
 * regression risk was the expensive part.
 */
export class ResendMailProvider implements MailProvider {
  readonly configured = true;
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    /**
     * Injectable for the tests, and wrapped rather than defaulted to bare
     * `fetch` on purpose: the Workers runtime rejects `fetch` called with the
     * wrong receiver, so storing the global itself and calling it as
     * `this.fetcher(...)` throws `TypeError: Illegal invocation` on every
     * send. Every test passes a fetcher, so the default was the one line in
     * this file the suite could not reach — and it failed the first real
     * reply, in production.
     */
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  sendTransactional(mail: BaseMail): Promise<MailResult> {
    return this.send(mail);
  }

  sendAdminNotification(mail: BaseMail): Promise<MailResult> {
    return this.send(mail);
  }

  /**
   * A reply, with the headers that keep it in the customer's existing
   * conversation. Without `In-Reply-To` Gmail starts a second thread and the
   * person sees two unrelated messages about one question.
   */
  sendSupportReply(mail: SupportReplyMail): Promise<MailResult> {
    const headers: Record<string, string> = {};
    if (mail.inReplyTo) headers["In-Reply-To"] = mail.inReplyTo;
    if (mail.references && mail.references.length > 0) {
      headers.References = mail.references.join(" ");
    }
    return this.send(mail, headers);
  }

  private async send(mail: BaseMail, headers?: Record<string, string>): Promise<MailResult> {
    let response: Response;
    try {
      response = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": mail.idempotencyKey,
        },
        body: JSON.stringify({
          from: mail.from,
          to: [mail.to],
          reply_to: mail.replyTo,
          subject: mail.subject,
          text: mail.text,
          html: plainTextToSafeHtml(mail.text),
          ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        }),
      });
    } catch (error) {
      return {
        ok: false,
        code: "TRANSPORT_ERROR",
        detail: error instanceof Error ? error.name : "fetch failed",
      };
    }

    if (!response.ok) {
      // The status, not the body: a provider error body can quote the message
      // that was being sent, and this string reaches the log.
      return { ok: false, code: "REJECTED", detail: `resend responded ${response.status}` };
    }

    let providerMessageId: string | undefined;
    try {
      const body: unknown = await response.json();
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id === "string") providerMessageId = id;
    } catch {
      // Accepted but unparseable. The mail went; we simply cannot record which
      // one it was, and that must not turn a success into a failure that makes
      // an operator send it twice.
    }
    return providerMessageId ? { ok: true, providerMessageId } : { ok: true };
  }
}
