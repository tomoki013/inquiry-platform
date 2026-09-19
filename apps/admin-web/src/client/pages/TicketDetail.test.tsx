import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TicketDetail as Detail, Ticket, TicketMasters } from "@tomokichi/admin-contracts";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TicketDetail } from "./TicketDetail";

const ticket: Ticket = {
  id: "ticket-1",
  ticket_number: "TK-000001",
  type: "INQUIRY",
  status: "NEW",
  resolution: null,
  priority: "P3",
  impact: "MEDIUM",
  urgency: "MEDIUM",
  priority_override: null,
  service_id: "studio",
  service_name: "tmkch.io",
  component_id: null,
  category_id: null,
  assignment_group_id: null,
  assignee_id: null,
  subject: "共有できない",
  summary: null,
  requester_id: null,
  requester_email: null,
  created_at: "2026-09-18T00:00:00.000Z",
  updated_at: "2026-09-18T00:00:00.000Z",
  acknowledged_at: null,
  first_response_at: null,
  resolved_at: null,
  closed_at: null,
  next_action: null,
  next_action_at: null,
  revision: 0,
  merged_into: null,
  sla_ack_minutes: 480,
  sla_response_minutes: 1440,
  sla_resolution_minutes: 4320,
  sla_state: "OK",
  report_id: null,
  thread_id: null,
};
const masters: TicketMasters = {
  services: [{ id: "studio", name: "tmkch.io", is_active: 1 }],
  components: [],
  categories: [],
  groups: [],
  assignees: [],
  sla: [],
};
let detail: Detail;
let requests: Array<{ url: string; method: string; body: Record<string, unknown> }>;
beforeEach(() => {
  detail = { ticket: { ...ticket }, timeline: [], totalTimeline: 0, relations: [] };
  requests = [];
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input),
      method = init?.method ?? "GET",
      body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ url, method, body });
    if (url.endsWith("/ack"))
      detail.ticket = { ...detail.ticket, status: "ACKNOWLEDGED", revision: 1 };
    if (method === "PATCH")
      detail.ticket = { ...detail.ticket, ...body, revision: detail.ticket.revision + 1 };
    const data = url.endsWith("/masters")
      ? masters
      : url.endsWith("/session")
        ? { mailConfigured: false }
        : detail;
    return new Response(JSON.stringify({ ok: true, data }), {
      headers: { "Content-Type": "application/json" },
    });
  });
});
afterEach(() => vi.unstubAllGlobals());
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={["/tickets/ticket-1"]}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it("ACKs through the dedicated API and refreshes the lifecycle", async () => {
  mount();
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: "確認済みにする" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "確認済みにする" })).not.toBeInTheDocument(),
  );
  expect(requests.some((r) => r.url.endsWith("/ack") && r.method === "POST")).toBe(true);
});
it("persists lifecycle and resolution with optimistic revision", async () => {
  mount();
  const u = userEvent.setup();
  await u.selectOptions(await screen.findByRole("combobox", { name: "状態" }), "RESOLVED");
  await u.selectOptions(screen.getByRole("combobox", { name: "処理結果" }), "SPAM");
  await u.click(screen.getByRole("button", { name: "運用情報を保存" }));
  await waitFor(() =>
    expect(requests.find((r) => r.method === "PATCH")?.body).toMatchObject({
      id: "ticket-1",
      revision: 0,
      status: "RESOLVED",
      resolution: "SPAM",
    }),
  );
});
it("shows internal messages and resolution history in the same timeline", async () => {
  detail.timeline = [
    {
      kind: "message",
      value: {
        id: "m1",
        ticket_id: ticket.id,
        direction: "OUTBOUND",
        visibility: "INTERNAL",
        sender: "operator",
        recipient: null,
        subject: null,
        body: "内部調査のメモ",
        created_at: ticket.created_at,
        legacy_message_id: null,
      },
    },
    {
      kind: "event",
      value: {
        id: "e1",
        ticket_id: ticket.id,
        event_type: "DETAILS_CHANGED",
        actor_id: "operator",
        metadata: JSON.stringify({ resolution: { from: null, to: "FIXED" } }),
        created_at: ticket.created_at,
      },
    },
  ];
  detail.totalTimeline = 2;
  mount();
  expect(await screen.findByText("内部調査のメモ")).toBeVisible();
  expect(screen.getByText("処理結果: — → FIXED")).toBeVisible();
  expect(requests.every((r) => r.method === "GET")).toBe(true);
});
