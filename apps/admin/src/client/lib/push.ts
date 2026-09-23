import { registerServiceWorker } from "./pwa";

/**
 * Web Push, from the browser's side.
 *
 * Everything that asks the person for something — the permission prompt —
 * happens only inside {@link subscribeThisDevice}, which is only called from
 * the button on the notification settings screen. Nothing on load, nothing
 * on first visit.
 */
export type PushSupport = "supported" | "unsupported" | "needs-install";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    // iOS and iPadOS only expose Web Push to a Home Screen web app.
    return isIosSafari() && !isStandalone() ? "needs-install" : "unsupported";
  }
  return "supported";
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function permissionState(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** The subscription this browser holds, if any. Its endpoint is what
 * "unregister this device" sends. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registerServiceWorker();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export type SubscribeResult =
  | { ok: true; subscription: PushSubscriptionJSON }
  | { ok: false; reason: "denied" | "unsupported" | "failed" };

/**
 * Asks, then subscribes. The `applicationServerKey` is the VAPID public key
 * Admin Core handed the settings screen; a browser subscribed with one key
 * will refuse pushes signed with another, which is why rotating it means
 * re-registering every device.
 */
export async function subscribeThisDevice(publicKey: string): Promise<SubscribeResult> {
  if (pushSupport() !== "supported") return { ok: false, reason: "unsupported" };
  const reg = await registerServiceWorker();
  if (!reg) return { ok: false, reason: "unsupported" };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" };
  try {
    const subscription =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
      }));
    return { ok: true, subscription: subscription.toJSON() };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Drops the browser-side subscription. The server is told separately. */
export async function unsubscribeThisDevice(): Promise<string | null> {
  const subscription = await currentSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  try {
    await subscription.unsubscribe();
  } catch {
    /* The server-side revoke still goes ahead. */
  }
  return endpoint;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalised = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
