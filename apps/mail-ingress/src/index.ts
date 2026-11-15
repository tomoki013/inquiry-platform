import type { AdminCoreStub } from "@inquiry-platform/core";
import { INTERNAL_ORIGIN } from "@inquiry-platform/core";
import { persistInboundMail, readInboundBytes } from "@inquiry-platform/mail-parser/journal";
import { privateCipher } from "../../api/src/privacy/crypto";
import { privateBucket } from "../../api/src/privacy/files";

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
 *
 * One exception comes first: the operator's copy of our own reply. `ccSelf`
 * puts the support address on a reply's Cc, so the copy arrives here. Core
 * recognises it (`/internal/mail-ingress/self-copy`), and it is forwarded to
 * the operator's address instead of the route's, and not stored — it is not
 * the person writing. Only a mail from the address it was sent to is asked
 * about, so nobody else's mail waits on that question; if Core cannot answer,
 * the mail takes the usual path and Core's ingestion drops it there.
 */
export interface MailIngressEnv {
  ADMIN_CORE: AdminCoreStub;
  /** The same private bucket as Core, so its outage cannot lose the original. */
  PRIVATE_FILES: R2Bucket;
  PII_ENCRYPTION_KEYS?: string;
  PII_REQUIRED?: string;
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
    const copy = await selfCopy(message, env, route.projectSlug);
    if (copy) {
      // Never also to the route's address, and never stored. A forward that
      // fails — most likely a destination Email Routing has not verified — is
      // logged, and the copy is dropped: the reply itself was delivered, and
      // filing our own mail as the person's would be worse than a missing copy.
      // Never back to the address it came in on: that would be a loop.
      if (
        !copy.forwardTo ||
        copy.forwardTo.trim().toLowerCase() === message.to.trim().toLowerCase()
      ) {
        log("mail.self_copy_unforwarded", {});
        return;
      }
      try {
        await message.forward(copy.forwardTo);
        log("mail.self_copy_forwarded", {});
      } catch (error) {
        log("mail.self_copy_forward_failed", {
          error: error instanceof Error ? error.name : "Unknown",
        });
      }
      return;
    }
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
  await persistInboundMail(
    privateBucket(env.PRIVATE_FILES, privateCipher(env)),
    bytes,
    message.to,
    projectSlug,
  );
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
 * Whether `message` is the operator's copy of our own reply, and where it goes.
 * Asked only of mail whose From header is the address it was delivered to — a
 * reply copied to the support address is exactly that, and the person's mail
 * never is. `null` means "not a copy", including when Core cannot say.
 */
async function selfCopy(
  message: InboundMessage,
  env: MailIngressEnv,
  projectSlug?: string,
): Promise<{ forwardTo: string | null } | null> {
  const from = headerAddress(message.headers.get("from"));
  if (!from || from !== message.to.trim().toLowerCase()) return null;
  const messageId = message.headers.get("message-id")?.trim() || undefined;
  const copyId = message.headers.get("x-inquiry-copy")?.trim() || undefined;
  if (!messageId && !copyId) return null;
  try {
    const response = await env.ADMIN_CORE.fetch(
      `${INTERNAL_ORIGIN}/internal/mail-ingress/self-copy`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, messageId, copyId, projectSlug }),
      },
    );
    if (!response.ok) {
      log("mail.self_copy_check_failed", { status: response.status });
      return null;
    }
    const answer = (await response.json()) as { selfCopy?: unknown; forwardTo?: unknown };
    if (answer.selfCopy !== true) return null;
    return { forwardTo: typeof answer.forwardTo === "string" ? answer.forwardTo : null };
  } catch (error) {
    log("mail.self_copy_check_failed", { error: error instanceof Error ? error.name : "Unknown" });
    return null;
  }
}

/** The bare, lower-case address of a `From` header: `Name <a@example.com>`. */
function headerAddress(value: string | null): string | undefined {
  if (!value) return undefined;
  const address = (/<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@<>,]+@[^\s@<>,]+$/.test(address) ? address : undefined;
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
