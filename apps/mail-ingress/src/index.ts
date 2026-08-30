import type { AdminCoreStub } from "@tomokichi/admin-contracts";
import {
  ATTACHMENT_FILENAME_HEADER,
  INTERNAL_ORIGIN,
  INTERNAL_PATHS,
  MAX_ATTACHMENT_BYTES,
} from "@tomokichi/admin-contracts";
import { parseInboundEmail } from "./parse";

/**
 * `support@tmkch.io`, and anything else Email Routing points here.
 *
 * The Worker has two jobs and they fail independently on purpose:
 *
 *   1. forward the message to the address that was already receiving it;
 *   2. record it in Admin, so it can be answered from the admin screen.
 *
 * **In that order.** Before this Worker existed, support mail went straight to
 * a personal inbox with nothing in the way; now every support mail goes through
 * here, so this Worker not finishing has to mean "Admin is missing a copy" and
 * never "nobody got the question". Delivering before parsing is what makes that
 * true even when the parse is not merely wrong but killed — see `email` below.
 *
 * A forwarding failure is logged and does not stop the message being stored.
 */
export interface MailIngressEnv {
  ADMIN_CORE: AdminCoreStub;
  SUPPORT_EMAIL: string;
  MAX_STORED_BYTES: string;
  /** The operator's own address. A Secret — it is personal, and it is the one
   * value here that must not be in git. Unset means forwarding is skipped, and
   * that is logged loudly. */
  SUPPORT_FORWARD_EMAIL?: string;
}

/** Cloudflare's shape for an inbound message, narrowed to what is used. */
interface InboundMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  readonly headers: Headers;
  forward(recipient: string, headers?: Headers): Promise<void>;
  setReject(reason: string): void;
}

export default {
  async email(message: InboundMessage, env: MailIngressEnv, ctx: ExecutionContext): Promise<void> {
    // Deliver first, parse second.
    //
    // The order used to be the other way round, with the parse wrapped in a
    // `try` so that a failure there could not stop the forward. That covers an
    // exception and not the thing most likely to happen on the free Workers
    // plan: 10ms of CPU per request, against a MIME parse of a mail that may
    // carry megabytes of base64. Exceeding CPU is not an exception — the
    // isolate is killed — so the `catch` never runs and neither does anything
    // after it. Every support mail now goes through this Worker, so that would
    // have been a question nobody ever saw, in either place.
    //
    // Forwarding first cannot lose the mail that way. If parsing then fails
    // for any reason at all, the worst case is a copy missing from Admin,
    // which is logged and recoverable, rather than a message that reached
    // nobody.
    await forward(message, env);

    try {
      await store(message, env, ctx);
    } catch (error) {
      // Never rethrow: an exception here would make Cloudflare retry the whole
      // delivery, and the mail has already gone out once.
      log("mail.store_failed", { error: error instanceof Error ? error.name : "Unknown" });
    }
  },
};

async function store(
  message: InboundMessage,
  env: MailIngressEnv,
  ctx: ExecutionContext,
): Promise<"stored" | "skipped"> {
  const limit = Number(env.MAX_STORED_BYTES) || 5 * 1024 * 1024;
  if (message.rawSize > limit) {
    // Forwarded but not parsed. A very large mail is still delivered to the
    // operator; what it is not allowed to do is exhaust this Worker.
    log("mail.too_large", { rawSize: message.rawSize });
    return "skipped";
  }

  const parsed = await parseInboundEmail(message.raw);
  if (!parsed.from) {
    log("mail.no_sender", {});
    return "skipped";
  }

  const result = await env.ADMIN_CORE.ingestInboundEmail(
    {
      from: parsed.from,
      to: message.to,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      requesterName: parsed.fromName,
    },
    { type: "email", id: "mail-ingress" },
  );

  if (!result.ok) {
    log("mail.ingest_rejected", { code: result.error.code });
    return "skipped";
  }
  if (result.value.duplicate) {
    log("mail.duplicate", { threadId: result.value.threadId });
    return "stored";
  }

  // Attachments are best-effort and run after the message is safely recorded.
  // Losing a photo is bad; losing the question it was attached to is worse.
  const uploads = parsed.attachments
    .filter((attachment) => attachment.bytes.byteLength > 0)
    .filter((attachment) => attachment.bytes.byteLength <= MAX_ATTACHMENT_BYTES)
    .map(async (attachment) => {
      const response = await env.ADMIN_CORE.fetch(
        `${INTERNAL_ORIGIN}${INTERNAL_PATHS.supportAttachment(result.value.messageId)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": attachment.contentType,
            "Content-Length": String(attachment.bytes.byteLength),
            ...(attachment.filename ? { [ATTACHMENT_FILENAME_HEADER]: attachment.filename } : {}),
          },
          body: attachment.bytes,
        },
      );
      if (!response.ok) log("mail.attachment_failed", { status: response.status });
    });

  if (uploads.length > 0) ctx.waitUntil(Promise.allSettled(uploads));

  log("mail.stored", {
    threadId: result.value.threadId,
    newThread: result.value.newThread,
    attachments: uploads.length,
  });
  return "stored";
}

/**
 * The delivery that existed before Admin did.
 *
 * The forwarding address is a Secret rather than a Routing rule so that this
 * Worker is the single place mail fans out from — a Routing rule with two
 * destinations would deliver the raw mail twice on a retry and Admin's copy
 * once.
 */
async function forward(message: InboundMessage, env: MailIngressEnv): Promise<void> {
  const to = env.SUPPORT_FORWARD_EMAIL;
  if (!to) {
    log("mail.forward_unconfigured", {});
    return;
  }
  try {
    await message.forward(to);
    log("mail.forwarded", {});
  } catch (error) {
    log("mail.forward_failed", { error: error instanceof Error ? error.name : "Unknown" });
  }
}

/**
 * Structured, and never the mail.
 *
 * No subject, no body, no sender address, no attachment name. What a log line
 * here can answer is "did a message arrive, was it stored, was it forwarded" —
 * everything else is in the admin screen, behind Access.
 */
function log(event: string, fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ worker: "tomokichi-mail-ingress", event, ...fields }));
}
