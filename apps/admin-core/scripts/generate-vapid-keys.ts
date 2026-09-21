/**
 * Prints a fresh VAPID key pair, once, for the operator to put in place:
 *
 *   VAPID_PUBLIC_KEY  → `vars` in wrangler.jsonc (not secret; browsers get it)
 *   VAPID_PRIVATE_KEY → `wrangler secret put VAPID_PRIVATE_KEY`
 *
 * Rotating the pair invalidates every existing subscription: browsers hold
 * the public key they subscribed with and the push services refuse a token
 * signed by anything else. Every device then has to be registered again from
 * the settings screen.
 *
 * Self-contained on Node's Web Crypto rather than importing
 * `@tomokichi/admin-push`, because `node --experimental-strip-types` wants
 * explicit `.ts` extensions the package (bundled everywhere else) does not
 * use. The format is the same one `importVapid` reads: the public key as a
 * 65-byte uncompressed P-256 point and the private key as its 32-byte scalar,
 * both base64url.
 */
const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const publicRaw = new Uint8Array(
  (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
);
const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
if (!jwk.d) throw new Error("private key export produced no scalar");

console.log(`VAPID_PUBLIC_KEY=${Buffer.from(publicRaw).toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);

export {};
