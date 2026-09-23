import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationSettings } from "./NotificationSettings";

/*
 * The one rule about permission prompts: they happen when the person presses
 * the button, and not before. The fake `Notification` below records every
 * call to `requestPermission`; rendering the screen must leave it at zero.
 */

let posted: Array<{ path: string; body: unknown }>;
let requestPermission: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;

const overview = {
  pushPublicKey: "BPUBLIC",
  emailConfigured: true,
  settings: { inquiryPush: true, reportPush: true, emailEnabled: true },
  devices: [{ id: "d1", deviceName: "iPhone", createdAt: "2026-09-21T00:00:00.000Z" }],
};

beforeEach(() => {
  posted = [];
  requestPermission = vi.fn().mockResolvedValue("granted");
  subscribe = vi.fn().mockResolvedValue({
    endpoint: "https://push.example/new",
    toJSON: () => ({ endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" } }),
  });
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  vi.stubGlobal("PushManager", function PushManager() {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue({
        pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe },
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://admin.example.invalid");
    if (init?.method && init.method !== "GET") {
      posted.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true, data: { id: "d2" } }));
    }
    return new Response(JSON.stringify({ ok: true, data: overview }));
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter initialEntries={["/settings/notifications"]}>
        <NotificationSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("asks for permission only when the button is pressed, then registers this device", async () => {
  mount();
  const button = await screen.findByRole("button", { name: "Push通知を有効にする" });
  expect(requestPermission).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();

  await userEvent.setup().click(button);

  await waitFor(() => expect(posted).toHaveLength(1));
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(posted[0]?.path).toBe("/api/notifications/push/subscriptions");
  expect(posted[0]?.body).toMatchObject({
    endpoint: "https://push.example/new",
    keys: { p256dh: "p", auth: "a" },
  });
  expect(await screen.findByRole("status")).toHaveTextContent("この端末を登録しました");
});

it("shows the devices by name and never by endpoint, and saves a toggle", async () => {
  mount();
  expect(await screen.findByText("iPhone")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("push.example");

  await userEvent.setup().click(screen.getByRole("checkbox", { name: /通報通知/ }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toEqual({
    path: "/api/notifications/settings",
    body: { inquiryPush: true, reportPush: false, emailEnabled: true },
  });
  expect(requestPermission).not.toHaveBeenCalled();
});

it("explains rather than prompts when the environment has no push keys", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ ok: true, data: { ...overview, pushPublicKey: undefined } })),
  );
  mount();
  expect(await screen.findByText(/Push通知が設定されていません/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Push通知を有効にする" })).toBeNull();
  expect(requestPermission).not.toHaveBeenCalled();
});
