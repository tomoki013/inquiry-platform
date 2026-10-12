import type { AdminCoreStub } from "@inquiry-platform/core";
import { INTERNAL_ORIGIN } from "@inquiry-platform/core";
import { persistInboundMail, readInboundBytes } from "@inquiry-platform/mail-parser/journal";

/**
 * The deployment's support address (`SUPPORT_EMAIL`), and anything else Email Routing points here.
 *
 * The Worker has two jobs and they fail independently on purpose:
 *
 *   1. forward the message to the address that was already receiving it;
 *   2. record it in Core, so it can be answered through the Operator API.
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
  /** The same private bucket as Core, so its outage cannot lose the original. */
  PRIVATE_FILES: R2Bucket;
  SUPPORT_EMAIL: string;
  MAX_STORED_BYTES: string;
  /** The operator's own address. A Secret — it is personal, and it is the one
   * value here that must not be in git. Unset means forwarding is skipped, and
   * that is logged loudly. */
  SUPPORT_FORWARD_EMAIL?: string;
  /** JSON array of `{ address, projectSlug, forwardEmail }` route overrides. */
  APP_MAIL_ROUTES?: string;
}

interface MailRoute {
  address: string;
  projectSlug: string;
  forwardEmail?: string;
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
    const route = routeFor(message.to, env);
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
    await forward(message, route.forwardEmail);

    try {
      await store(message, env, ctx, route.projectSlug);
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
  _ctx: ExecutionContext,
  projectSlug?: string,
): Promise<"stored" | "skipped"> {
  const limit = Number(env.MAX_STORED_BYTES) || 5 * 1024 * 1024;
  if (message.rawSize > limit) {
    // Forwarded but not parsed. A very large mail is still delivered to the
    // operator; what it is not allowed to do is exhaust this Worker.
    log("mail.too_large", { rawSize: message.rawSize });
    return "skipped";
  }

  const bytes = await readInboundBytes(message.raw);
  await persistInboundMail(env.PRIVATE_FILES, bytes, message.to, projectSlug);
  const response = await env.ADMIN_CORE.fetch(`${INTERNAL_ORIGIN}/internal/mail-ingress/raw`, {
    method: "PUT",
    headers: {
      "Content-Type": "message/rfc822",
      "X-Mail-To": message.to,
      ...(projectSlug ? { "X-Mail-Project": projectSlug } : {}),
    },
    body: bytes,
  });
  if (!response.ok) {
    log("mail.queue_failed", { status: response.status });
    return "skipped";
  }
  log("mail.queued", {});
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
async function forward(message: InboundMessage, to?: string): Promise<void> {
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

function routeFor(
  address: string,
  env: MailIngressEnv,
): { projectSlug?: string; forwardEmail?: string } {
  if (!env.APP_MAIL_ROUTES) return { forwardEmail: env.SUPPORT_FORWARD_EMAIL };
  try {
    const routes = JSON.parse(env.APP_MAIL_ROUTES) as unknown;
    if (!Array.isArray(routes)) throw new Error("routes must be an array");
    const route = routes.find(
      (candidate): candidate is MailRoute =>
        typeof candidate === "object" &&
        candidate !== null &&
        typeof (candidate as MailRoute).address === "string" &&
        (candidate as MailRoute).address.trim().toLowerCase() === address.trim().toLowerCase() &&
        typeof (candidate as MailRoute).projectSlug === "string" &&
        (candidate as MailRoute).projectSlug.trim().length > 0,
    );
    return route
      ? { projectSlug: route.projectSlug, forwardEmail: route.forwardEmail }
      : { forwardEmail: env.SUPPORT_FORWARD_EMAIL };
  } catch {
    log("mail.route_unconfigured", {});
    return { forwardEmail: env.SUPPORT_FORWARD_EMAIL };
  }
}

/**
 * Structured, and never the mail.
 *
 * No subject, no body, no sender address, no attachment name. What a log line
 * here can answer is "did a message arrive, was it stored, was it forwarded" —
 * everything else is in the operator client, behind Access.
 */
function log(event: string, fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ worker: "mail-ingress", event, ...fields }));
}
