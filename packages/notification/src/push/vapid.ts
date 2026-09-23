import { decodeBase64Url, encodeBase64Url, utf8 } from "./base64url";

/**
 * VAPID — RFC 8292 — on Web Crypto.
 *
 * The push service wants proof that whoever is posting to a subscription is
 * the same application server the browser subscribed with. That proof is a
 * short-lived ES256 JWT over the push service's origin, signed by the key
 * whose public half the browser was given as `applicationServerKey`.
 *
 * Keys are held in the format the rest of the ecosystem uses: the public key
 * as a 65-byte uncompressed P-256 point and the private key as its 32-byte
 * scalar, both base64url. `generate-vapid-keys.ts` produces exactly this.
 */

export interface VapidConfig {
  /** base64url, 65 bytes. Also what the browser subscribes with. */
  publicKey: string;
  /** base64url, 32 bytes. A Secret. */
  privateKey: string;
  /** `mailto:` or `https:` — who the push service may contact about abuse. */
  subject: string;
}

export interface VapidSigner {
  readonly publicKey: string;
  /** The `Authorization` header value for a push to `endpoint`. */
  authorization(endpoint: string, now?: Date): Promise<string>;
}

/** Twelve hours. RFC 8292 allows up to 24; shorter costs nothing here because
 * a header is signed per send. */
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

export async function importVapid(config: VapidConfig): Promise<VapidSigner> {
  if (!/^(mailto:|https:)/.test(config.subject)) {
    throw new Error("VAPID subject must be a mailto: or https: URL");
  }
  const publicRaw = decodeBase64Url(config.publicKey);
  const privateRaw = decodeBase64Url(config.privateKey);
  if (publicRaw.byteLength !== 65 || publicRaw[0] !== 0x04 || privateRaw.byteLength !== 32) {
    throw new Error("VAPID keys must be a 65-byte P-256 point and a 32-byte scalar");
  }

  // Web Crypto imports a private EC key only as JWK or PKCS#8; JWK needs the
  // public coordinates alongside the scalar, and the public key has them.
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: encodeBase64Url(publicRaw.slice(1, 33)),
      y: encodeBase64Url(publicRaw.slice(33, 65)),
      d: encodeBase64Url(privateRaw),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const publicKey = config.publicKey;
  return {
    publicKey,
    async authorization(endpoint, now = new Date()) {
      const audience = new URL(endpoint).origin;
      const header = encodeBase64Url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
      const claims = encodeBase64Url(
        utf8(
          JSON.stringify({
            aud: audience,
            exp: Math.floor(now.getTime() / 1000) + TOKEN_LIFETIME_SECONDS,
            sub: config.subject,
          }),
        ),
      );
      const signingInput = `${header}.${claims}`;
      // Web Crypto's ECDSA output is already the raw `r || s` that JWS ES256
      // specifies — no DER to unpack.
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          privateKey,
          utf8(signingInput),
        ),
      );
      return `vapid t=${signingInput}.${encodeBase64Url(signature)}, k=${publicKey}`;
    },
  };
}

/** A fresh key pair in the exchange format above. Used by the operator script
 * and by the tests; never at runtime. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (!jwk.d) throw new Error("private key export produced no scalar");
  return { publicKey: encodeBase64Url(publicRaw), privateKey: jwk.d };
}
