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
 *   1. record the message in Admin, so it can be answered from the admin screen;
 *   2. forward it to the address that was already receiving it.
 *
 * Forwarding runs **whatever happened in step 1**. Before this Worker existed,
 * support mail went straight to a personal inbox; a bug in Admin must not be a
 * way to silently lose somebody's question. The reverse holds too: a forwarding
 * failure is logged and does not undo the stored copy.
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
    let stored: "stored" | "skipped" | "failed" = "failed";
    try {
      stored = await store(message, env, ctx);
    } catch (error) {
      // Never rethrow: an exception here would make Cloudflare retry the whole
      // delivery, and the forward below has not run yet.
      log("mail.store_failed", { error: error instanceof Error ? error.name : "Unknown" });
    }

    await forward(message, env, stored);
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
async function forward(
  message: InboundMessage,
  env: MailIngressEnv,
  stored: "stored" | "skipped" | "failed",
): Promise<void> {
  const to = env.SUPPORT_FORWARD_EMAIL;
  if (!to) {
    log("mail.forward_unconfigured", { stored });
    return;
  }
  try {
    await message.forward(to);
    log("mail.forwarded", { stored });
  } catch (error) {
    // Both halves failed only if `stored` is also "failed" — and that is the
    // one case worth finding in the logs.
    log("mail.forward_failed", {
      stored,
      error: error instanceof Error ? error.name : "Unknown",
    });
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
