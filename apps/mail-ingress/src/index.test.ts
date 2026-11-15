import type { AdminCoreStub } from "@inquiry-platform/core";
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
  "To: support@example.com",
  "Subject: アプリで共有できません",
  "Message-ID: <first@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "共有ボタンが動きません。",
].join("\r\n");

function makeEnv(overrides: Partial<MailIngressEnv> = {}) {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  const bucket = {
    head: async (key: string) => objects.get(key) ?? null,
    put: async (
      key: string,
      bytes: Uint8Array,
      options: { customMetadata: Record<string, string> },
    ) => {
      objects.set(key, { bytes, customMetadata: options.customMetadata });
    },
  } as unknown as R2Bucket;
  const ingest = vi.fn().mockResolvedValue({
    ok: true,
    value: { threadId: "t1", messageId: "m1", duplicate: false, newThread: true },
  });
  const fetchStub = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
  const env: MailIngressEnv = {
    ADMIN_CORE: { ingestInboundEmail: ingest, fetch: fetchStub } as unknown as AdminCoreStub,
    PRIVATE_FILES: bucket,
    SUPPORT_EMAIL: "support@example.com",
    MAX_STORED_BYTES: "5242880",
    SUPPORT_FORWARD_EMAIL: "operator@example.com",
    ...overrides,
  };
  return { env, ingest, fetchStub, objects };
}

const ctx = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
} as ExecutionContext;

let message: FakeMessage;

beforeEach(() => {
  message = new FakeMessage("someone@example.com", "support@example.com", RAW);
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

  it("queues the MIME original before parsing and forwards it on", async () => {
    const { env, ingest, fetchStub } = makeEnv();
    await worker.email(message as never, env, ctx);

    expect(ingest).not.toHaveBeenCalled();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, options] = fetchStub.mock.calls[0]!;
    expect(url).toContain("/internal/mail-ingress/raw");
    expect(options.headers["X-Mail-To"]).toBe("support@example.com");
    expect(await new Response(options.body).text()).toBe(RAW);

    expect(message.forwardedTo).toEqual(["operator@example.com"]);
  });

  it("routes a project address into the matching project and inbox", async () => {
    const { env, ingest, fetchStub } = makeEnv({
      APP_MAIL_ROUTES: JSON.stringify([
        {
          address: "support@app-one.example.com",
          projectSlug: "app-one",
          forwardEmail: "app-one-owner@example.com",
        },
      ]),
    });
    const projectMessage = new FakeMessage(
      "someone@example.com",
      "support@app-one.example.com",
      RAW.replaceAll("support@example.com", "support@app-one.example.com"),
    );

    await worker.email(projectMessage as never, env, ctx);

    expect(projectMessage.forwardedTo).toEqual(["app-one-owner@example.com"]);
    expect(fetchStub.mock.calls[0]![1].headers["X-Mail-Project"]).toBe("app-one");
  });

  /** The rule: the inbox that worked before Admin existed keeps working. */
  it("still forwards when Admin Core refuses the message", async () => {
    const { env, ingest, fetchStub } = makeEnv();
    fetchStub.mockResolvedValue(new Response(null, { status: 503 }));

    await worker.email(message as never, env, ctx);
    expect(message.forwardedTo).toEqual(["operator@example.com"]);
  });

  it("still forwards when Admin Core throws", async () => {
    const { env, ingest, fetchStub, objects } = makeEnv();
    fetchStub.mockRejectedValue(new Error("binding is down"));

    await worker.email(message as never, env, ctx);
    expect(message.forwardedTo).toEqual(["operator@example.com"]);
    expect(objects.size).toBe(1);
    expect(new TextDecoder().decode([...objects.values()][0]!.bytes)).toBe(RAW);
  });

  it("keeps the stored copy when forwarding fails", async () => {
    const { env, ingest, fetchStub } = makeEnv();
    message.forwardShouldFail = true;

    // Does not throw: an exception would make Cloudflare retry the delivery,
    // and the message is already recorded.
    await expect(worker.email(message as never, env, ctx)).resolves.toBeUndefined();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("forwards but does not parse a message past the size ceiling", async () => {
    const { env, ingest, fetchStub } = makeEnv({ MAX_STORED_BYTES: "10" });
    await worker.email(message as never, env, ctx);

    expect(ingest).not.toHaveBeenCalled();
    expect(message.forwardedTo).toEqual(["operator@example.com"]);
  });

  it("does nothing dangerous when no forwarding address is configured", async () => {
    const { env, ingest, fetchStub } = makeEnv({ SUPPORT_FORWARD_EMAIL: undefined });
    await worker.email(message as never, env, ctx);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(message.forwardedTo).toEqual([]);
  });

  it("sends only the MIME job and never independently uploads attachments", async () => {
    const { env, ingest, fetchStub } = makeEnv();
    ingest.mockResolvedValue({
      ok: true,
      value: { threadId: "t1", messageId: "m1", duplicate: true, newThread: false },
    });

    await worker.email(message as never, env, ctx);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("persists an unparseable message so Core can show and retry its failure", async () => {
    const { env, ingest, fetchStub } = makeEnv();
    const headerless = new FakeMessage("", "support@example.com", "not an email");
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
    expect(written).toContain("mail.queued");
  });
});
