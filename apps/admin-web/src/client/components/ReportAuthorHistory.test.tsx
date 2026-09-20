import { render, screen } from "@testing-library/react";
import type { ReportDetail } from "@tomokichi/admin-contracts";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { ReportAuthorHistory } from "./ReportAuthorHistory";

const report: ReportDetail = {
  id: "r1",
  appId: "remeet",
  appSlug: "remeet",
  appName: "Remeet",
  externalReportId: "external",
  contentType: "waitingMemory",
  reasonCode: "spam",
  status: "open",
  priority: "normal",
  createdAt: "2026-09-19T00:00:00Z",
  updatedAt: "2026-09-19T00:00:00Z",
  events: [],
  attachments: [],
};
it("shows same-author counts without identifying them as confirmed violations", () => {
  render(
    <MemoryRouter>
      <ReportAuthorHistory
        report={{
          ...report,
          authorRefHash: "a".repeat(64),
          authorHistory: { total: 3, uniqueReporters: 2, actioned: 1, recent: [report] },
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("3件")).toBeInTheDocument();
  expect(screen.getByText("2 ID")).toBeInTheDocument();
  expect(screen.getByText(/違反確定件数ではありません/)).toBeInTheDocument();
  expect(screen.getByText(/この通報/).closest("a")).toHaveAttribute("href", "/reports/r1");
});
it("shows unknown rather than treating missing authors as one person", () => {
  render(
    <MemoryRouter>
      <ReportAuthorHistory report={report} />
    </MemoryRouter>,
  );
  expect(screen.getByText("不明（投稿者IDの記録なし）")).toBeInTheDocument();
  expect(screen.queryByText(/同じ投稿者への通報/)).not.toBeInTheDocument();
});
