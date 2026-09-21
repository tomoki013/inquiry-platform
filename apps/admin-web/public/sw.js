/**
 * The admin screen's service worker.
 *
 * It exists for two things: Web Push, and being installable to a home screen
 * (iOS requires a service worker for a Home Screen web app to receive push at
 * all). It is deliberately *not* an offline cache. Everything this screen
 * shows is somebody's private writing, and Cache Storage is readable by
 * anything that can open the browser profile; so no ticket, no API response
 * and no page is ever stored here. When the network is gone, the screen says
 * so and nothing else.
 *
 * Plain JavaScript, served from `public/`, so there is no build step between
 * what is read here and what runs.
 */

const APP_ORIGIN = self.location.origin;
const DEFAULT_TITLE = "Tomokichi Admin";

self.addEventListener("install", () => {
  // Take over on the next navigation rather than waiting for every tab to
  // close: the client asks for this with `skipWaiting` below once the person
  // has chosen to reload, and a first install has nothing to wait for.
});

self.addEventListener("activate", (event) => {
  // Nothing cached, nothing to clean up. Claiming clients lets a push
  // subscription made right after install use this worker without a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/**
 * Network only. The one thing added is an answer for a navigation that could
 * not reach the server, so an installed app that is offline shows a sentence
 * instead of the platform's blank error page. Non-navigation requests are
 * left to the browser entirely.
 */
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        }),
    ),
  );
});

const OFFLINE_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tomokichi Admin</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;color:#2c2f38;background:#fcfcfd}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1rem;font-weight:500;margin:0 0 .5rem}p{margin:0;color:#6b7080}button{margin-top:1.25rem;padding:.5rem 1rem;border:1px solid #e3e4e8;border-radius:.375rem;background:#fff;color:inherit;font:inherit}</style>
</head><body><main><h1>オフラインです</h1><p>管理画面はネットワーク接続が必要です。問い合わせや通報の内容はこの端末に保存されません。</p><button type="button" onclick="location.reload()">再読み込み</button></main></body></html>`;

/**
 * A push arrives.
 *
 * The payload is a ticket number, a category and a path — see
 * `PushPayload` in `@tomokichi/admin-contracts`. What is shown is built from
 * those and from fixed strings; there is no field in the payload that could
 * carry a message, and if one appeared it would not be rendered.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const category = payload.category === "report" ? "report" : "inquiry";
  const ticketNumber = typeof payload.ticketNumber === "string" ? payload.ticketNumber : "";
  const app = typeof payload.app === "string" ? payload.app : "";
  const url =
    safePath(payload.url) ||
    (ticketNumber ? `/tickets/${encodeURIComponent(ticketNumber)}` : "/tickets");

  const body = category === "report" ? "新しい通報があります" : "新しいお問い合わせがあります";
  const detail = [app, ticketNumber ? `#${ticketNumber}` : ""].filter(Boolean).join(" • ");

  event.waitUntil(
    self.registration.showNotification(DEFAULT_TITLE, {
      body: detail ? `${body}\n${detail}` : body,
      // One notification per ticket: a retry replaces rather than stacks.
      tag: ticketNumber ? `ticket:${ticketNumber}` : undefined,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    }),
  );
});

/**
 * A tap.
 *
 * An open admin window is focused and sent to the ticket; otherwise one is
 * opened. If the person is signed out, Access takes the navigation to its
 * login page and returns them to the same URL afterwards — the ticket path is
 * the whole of what is carried, so there is nothing else to preserve.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(safePath(event.notification.data?.url) || "/tickets", APP_ORIGIN).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((client) => client.url.startsWith(APP_ORIGIN));
      if (existing) {
        return existing
          .focus()
          .then((focused) => ("navigate" in focused ? focused.navigate(url) : focused));
      }
      return self.clients.openWindow(url);
    }),
  );
});

/**
 * When the push service silently replaces the subscription, register the new
 * one under the same operator — the cookie still rides along on the request.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  const next = event.newSubscription;
  if (!next) return;
  const json = next.toJSON();
  event.waitUntil(
    fetch("/api/notifications/push/subscriptions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    }).catch(() => undefined),
  );
});

/** Same-origin absolute paths only. No query string, no other origin. */
function safePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "";
  if (value.includes("?") || value.includes("#")) return "";
  return value;
}
