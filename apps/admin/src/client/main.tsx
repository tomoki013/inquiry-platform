import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { registerServiceWorker } from "./lib/pwa";
import { AppDetail } from "./pages/AppDetail";
import { Apps } from "./pages/Apps";
import { NotificationSettings } from "./pages/NotificationSettings";
import { ReplyTemplates } from "./pages/ReplyTemplates";
import { TicketDetail } from "./pages/TicketDetail";
import { TicketSettings } from "./pages/TicketSettings";
import { LegacyTicketRedirect, TicketOperationsDashboard, Tickets } from "./pages/Tickets";
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
            <Route index element={<TicketOperationsDashboard />} />
            <Route path="tickets" element={<Tickets />} />
            <Route path="tickets/settings" element={<TicketSettings />} />
            <Route path="settings/notifications" element={<NotificationSettings />} />
            <Route path="tickets/:id" element={<TicketDetail />} />
            <Route path="incidents" element={<Tickets type="INCIDENT" />} />
            <Route path="reports" element={<Tickets type="REPORT" />} />
            <Route path="reports/:id" element={<LegacyTicketRedirect kind="report" />} />
            <Route path="support" element={<Tickets type="INQUIRY" />} />
            <Route path="support/templates" element={<ReplyTemplates />} />
            <Route path="support/:id" element={<LegacyTicketRedirect kind="support" />} />
            <Route path="apps" element={<Apps />} />
            <Route path="apps/:id" element={<AppDetail />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

// Installable and push-capable; asks for nothing. Permission is requested
// only from the notification settings screen, by a button.
window.addEventListener("load", () => void registerServiceWorker());

function NotFound() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-20 text-sm text-ink-faint">
      そのページはありません。
    </div>
  );
}
