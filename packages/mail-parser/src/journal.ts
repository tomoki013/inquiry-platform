export const INBOUND_PREFIX = "inbound-jobs/";
export const MAX_INBOUND_BYTES = 5 * 1024 * 1024;

/** Bound the stream itself, even when a sender's declared size is inaccurate. */
export async function readInboundBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INBOUND_BYTES) {
        await reader.cancel();
        throw new RangeError("MAIL_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Both Workers journal into the same private bucket; retries retain the original clock. */
export async function persistInboundMail(
  bucket: R2Bucket,
  bytes: Uint8Array,
  to: string,
  projectSlug = "",
): Promise<{ id: string; key: string }> {
  if (!to || to.length > 254 || (projectSlug && !/^[a-z0-9-]{1,64}$/.test(projectSlug)))
    throw new Error("INVALID_MAIL_ROUTE");
  if (bytes.byteLength > MAX_INBOUND_BYTES) throw new RangeError("MAIL_TOO_LARGE");
  const route = await hash(new TextEncoder().encode(`${projectSlug}:${to}`));
  const id = `inbound-${route.slice(0, 16)}-${await hash(bytes)}`;
  const key = INBOUND_PREFIX + id;
  if (!(await bucket.head(key)))
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { projectSlug, to, createdAt: new Date().toISOString() },
    });
  return { id, key };
}
