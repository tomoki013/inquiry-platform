import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { AppDetail } from "./pages/AppDetail";
import { Apps } from "./pages/Apps";
import { Dashboard } from "./pages/Dashboard";
import { ReplyTemplates } from "./pages/ReplyTemplates";
import { ReportDetail } from "./pages/ReportDetail";
import { Reports } from "./pages/Reports";
import { SupportInbox } from "./pages/SupportInbox";
import { SupportThread } from "./pages/SupportThread";
import "./styles.css";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // A moderation queue is read, acted on, and read again. Refetching on
      // focus is right here; retrying a 403 is not.
      retry: (failureCount, error) =>
        failureCount < 2 &&
        !(error instanceof Error && /UNAUTHORIZED|FORBIDDEN|NOT_FOUND/.test(error.message)),
      staleTime: 15_000,
    },
  },
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="reports" element={<Reports />} />
            <Route path="reports/:id" element={<ReportDetail />} />
            <Route path="support" element={<SupportInbox />} />
            <Route path="support/templates" element={<ReplyTemplates />} />
            <Route path="support/:id" element={<SupportThread />} />
            <Route path="apps" element={<Apps />} />
            <Route path="apps/:id" element={<AppDetail />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

function NotFound() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-20 text-sm text-ink-faint">
      そのページはありません。
    </div>
  );
}
