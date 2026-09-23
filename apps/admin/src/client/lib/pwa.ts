import { useEffect, useState } from "react";

/**
 * The service worker, from the app's side.
 *
 * Registration happens once, after load, and asks for nothing: no permission
 * prompt, no install prompt. The one thing the app wants to know from it is
 * whether a newer worker — a newer deploy — is waiting, so the person can
 * choose to reload rather than finding out mid-form.
 */
export function supportsServiceWorker(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

let registration: Promise<ServiceWorkerRegistration | undefined> | undefined;

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!supportsServiceWorker()) return Promise.resolve(undefined);
  registration ??= navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .catch(() => undefined);
  return registration;
}

/** True once a newer worker is installed and waiting behind the current one. */
export function useServiceWorkerUpdate(): { updateReady: boolean; reload: () => void } {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!supportsServiceWorker()) return;
    let cancelled = false;
    void registerServiceWorker().then((reg) => {
      if (!reg || cancelled) return;
      if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            setWaiting(installing);
          }
        });
      });
    });
    // Once the new worker takes over, load the matching bundle.
    const onControllerChange = () => window.location.reload();
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return {
    updateReady: waiting !== null,
    reload: () => waiting?.postMessage({ type: "SKIP_WAITING" }),
  };
}
