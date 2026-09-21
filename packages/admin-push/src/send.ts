import { type Bytes, utf8 } from "./base64url";
import { encryptPayload, InvalidSubscriptionKeysError, type SubscriptionKeys } from "./encrypt";
import type { VapidSigner } from "./vapid";

/**
 * One push, to one subscription.
 *
 * The shape of the answer is what the caller has to act on: a subscription
 * the push service says is gone must be removed, a rejected or failed send is
 * logged and nothing else, and none of it may fail the thing that was being
 * notified about. Nothing here throws for a delivery problem.
 */
export interface PushSubscriptionTarget extends SubscriptionKeys {
  endpoint: string;
}

export type PushDeliveryResult =
  | { ok: true; status: number }
  /** 404 / 410 from the push service, or keys that cannot encrypt: the
   * subscription is dead and should be revoked. */
  | { ok: false; gone: true; status?: number }
  | { ok: false; gone: false; status?: number; reason: "rejected" | "transport" | "payload" };

export interface SendOptions {
  /** Seconds the push service keeps the message for an offline device. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Injectable for tests. Wrapped rather than the bare global for the reason
   * `ResendMailProvider` documents: calling a stored `fetch` with the wrong
   * receiver is an `Illegal invocation` in the Workers runtime. */
  fetcher?: typeof fetch;
}

export async function sendWebPush(
  target: PushSubscriptionTarget,
  payload: string,
  vapid: VapidSigner,
  options: SendOptions = {},
): Promise<PushDeliveryResult> {
  let body: Bytes;
  try {
    body = await encryptPayload(utf8(payload), target);
  } catch (error) {
    if (error instanceof InvalidSubscriptionKeysError) return { ok: false, gone: true };
    return { ok: false, gone: false, reason: "payload" };
  }

  let authorization: string;
  try {
    authorization = await vapid.authorization(target.endpoint);
  } catch {
    return { ok: false, gone: false, reason: "payload" };
  }

  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetcher(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(options.ttl ?? 86_400),
        Urgency: options.urgency ?? "normal",
      },
      body,
    });
  } catch {
    return { ok: false, gone: false, reason: "transport" };
  }

  if (response.ok) return { ok: true, status: response.status };
  if (response.status === 404 || response.status === 410) {
    return { ok: false, gone: true, status: response.status };
  }
  return { ok: false, gone: false, status: response.status, reason: "rejected" };
}
