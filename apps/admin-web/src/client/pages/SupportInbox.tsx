import { useQuery } from "@tanstack/react-query";
import type { AppSummary, SupportThreadListPage } from "@tomokichi/admin-contracts";
import { Link, useSearchParams } from "react-router";
import { Card, DataState, inputClass, Page, StatusPill, Timestamp } from "../components/primitives";
import { api, query } from "../lib/api";
import { requesterLine, supportSourceLabels } from "../lib/labels";

const TABS = [
  { label: "すべて", status: "" },
  { label: "未対応", status: "open" },
  { label: "返信待ち", status: "pending_user" },
  { label: "解決済み", status: "resolved" },
  { label: "迷惑メール", status: "spam" },
] as const;

/** The inbox. One row per conversation, newest activity first. */
export function SupportInbox() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const appId = params.get("appId") ?? "";
  const search = params.get("query") ?? "";

  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.get<AppSummary[]>("/api/apps") });
  const threads = useQuery({
    queryKey: ["support-threads", { status, appId, search }],
    queryFn: () =>
      api.get<SupportThreadListPage>(
        `/api/support/threads${query({ status, appId, query: search })}`,
      ),
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <Page title="問い合わせ" description="問い合わせの受信箱">
      <div role="tablist" aria-label="ステータス" className="mb-5 flex flex-wrap gap-1">
        {TABS.map((tab) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            aria-selected={status === tab.status}
            onClick={() => setParam("status", tab.status)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              status === tab.status
                ? "bg-accent-soft text-accent"
                : "text-ink-soft hover:bg-line-soft hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">アプリ</span>
          <select
            className={inputClass}
            value={appId}
            onChange={(e) => setParam("appId", e.target.value)}
          >
            <option value="">すべて</option>
            {(apps.data ?? []).map((app) => (
              <option key={app.id} value={app.id}>
                {app.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">
            メールアドレス / スレッド ID
          </span>
          <input
            className={inputClass}
            value={search}
            placeholder="完全一致"
            onChange={(e) => setParam("query", e.target.value)}
          />
        </label>
      </div>

      <DataState
        loading={threads.isLoading}
        error={threads.error}
        empty={(threads.data?.items.length ?? 0) === 0}
        emptyMessage="該当する問い合わせはありません。"
      >
        <Card className="divide-y divide-line-soft">
          {(threads.data?.items ?? []).map((thread) => (
            <Link
              key={thread.id}
              to={`/support/${thread.id}`}
              className="block px-4 py-3 hover:bg-line-soft/50"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm text-ink">
                  {thread.subject}
                  {thread.unreadCount > 0 ? (
                    <span className="ml-2 rounded-full bg-accent px-1.5 py-0.5 text-[0.65rem] text-white">
                      {thread.unreadCount}
                    </span>
                  ) : null}
                </span>
                <StatusPill status={thread.status} />
              </div>
              <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-faint">
                {/* The name only when the person gave one — an app's form asks
                    for it, an email usually carries one, and neither is
                    guaranteed. Never derived from the address. */}
                <span>{requesterLine(thread)}</span>
                {thread.source !== "email" ? (
                  <span>{supportSourceLabels[thread.source]}</span>
                ) : null}
                {thread.appName ? <span>{thread.appName}</span> : null}
                <Timestamp value={thread.lastMessageAt} />
              </p>
            </Link>
          ))}
        </Card>
        <p className="mt-3 text-xs text-ink-faint">{threads.data?.total ?? 0} 件</p>
      </DataState>
    </Page>
  );
}
