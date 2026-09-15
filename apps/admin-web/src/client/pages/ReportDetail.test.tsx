import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ReportDetail } from "./ReportDetail";

function setup(fail = false) {
  const writes: Record<string, unknown>[] = [];
  const report = {
    id: "r1",
    appName: "Remeet",
    status: "open",
    priority: "normal",
    reasonCode: "spam",
    contentType: "wish",
    externalReportId: "ext",
    createdAt: new Date().toISOString(),
    updatedAt: "2026-09-14T00:00:00Z",
    resolutionCode: "content_hidden",
    resolutionNote: "以前のメモ",
    attachments: [],
    events: [],
  };
  vi.stubGlobal("fetch", async (_: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      if (fail)
        return new Response(
          JSON.stringify({
            ok: false,
            error: { code: "INTERNAL_ERROR", message: "保存に失敗しました" },
          }),
          { status: 500 },
        );
    }
    return new Response(JSON.stringify({ ok: true, data: report }));
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={["/reports/r1"]}>
        <Routes>
          <Route path="/reports/:id" element={<ReportDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return writes;
}

afterEach(() => vi.unstubAllGlobals());

it("preserves the saved code while editing the note and permits clearing it", async () => {
  const writes = setup();
  const user = userEvent.setup();
  const note = await screen.findByLabelText("対応メモ");
  expect(screen.getByLabelText("対応コード")).toHaveValue("content_hidden");
  await user.clear(note);
  await user.type(note, "追記");
  await user.click(screen.getByRole("button", { name: "記録する" }));
  await waitFor(() =>
    expect(writes[0]).toEqual({ resolutionCode: "content_hidden", resolutionNote: "追記" }),
  );
  await user.clear(screen.getByLabelText("対応メモ"));
  await user.click(screen.getByRole("button", { name: "記録する" }));
  await waitFor(() =>
    expect(writes[1]).toEqual({ resolutionCode: "content_hidden", resolutionNote: "" }),
  );
});

it("preserves the saved note when editing only the code", async () => {
  const writes = setup();
  const user = userEvent.setup();
  const code = await screen.findByLabelText("対応コード");
  await user.clear(code);
  await user.type(code, "no_action");
  await user.click(screen.getByRole("button", { name: "記録する" }));
  await waitFor(() =>
    expect(writes[0]).toEqual({ resolutionCode: "no_action", resolutionNote: "以前のメモ" }),
  );
});

it("shows save errors without clearing the operator's input", async () => {
  setup(true);
  const user = userEvent.setup();
  await screen.findByLabelText("対応コード");
  await user.click(screen.getByRole("button", { name: "記録する" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存に失敗しました");
  expect(screen.getByLabelText("対応メモ")).toHaveValue("以前のメモ");
});
