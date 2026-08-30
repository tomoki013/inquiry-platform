import { useQuery } from "@tanstack/react-query";
import type { AppSummary } from "@tomokichi/admin-contracts";
import { useState } from "react";
import { Link } from "react-router";
import { DataState, Page, StatusPill, Timestamp } from "../components/primitives";
import { api } from "../lib/api";

/** Every app the Studio runs, and how much each is currently asking of you. */
export function Apps() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const apps = useQuery({
    queryKey: ["apps", includeArchived],
    queryFn: () => api.get<AppSummary[]>(`/api/apps?includeArchived=${includeArchived}`),
  });

  return (
    <Page
      title="アプリ"
      description="Tomokichi Studio のアプリ"
      actions={
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          アーカイブ済みも表示
        </label>
      }
    >
      <DataState
        loading={apps.isLoading}
        error={apps.error}
        empty={(apps.data?.length ?? 0) === 0}
        emptyMessage="登録されているアプリがありません。"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {(apps.data ?? []).map((app) => (
            <Link
              key={app.id}
              to={`/apps/${app.id}`}
              className="block rounded-lg border border-line bg-surface p-4 transition-colors hover:bg-line-soft/50"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ink">
                  {app.name}
                  {app.archivedAt ? (
                    <span className="ml-2 text-xs text-ink-faint">（アーカイブ済み）</span>
                  ) : null}
                </span>
                <StatusPill status={app.status} />
              </div>
              <dl className="mt-3 flex gap-6 text-xs">
                <div>
                  <dt className="text-ink-faint">未対応の通報</dt>
                  <dd className="mt-0.5 tabular-nums text-ink">{app.openReports}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">未対応の問い合わせ</dt>
                  <dd className="mt-0.5 tabular-nums text-ink">{app.openSupport}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">更新</dt>
                  <dd className="mt-0.5 text-ink">
                    <Timestamp value={app.updatedAt} />
                  </dd>
                </div>
              </dl>
            </Link>
          ))}
        </div>
      </DataState>
    </Page>
  );
}
