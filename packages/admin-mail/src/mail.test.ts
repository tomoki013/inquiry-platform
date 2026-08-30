import { describe, expect, it, vi } from "vitest";
import { plainTextToSafeHtml } from "./html";
import { UnconfiguredMailProvider } from "./index";
import { ResendMailProvider } from "./resend";

const mail = {
  to: "someone@example.com",
  from: "Tomokichi Studio Support <support@tmkch.io>",
  replyTo: "support@tmkch.io",
  subject: "Re: アプリで共有できません",
  text: "ご連絡ありがとうございます。",
  idempotencyKey: "idem-1234567890",
};

function fakeFetch(response: Response) {
  return vi.fn().mockResolvedValue(response);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ResendMailProvider", () => {
  /**
   * The default fetcher, which every other test in this file replaces.
   *
   * Leaving it uncovered cost a production send. A bare `fetch` stored on the
   * instance and called as `this.fetcher(...)` is invoked with the provider as
   * its receiver, and the Workers runtime answers that with
   * `TypeError: Illegal invocation` — reported by the adapter as a
   * TRANSPORT_ERROR indistinguishable from the network being down.
   *
   * Node does not enforce the receiver, so asserting "the global was called"
   * would pass either way. What this asserts instead is the thing that
   * actually differs: what `fetch` is called *on*. Anything but the provider
   * is fine; the provider is the bug.
   */
  it("calls the global fetch without the provider as its receiver", async () => {
    let receiver: unknown = "never called";
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async function (
      this: unknown,
    ) {
      receiver = this;
      return jsonResponse({ id: "resend-global" });
    });
    try {
      const provider = new ResendMailProvider("key");
      const result = await provider.sendSupportReply(mail);
      expect(result.ok).toBe(true);
      expect(globalFetch).toHaveBeenCalledWith(
        "https://api.resend.com/emails",
        expect.objectContaining({ method: "POST" }),
      );
      expect(receiver).not.toBe(provider);
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("sends the plain text as the body and the idempotency key as a header", async () => {
    const fetcher = fakeFetch(jsonResponse({ id: "resend-1" }));
    const result = await new ResendMailProvider("key", fetcher as never).sendSupportReply(mail);

    expect(result).toEqual({ ok: true, providerMessageId: "resend-1" });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-1234567890");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.text).toBe("ご連絡ありがとうございます。");
    expect(body.to).toEqual(["someone@example.com"]);
    expect(body.reply_to).toBe("support@tmkch.io");
  });

  /** Without these a reply starts a second conversation in the customer's
   * client, and they see two unrelated messages about one question. */
  it("sets the threading headers when the thread has history", async () => {
    const fetcher = fakeFetch(jsonResponse({ id: "resend-2" }));
    await new ResendMailProvider("key", fetcher as never).sendSupportReply({
      ...mail,
      inReplyTo: "<first@example.com>",
      references: ["<first@example.com>", "<second@example.com>"],
    });

    const body = JSON.parse(String((fetcher.mock.calls[0] as [string, RequestInit])[1].body)) as {
      headers: Record<string, string>;
    };
    expect(body.headers["In-Reply-To"]).toBe("<first@example.com>");
    expect(body.headers.References).toBe("<first@example.com> <second@example.com>");
  });

  it("omits the headers block entirely for a first message", async () => {
    const fetcher = fakeFetch(jsonResponse({ id: "resend-3" }));
    await new ResendMailProvider("key", fetcher as never).sendTransactional(mail);

    const body = JSON.parse(
      String((fetcher.mock.calls[0] as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body.headers).toBeUndefined();
  });

  it("reports a rejection with the status and nothing from the body", async () => {
    const fetcher = fakeFetch(
      jsonResponse({ message: "invalid recipient someone@example.com" }, 422),
    );
    const result = await new ResendMailProvider("key", fetcher as never).sendSupportReply(mail);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REJECTED");
      // The provider's body can quote the message being sent, and `detail`
      // reaches the log.
      expect(result.detail).toBe("resend responded 422");
      expect(result.detail).not.toContain("someone@example.com");
    }
  });

  it("reports a transport failure separately from a rejection", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("network down"));
    const result = await new ResendMailProvider("key", fetcher as never).sendSupportReply(mail);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSPORT_ERROR");
  });

  /**
   * An accepted send whose response cannot be parsed is still a send. Turning
   * it into a failure would make an operator send the same reply twice.
   */
  it("treats an unparseable success as a success", async () => {
    const fetcher = fakeFetch(new Response("ok", { status: 200 }));
    const result = await new ResendMailProvider("key", fetcher as never).sendSupportReply(mail);
    expect(result).toEqual({ ok: true });
  });
});

describe("UnconfiguredMailProvider", () => {
  it("refuses every method with a code the screen can act on", async () => {
    const provider = new UnconfiguredMailProvider();
    expect(provider.configured).toBe(false);
    for (const result of [
      await provider.sendSupportReply(),
      await provider.sendTransactional(),
      await provider.sendAdminNotification(),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("NOT_CONFIGURED");
    }
  });
});

describe("plainTextToSafeHtml", () => {
  it("escapes rather than templates", () => {
    const html = plainTextToSafeHtml('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
  });

  it("keeps line breaks readable without turning them into markup", () => {
    expect(plainTextToSafeHtml("a\nb")).toContain("a\nb");
    expect(plainTextToSafeHtml("a\nb")).toContain("white-space:pre-wrap");
  });
});
