/**
 * Web Push for the admin screen, on nothing but Web Crypto and `fetch`.
 *
 * Why not `web-push` from npm: it is written against Node's `crypto` module
 * (`createECDH`, `hkdfSync`, `createSign`) and a Cloudflare Worker has none of
 * that without `nodejs_compat` polyfills that are partial for exactly these
 * calls. The RFCs are short; the vector in `push.test.ts` is the proof.
 *
 * What crosses this boundary is a subscription, a small string and a VAPID
 * signer. The package never sees a ticket, a message or a person — the
 * caller decides what a payload says, and this package would carry anything.
 */
export { decodeBase64Url, encodeBase64Url } from "./base64url";
export {
  encryptPayload,
  InvalidSubscriptionKeysError,
  MAX_PLAINTEXT_BYTES,
  type SubscriptionKeys,
} from "./encrypt";
export {
  type PushDeliveryResult,
  type PushSubscriptionTarget,
  type SendOptions,
  sendWebPush,
} from "./send";
export { generateVapidKeys, importVapid, type VapidConfig, type VapidSigner } from "./vapid";
