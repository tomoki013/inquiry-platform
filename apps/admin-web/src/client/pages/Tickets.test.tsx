import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tickets } from "./Tickets";

let requests: URLSearchParams[];
beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://admin.example.invalid");
    if (url.pathname === "/api/tickets") requests.push(url.searchParams);
    const data = url.pathname.endsWith("/masters")
      ? { services: [], components: [], categories: [], groups: [], assignees: [], sla: [] }
      : { items: [], total: 0 };
    return new Response(JSON.stringify({ ok: true, data }));
  });
});
afterEach(() => vi.unstubAllGlobals());
function mount(entry = "/tickets", report = false) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter initialEntries={[entry]}>
        <Tickets type={report ? "REPORT" : undefined} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it("defaults to open tickets and switches queues without retaining a closed status", async () => {
  mount();
  await waitFor(() => expect(requests.at(-1)?.get("queue")).toBe("OPEN"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "クローズ済み" }));
  await waitFor(() => expect(requests.at(-1)?.get("status")).toBe("CLOSED"));
  await user.click(screen.getByRole("button", { name: "未確認" }));
  await waitFor(() => expect(requests.at(-1)?.get("queue")).toBe("UNACKNOWLEDGED"));
  expect(requests.at(-1)?.has("status")).toBe(false);
  await user.click(screen.getByRole("button", { name: "対応中" }));
  await waitFor(() => expect(requests.at(-1)?.get("status")).toBe("IN_PROGRESS"));
  expect(requests.at(-1)?.has("queue")).toBe(false);
  await user.click(screen.getByRole("button", { name: "すべて" }));
  await waitFor(() => expect(requests.at(-1)?.has("status")).toBe(false));
  expect(requests.at(-1)?.has("queue")).toBe(false);
  expect(screen.getByRole("button", { name: "すべて" })).toHaveAttribute("aria-pressed", "true");
});
it("keeps report/service filters while resetting pagination on a one-tap queue change", async () => {
  mount("/reports?status=CLOSED&service_id=remeet&offset=50", true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "未完了" }));
  await waitFor(() => expect(requests.at(-1)?.get("queue")).toBe("OPEN"));
  const query = requests.at(-1);
  expect(query?.get("type")).toBe("REPORT");
  expect(query?.get("service_id")).toBe("remeet");
  expect(query?.has("status")).toBe(false);
  expect(query?.has("offset")).toBe(false);
});
