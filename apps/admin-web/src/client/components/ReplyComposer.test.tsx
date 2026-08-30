import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SupportThreadDetail } from "@tomokichi/admin-contracts";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyComposer } from "./ReplyComposer";

/**
 * The composer, from the operator's side.
 *
 * Every call goes through `fetch`, so the assertions here are about *which
 * endpoint was hit* — which is the level at which the internal-note guarantee
 * is visible from the browser: pressing "メモを追加" must never produce a request
 * to the reply route.
 */

const thread: SupportThreadDetail = {
  id: "thread-1",
  source: "email",
  requesterEmail: "someone@example.com",
  subject: "アプリで共有できません",
  status: "open",
  unreadCount: 1,
  lastMessageAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  createdAt: "2026-08-29T00:00:00.000Z",
  messages: [],
};

let calls: { url: string; method: string; body?: unknown }[] = [];
let draftBody: string | null = null;

function stubFetch(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    const json = (data: unknown) =>
      new Response(JSON.stringify({ ok: true, data }), {
        headers: { "Content-Type": "application/json" },
      });

    if (url.endsWith("/draft") && method === "GET") {
      return json(
        draftBody === null ? null : { threadId: thread.id, bodyText: draftBody, updatedAt: "" },
      );
    }
    if (url.endsWith("/draft") && method === "PUT") {
      draftBody = (body as { bodyText: string }).bodyText;
      return json({ threadId: thread.id, bodyText: draftBody, updatedAt: "" });
    }
    if (url.includes("/templates")) {
      return json(
        overrides.templates ?? [
          {
            id: "tpl-1",
            key: "remeet_general",
            name: "一般返信",
            category: "general",
            body: "",
            includeSignature: true,
            isActive: true,
            sortOrder: 0,
            createdAt: "",
            updatedAt: "",
          },
        ],
      );
    }
    if (url.includes("/apply-template")) {
      return json({ bodyText: "定型文の本文", unresolved: [] });
    }
    if (url.endsWith("/reply")) {
      return json({ ...thread, messages: [] });
    }
    if (url.endsWith("/notes")) {
      return json({ ...thread, messages: [] });
    }
    return json(null);
  });
}

function renderComposer(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  calls = [];
  draftBody = null;
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("internal notes", () => {
  /**
   * The front-end half of the guarantee `SupportService` enforces on the
   * server. If this ever fails, somebody has wired the note button to the send
   * path — which would email a private operator note to a customer.
   */
  it("never touch the reply endpoint", async () => {
    const user = userEvent.setup();
    renderComposer(<ReplyComposer thread={thread} mailConfigured />);

    await user.click(screen.getByRole("tab", { name: "運営メモ" }));
    await user.type(screen.getByRole("textbox"), "この人は以前も同じ質問をしている");
    await user.click(screen.getByRole("button", { name: "メモを追加" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/notes"))).toBe(true);
    });
    expect(calls.some((call) => call.url.endsWith("/reply"))).toBe(false);
  });

  it("say plainly that they are not sent to the customer", async () => {
    const user = userEvent.setup();
    renderComposer(<ReplyComposer thread={thread} mailConfigured />);
    await user.click(screen.getByRole("tab", { name: "運営メモ" }));
    expect(screen.getByText(/メール送信されません/)).toBeInTheDocument();
  });
});

describe("drafts", () => {
  it("restore what was being written when the thread is reopened", async () => {
    draftBody = "前回の続きです";
    renderComposer(<ReplyComposer thread={thread} mailConfigured />);

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveValue("前回の続きです");
    });
  });

  it("autosave after typing stops, not on every keystroke", async () => {
    const user = userEvent.setup();
    renderComposer(<ReplyComposer thread={thread} mailConfigured />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());

    await user.type(screen.getByRole("textbox"), "ご連絡ありがとうございます");

    await waitFor(
      () => {
        expect(screen.getByText("下書き保存済み")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    const saves = calls.filter((call) => call.method === "PUT");
    expect(saves).toHaveLength(1);
    expect(saves[0]?.body).toEqual({ bodyText: "ご連絡ありがとうございます" });
  });
});

describe("templates", () => {
  it("insert straight into an empty composer", async () => {
    const user = userEvent.setup();
    renderComposer(<ReplyComposer thread={thread} mailConfigured />);
    // Wait for the template list itself, not just the empty <select>.
    await screen.findByRole("option", { name: "一般返信" });

    await user.selectOptions(screen.getByRole("combobox"), "tpl-1");

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveValue("定型文の本文");
    });
  });

  /** Losing a half-written reply to a mis-click is the small disaster that
   * makes people stop trusting a composer. */
  it("ask before replacing something already written", async () => {
    const user = userEvent.setup();
    draftBody = "書きかけの返信";
    renderComposer(<ReplyComposer thread={thread} mailConfigured />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("書きかけの返信"));
    await screen.findByRole("option", { name: "一般返信" });

    await user.selectOptions(screen.getByRole("combobox"), "tpl-1");

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("書きかけの返信");

    await user.click(screen.getByRole("button", { name: "末尾に追加" }));
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveValue("書きかけの返信\n\n定型文の本文");
    });
  });

  it("let the operator back out with Escape", async () => {
    const user = userEvent.setup();
    draftBody = "書きかけの返信";
    renderComposer(<ReplyComposer thread={thread} mailConfigured />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("書きかけの返信"));
    await screen.findByRole("option", { name: "一般返信" });

    await user.selectOptions(screen.getByRole("combobox"), "tpl-1");
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox")).toHaveValue("書きかけの返信");
  });
});

describe("sending", () => {
  it("is disabled, with a reason, when no provider is configured", async () => {
    renderComposer(<ReplyComposer thread={thread} mailConfigured={false} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
    expect(screen.getByText("メール送信機能が設定されていません。")).toBeInTheDocument();
  });

  it("is disabled for a thread marked spam", async () => {
    renderComposer(<ReplyComposer thread={{ ...thread, status: "spam" }} mailConfigured />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });

  it("is disabled while the body is empty", async () => {
    renderComposer(<ReplyComposer thread={thread} mailConfigured />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });

  it("sends one request carrying one idempotency key", async () => {
    const user = userEvent.setup();
    renderComposer(<ReplyComposer thread={thread} mailConfigured />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());

    await user.type(screen.getByRole("textbox"), "返信します");
    await user.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/reply"))).toBe(true);
    });
    const send = calls.find((call) => call.url.endsWith("/reply"));
    const body = send?.body as { bodyText: string; idempotencyKey: string };
    expect(body.bodyText).toBe("返信します");
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // The browser never says who the mail goes to.
    expect(Object.keys(body)).not.toContain("to");
    expect(Object.keys(body)).not.toContain("subject");
  });

  it("asks before reopening a resolved thread", async () => {
    const user = userEvent.setup();
    renderComposer(<ReplyComposer thread={{ ...thread, status: "resolved" }} mailConfigured />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());

    await user.type(screen.getByRole("textbox"), "追加のご案内です");
    await user.click(screen.getByRole("button", { name: "送信" }));

    await screen.findByRole("dialog");
    expect(calls.some((call) => call.url.endsWith("/reply"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "再開して返信" }));
    await waitFor(() => {
      const send = calls.find((call) => call.url.endsWith("/reply"));
      expect(send).toBeDefined();
      expect((send?.body as { reopenIfResolved: boolean } | undefined)?.reopenIfResolved).toBe(
        true,
      );
    });
  });
});
