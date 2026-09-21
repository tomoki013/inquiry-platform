/**
 * base64url, as the Push API speaks it.
 *
 * `PushSubscription.toJSON()` hands over `p256dh` and `auth` in this alphabet
 * with no padding, VAPID keys are conventionally exchanged the same way, and a
 * JWT is made of it. Nothing here depends on `Buffer`: the Workers runtime has
 * `atob` / `btoa` and no Node.
 */
/** Bytes over a plain `ArrayBuffer`, which is what Web Crypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Bytes {
  const normalised = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function utf8(value: string): Bytes {
  return new TextEncoder().encode(value) as Bytes;
}

export function concat(...parts: Uint8Array[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
