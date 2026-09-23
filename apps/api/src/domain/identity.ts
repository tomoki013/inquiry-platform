/**
 * Turning an app's own user id into something this database can hold.
 *
 * Remeet's author ids are CloudKit record names that mean something inside
 * Remeet. Storing them here would put a second copy of Remeet's identity graph
 * in a system whose only job is moderation, and a plain SHA-256 would not help:
 * anybody with the original list — which the app backend has — could hash it
 * and match every row.
 *
 * HMAC with a pepper this Worker holds and the app backends do not breaks that.
 * The value is still stable, so "the same person was reported twice" is still
 * answerable, and still useless to anybody who gets the table without the key.
 */
export async function pseudonymise(
  identifier: string,
  pepper: string | undefined,
): Promise<string | undefined> {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) return undefined;
  if (!pepper) {
    // Refusing outright would mean a preview environment silently drops the
    // "same author again" signal *and* an operator never learns why. Marking it
    // is honest, and the value is obviously not a reference to anything.
    return "unpeppered";
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(trimmed));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 64);
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const source =
    bytes instanceof Uint8Array
      ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      : bytes;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
