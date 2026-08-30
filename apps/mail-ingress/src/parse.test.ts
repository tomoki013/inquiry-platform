import { describe, expect, it } from "vitest";
import { htmlToText, parseInboundEmail, parseReferences } from "./parse";

describe("htmlToText", () => {
  it("keeps the words and drops the markup", () => {
    expect(htmlToText("<p>こんにちは</p><p>お世話になります</p>")).toBe(
      "こんにちは\nお世話になります",
    );
  });

  /**
   * The security property this function exists for: nothing that arrives as
   * HTML leaves as HTML, so no layer below has to decide whether to trust it.
   */
  it("removes script and style contents entirely", () => {
    const flattened = htmlToText("<script>alert(1)</script><style>p{}</style><p>本文</p>");
    expect(flattened).toBe("本文");
    expect(flattened).not.toContain("alert");
  });

  it("decodes entities last, so a decoded bracket cannot become a tag", () => {
    // `&lt;img onerror=...&gt;` decodes to text that looks like a tag but is
    // never re-parsed — it is stored and rendered as characters.
    const flattened = htmlToText("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(flattened).toBe("<img src=x onerror=alert(1)>");
  });

  it("collapses the blank lines a mail client leaves behind", () => {
    expect(htmlToText("<div>a</div><br><br><br><div>b</div>")).toBe("a\n\nb");
  });
});

describe("parseReferences", () => {
  it("splits a wrapped header into ids", () => {
    expect(parseReferences("<a@x>\r\n <b@x>\t<c@x>")).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });

  it("ignores anything that is not an id", () => {
    expect(parseReferences("garbage <a@x> more")).toEqual(["<a@x>"]);
    expect(parseReferences(undefined)).toEqual([]);
  });
});

function raw(body: string): ArrayBuffer {
  return new TextEncoder().encode(body).buffer as ArrayBuffer;
}

describe("parseInboundEmail", () => {
  it("reads a plain message", async () => {
    const parsed = await parseInboundEmail(
      raw(
        [
          "From: Someone <someone@example.com>",
          "To: support@tmkch.io",
          "Subject: Test subject",
          "Message-ID: <first@example.com>",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "本文です。",
        ].join("\r\n"),
      ),
    );

    expect(parsed.from).toBe("someone@example.com");
    expect(parsed.fromName).toBe("Someone");
    expect(parsed.subject).toBe("Test subject");
    expect(parsed.bodyText).toBe("本文です。");
    expect(parsed.messageId).toBe("<first@example.com>");
  });

  it("falls back to a flattened HTML part when there is no text part", async () => {
    const parsed = await parseInboundEmail(
      raw(
        [
          "From: someone@example.com",
          "Subject: HTML only",
          "Content-Type: text/html; charset=utf-8",
          "",
          "<html><body><script>alert(1)</script><p>HTMLの本文</p></body></html>",
        ].join("\r\n"),
      ),
    );

    expect(parsed.bodyText).toBe("HTMLの本文");
    expect(parsed.bodyText).not.toContain("<p>");
  });

  it("does not treat an address in the display name as a name", async () => {
    const parsed = await parseInboundEmail(
      raw(["From: someone@example.com <someone@example.com>", "Subject: x", "", "y"].join("\r\n")),
    );
    // Greeting somebody as "someone@example.com様" is worse than no greeting.
    expect(parsed.fromName).toBeUndefined();
  });

  it("carries In-Reply-To and References through", async () => {
    const parsed = await parseInboundEmail(
      raw(
        [
          "From: someone@example.com",
          "Subject: Re: x",
          "Message-ID: <second@example.com>",
          "In-Reply-To: <first@example.com>",
          "References: <first@example.com>",
          "",
          "返信です。",
        ].join("\r\n"),
      ),
    );
    expect(parsed.inReplyTo).toBe("<first@example.com>");
    expect(parsed.references).toEqual(["<first@example.com>"]);
  });

  it("does not fall over on a malformed message", async () => {
    const parsed = await parseInboundEmail(raw("this is not an email at all"));
    expect(parsed.from).toBe("");
    expect(typeof parsed.bodyText).toBe("string");
  });
});
