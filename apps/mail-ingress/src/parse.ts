import PostalMime from "postal-mime";

/**
 * Turning a raw inbound email into the few fields Admin cares about.
 *
 * The important half of this file is what it throws away. An HTML mail is
 * flattened to text **here**, at the edge, before anything is stored — so no
 * layer below has to decide whether to trust it, and the admin screen never has
 * a reason to render markup a stranger wrote. `dangerouslySetInnerHTML` does
 * not appear anywhere in this codebase, and this is why it does not need to.
 */
export interface ParsedInboundEmail {
  from: string;
  fromName?: string;
  to?: string;
  subject: string;
  bodyText: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
  filename?: string;
  contentType: string;
  bytes: Uint8Array;
}

export async function parseInboundEmail(
  raw: ReadableStream | ArrayBuffer,
): Promise<ParsedInboundEmail> {
  const parsed = await PostalMime.parse(raw);

  const text =
    typeof parsed.text === "string" && parsed.text.trim().length > 0
      ? parsed.text
      : htmlToText(parsed.html ?? "");

  return {
    from: parsed.from?.address ?? "",
    // A display name the sender chose, kept only because it is what a person
    // would write in a greeting. Never derived from the address.
    fromName: cleanName(parsed.from?.name),
    to: parsed.to?.[0]?.address,
    subject: (parsed.subject ?? "").slice(0, 500),
    bodyText: normalise(text),
    messageId: parsed.messageId ?? undefined,
    inReplyTo: parsed.inReplyTo ?? undefined,
    references: parseReferences(parsed.references),
    attachments: (parsed.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? undefined,
      contentType: attachment.mimeType ?? "application/octet-stream",
      bytes:
        attachment.content instanceof ArrayBuffer
          ? new Uint8Array(attachment.content)
          : new TextEncoder().encode(String(attachment.content ?? "")),
    })),
  };
}

/**
 * A readable plain-text rendering of an HTML mail.
 *
 * Not a sanitiser — a sanitiser produces HTML, and producing HTML is the thing
 * being avoided. Script and style blocks go first (their *contents* are not
 * text anybody wants to read), block-level tags become newlines, everything
 * else is stripped, and entities are decoded last so that a decoded `<` cannot
 * reintroduce a tag.
 */
export function htmlToText(html: string): string {
  if (html.trim().length === 0) return "";
  return normalise(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, "&"),
  );
}

/** `References` is a space-separated list of `<id>` tokens, and clients wrap it
 * across lines. Split on whitespace, keep what looks like an id. */
export function parseReferences(value: string | string[] | undefined | null): string[] {
  if (!value) return [];
  const flat = Array.isArray(value) ? value.join(" ") : value;
  return flat
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.startsWith("<") && token.endsWith(">"))
    .slice(-50);
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function cleanName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return undefined;
  // A display name that is just the address is not a name.
  return trimmed.includes("@") ? undefined : trimmed;
}
