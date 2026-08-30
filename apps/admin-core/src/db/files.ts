import { sha256Hex } from "../domain/identity";

/**
 * The private bucket.
 *
 * Two rules, both enforced by this file being the only way in: no public URL is
 * ever produced, and the key is never something a caller supplied. A filename
 * from an email is attacker-controlled text, and using it as a key would let a
 * `../` walk out of the prefix — the id we generated goes in the path and the
 * original name goes in the database as a label.
 */
export class FileStore {
  constructor(private readonly bucket: R2Bucket) {}

  static reportKey(reportId: string, attachmentId: string): string {
    return `reports/${reportId}/${attachmentId}`;
  }

  static supportKey(threadId: string, messageId: string, attachmentId: string): string {
    return `support/${threadId}/${messageId}/${attachmentId}`;
  }

  async put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ sha256: string; byteSize: number }> {
    const sha256 = await sha256Hex(bytes);
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType },
      // Lets a re-uploaded object be recognised as the same bytes without
      // reading it back out.
      customMetadata: { sha256 },
    });
    return { sha256, byteSize: bytes.byteLength };
  }

  get(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key);
  }
}

/**
 * What an attachment is allowed to be served as.
 *
 * Anything not on this list is sent as `application/octet-stream` with
 * `Content-Disposition: attachment`, so a `.svg` or an `.html` a stranger
 * emailed us cannot execute script in the admin origin by being previewed.
 */
const INLINE_SAFE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
  "text/plain",
]);

export function dispositionFor(
  contentType: string,
  filename: string | undefined,
): { contentType: string; disposition: string } {
  const normalised = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const safe = INLINE_SAFE_TYPES.has(normalised);
  // The filename is quoted and stripped of anything that could break out of the
  // header. Non-ASCII is dropped rather than encoded: the label is a
  // convenience, and the database keeps the real name.
  const label = (filename ?? "attachment").replace(/[^\w.-]/g, "_").slice(0, 100);
  return {
    contentType: safe ? normalised : "application/octet-stream",
    disposition: `${safe ? "inline" : "attachment"}; filename="${label}"`,
  };
}
