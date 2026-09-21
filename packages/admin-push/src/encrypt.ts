import { type Bytes, concat, decodeBase64Url, utf8 } from "./base64url";

/**
 * Message encryption for Web Push — RFC 8291, with the `aes128gcm` content
 * coding of RFC 8188 — on Web Crypto alone.
 *
 * Every Node Web Push library reaches for `crypto.createECDH` and
 * `crypto.hkdfSync`, neither of which exists in a Cloudflare Worker. What does
 * exist is `crypto.subtle`, and it has every primitive the RFC needs: ECDH on
 * P-256, HKDF with SHA-256, and AES-GCM. This file is the RFC, step by step,
 * and `push.test.ts` runs it against the RFC's own worked example so that a
 * mistake in the derivation cannot pass as a "works on my phone".
 *
 * One record. A notification payload here is a ticket number and a category
 * — well under the 4096-byte record size — so the multi-record path of RFC
 * 8188 is not implemented rather than implemented untested.
 */

const RECORD_SIZE = 4096;
/** The largest plaintext one record carries: rs minus the AES-GCM tag and the
 * one-byte padding delimiter. */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - 16 - 1;

export interface SubscriptionKeys {
  /** The browser's P-256 public key, base64url, 65 bytes uncompressed. */
  p256dh: string;
  /** The browser's 16-byte authentication secret, base64url. */
  auth: string;
}

/** Only the tests pass these: a fixed salt and sender key make the output
 * comparable to the RFC's vector. Production draws both fresh per message. */
export interface EncryptionOverrides {
  salt?: Bytes;
  senderKeyPair?: CryptoKeyPair;
}

export class InvalidSubscriptionKeysError extends Error {
  constructor() {
    super("subscription keys are not a valid P-256 point and 16-byte secret");
    this.name = "InvalidSubscriptionKeysError";
  }
}

export async function encryptPayload(
  plaintext: Bytes,
  keys: SubscriptionKeys,
  overrides: EncryptionOverrides = {},
): Promise<Bytes> {
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`payload exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }

  const receiverPublicRaw = decodeBase64Url(keys.p256dh);
  const authSecret = decodeBase64Url(keys.auth);
  if (
    receiverPublicRaw.byteLength !== 65 ||
    receiverPublicRaw[0] !== 0x04 ||
    authSecret.byteLength !== 16
  ) {
    throw new InvalidSubscriptionKeysError();
  }

  let receiverPublic: CryptoKey;
  try {
    receiverPublic = await crypto.subtle.importKey(
      "raw",
      receiverPublicRaw,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    throw new InvalidSubscriptionKeysError();
  }

  const sender =
    overrides.senderKeyPair ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const senderPublicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer,
  );
  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 §3.1: ecdh_secret = ECDH(as_private, ua_public)
  // Typed loosely on purpose: the DOM lib spells this parameter `public` and
  // the Workers types spell it `$public`, and the runtime wants `public`.
  const ecdh = { name: "ECDH", public: receiverPublic } as unknown as Parameters<
    SubtleCrypto["deriveBits"]
  >[0];
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, sender.privateKey, 256));

  // RFC 8291 §3.3–3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(utf8("WebPush: info\0"), receiverPublicRaw, senderPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 §2.2: CEK and nonce from the salt and IKM.
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // RFC 8188 §2: the last (and here the only) record ends with a 0x02 delimiter.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
  );

  // RFC 8188 §2.1 header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(as_public, 65)
  const header = new Uint8Array(16 + 4 + 1 + senderPublicRaw.byteLength);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublicRaw.byteLength;
  header.set(senderPublicRaw, 21);

  return concat(header, ciphertext);
}

/** HKDF-SHA256 extract-then-expand, which is what `deriveBits` does in one go. */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}
