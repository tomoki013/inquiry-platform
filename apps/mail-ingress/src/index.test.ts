import type { AdminCoreStub } from "@tomokichi/admin-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type MailIngressEnv } from "./index";

/**
 * The mail Worker's whole job, and the order it does it in.
 *
 * The tests that matter most here are the ones about *independence*: storing
 * and forwarding must fail separately, because before Admin existed support
 * mail went straight to a person's inbox and a bug in Admin must not be a way
 * to lose somebody's question.
 */

class FakeMessage {
  forwardedTo: string[] = [];
  forwardShouldFail = false;
  /** Every side effect, in the order it happened. See the ordering test. */
  events: string[] = [];

  constructor(
    readonly from: string,
    readonly to: string,
    private readonly rawText: string,
    readonly rawSize = rawText.length,
  ) {}

  get raw(): ReadableStream {
    this.events.push("raw");
    const bytes = new TextEncoder().encode(this.rawText);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  get headers(): Headers {
    return new Headers();
  }

  forward(recipient: string): Promise<void> {
    this.events.push("forward");
    if (this.forwardShouldFail) return Promise.reject(new Error("forward failed"));
    this.forwardedTo.push(recipient);
    return Promise.resolve();
  }

  setReject(): void {}
}

const RAW = [
  "From: Someone <someone@example.com>",
  "To: support@tmkch.io",
  "Subject: アプリで共有できません",
  "Message-ID: <first@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "共有ボタンが動きません。",
].join("\r\n");

function makeEnv(overrides: Partial<MailIngressEnv> = {}) {
  const ingest = vi.fn().mockResolvedValue({
    ok: true,
    value: { threadId: "t1", messageId: "m1", duplicate: false, newThread: true },
  });
  const fetchStub = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
  const env: MailIngressEnv = {
    ADMIN_CORE: { ingestInboundEmail: ingest, fetch: fetchStub } as unknown as AdminCoreStub,
    SUPPORT_EMAIL: "support@tmkch.io",
    MAX_STORED_BYTES: "5242880",
    SUPPORT_FORWARD_EMAIL: "operator@example.com",
    ...overrides,
  };
  return { env, ingest, fetchStub };
}

const ctx = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
} as ExecutionContext;

let message: FakeMessage;

beforeEach(() => {
  message = new FakeMessage("someone@example.com", "support@tmkch.io", RAW);
});

describe("email()", () => {
  /**
   * The ordering, which is the whole reason the mail cannot be lost.
   *
   * On the free Workers plan a request gets 10ms of CPU, and a MIME parse of a
   * mail carrying megabytes of base64 can exceed it. Exceeding CPU kills the
   * isolate rather than throwing, so nothing after the parse runs — no `catch`,
   * no forward. Every support mail goes through this Worker now, so parsing
   * before delivering means a question that reaches nobody.
   *
   * Asserting "it forwards" is not enough, because that passed before too.
   * What matters is that the forward happens before the raw stream is ever
   * touched.
   */
  it("forwards before it reads the message body", async () => {
    const { env } = makeEnv();
    await worker.email(message as never, env, ctx);

    expect(message.events[0]).toBe("forward");
    expect(message.events).toContain("raw");
  });

  it("hands a parsed message to Admin Core and forwards it on", async () => {
    const { env, ingest } = makeEnv();
    await worker.email(message as never, env, ctx);

    expect(ingest).toHaveBeenCalledTimes(1);
    const [input, actor] = ingest.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input.from).toBe("someone@example.com");
    expect(input.subject).toBe("アプリで共有できません");
    expect(input.bodyText).toBe("共有ボタンが動きません。");
    expect(input.messageId).toBe("<first@example.com>");
    expect(input.requesterName).toBe("Someone");
    expect(actor).toEqual({ type: "email", id: "mail-ingress" });

    expect(message.forwardedTo).toEqual(["operator@example.com"]);
  });

  /** The rule: the inbox that worked before Admin existed keeps working. */
  it("still forwards when Admin Core refuses the message", async () => {
    const { env, ingest } = makeEnv();
    ingest.mockResolvedValue({ ok: false, error: { code: "VALIDATION_ERROR", message: "x" } });

    await worker.email(message as never, env, ctx);
    expect(message.forwardedTo).toEqual(["operator@example.com"]);
  });

  it("still forwards when Admin Core throws", async () => {
    const { env, ingest } = makeEnv();
    ingest.mockRejectedValue(new Error("binding is down"));

    await worker.email(message as never, env, ctx);
    expect(message.forwardedTo).toEqual(["operator@example.com"]);
  });

  it("keeps the stored copy when forwarding fails", async () => {
    const { env, ingest } = makeEnv();
    message.forwardShouldFail = true;

    // Does not throw: an exception would make Cloudflare retry the delivery,
    // and the message is already recorded.
    await expect(worker.email(message as never, env, ctx)).resolves.toBeUndefined();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("forwards but does not parse a message past the size ceiling", async () => {
    const { env, ingest } = makeEnv({ MAX_STORED_BYTES: "10" });
    await worker.email(message as never, env, ctx);

    expect(ingest).not.toHaveBeenCalled();
    expect(message.forwardedTo).toEqual(["operator@example.com"]);
  });

  it("does nothing dangerous when no forwarding address is configured", async () => {
    const { env, ingest } = makeEnv({ SUPPORT_FORWARD_EMAIL: undefined });
    await worker.email(message as never, env, ctx);

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(message.forwardedTo).toEqual([]);
  });

  it("does not re-upload attachments for a message it has already seen", async () => {
    const { env, ingest, fetchStub } = makeEnv();
    ingest.mockResolvedValue({
      ok: true,
      value: { threadId: "t1", messageId: "m1", duplicate: true, newThread: false },
    });

    await worker.email(message as never, env, ctx);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("skips a message with no usable sender", async () => {
    const { env, ingest } = makeEnv();
    const headerless = new FakeMessage("", "support@tmkch.io", "not an email");
    await worker.email(headerless as never, env, ctx);

    expect(ingest).not.toHaveBeenCalled();
    expect(headerless.forwardedTo).toEqual(["operator@example.com"]);
  });
});

describe("logging", () => {
  it("never writes the sender, subject or body to the log", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    const { env } = makeEnv();

    await worker.email(message as never, env, ctx);
    spy.mockRestore();

    const written = lines.join("\n");
    expect(written).not.toContain("someone@example.com");
    expect(written).not.toContain("共有ボタン");
    expect(written).not.toContain("アプリで共有できません");
    expect(written).toContain("mail.stored");
  });
});
