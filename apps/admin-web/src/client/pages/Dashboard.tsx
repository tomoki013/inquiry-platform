import { useQuery } from "@tanstack/react-query";
import type { DashboardSummary } from "@tomokichi/admin-contracts";
import { Link } from "react-router";
import { Card, DataState, Page, StatusPill, Timestamp } from "../components/primitives";
import { api } from "../lib/api";

/**
 * The front page.
 *
 * Three numbers and a list of what happened. Deliberately not a metrics screen:
 * there is nothing here to plot that would change what an operator does next,
 * and a page of charts nobody acts on is a page nobody reads.
 */
export function Dashboard() {
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardSummary>("/api/dashboard"),
  });

  return (
    <Page title="ダッシュボード" description="Tomokichi Studio の運営状況">
      <DataState
        loading={dashboard.isLoading}
        error={dashboard.error}
        empty={false}
        emptyMessage=""
      >
        {dashboard.data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric
                label="未対応の通報"
                value={dashboard.data.openReports}
                to="/reports?status=open"
              />
              <Metric
                label="確認中"
                value={dashboard.data.reviewingReports}
                to="/reports?status=reviewing"
              />
              <Metric
                label="未対応の問い合わせ"
                // Before any mail has arrived, "0" is a confident claim about a
                // feature that is not wired up yet. An em dash is the honest
                // answer.
                value={dashboard.data.supportConfigured ? dashboard.data.openSupport : "—"}
                to="/support?status=open"
              />
            </div>

            <section className="mt-10">
              <h2 className="mb-3 text-sm font-medium text-ink">アプリ</h2>
              <DataState
                loading={false}
                error={null}
                empty={dashboard.data.apps.length === 0}
                emptyMessage="登録されているアプリがありません。"
              >
                <Card className="divide-y divide-line-soft">
                  {dashboard.data.apps.map((app) => (
                    <Link
                      key={app.id}
                      to={`/apps/${app.id}`}
                      className="flex items-center justify-between px-4 py-3 text-sm hover:bg-line-soft/60"
                    >
                      <span className="text-ink">{app.name}</span>
                      <StatusPill status={app.status} />
                    </Link>
                  ))}
                </Card>
              </DataState>
            </section>

            <section className="mt-10">
              <h2 className="mb-3 text-sm font-medium text-ink">最近の操作履歴</h2>
              <DataState
                loading={false}
                error={null}
                empty={dashboard.data.recentActivity.length === 0}
                emptyMessage="まだ記録がありません。"
              >
                <ul className="space-y-2">
                  {dashboard.data.recentActivity.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-baseline justify-between gap-4 text-sm"
                    >
                      <span className="text-ink-soft">
                        <span className="font-mono text-xs text-ink">{entry.action}</span>
                        <span className="ml-2 text-ink-faint">{entry.actorType}</span>
                      </span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        <Timestamp value={entry.createdAt} />
                      </span>
                    </li>
                  ))}
                </ul>
              </DataState>
            </section>
          </>
        ) : null}
      </DataState>
    </Page>
  );
}

function Metric({ label, value, to }: { label: string; value: number | string; to: string }) {
  return (
    <Link
      to={to}
      className="rounded-lg border border-line bg-surface px-4 py-5 transition-colors hover:bg-line-soft/50"
    >
      <p className="text-xs text-ink-soft">{label}</p>
      <p className="mt-2 text-2xl font-light tabular-nums text-ink">{value}</p>
    </Link>
  );
}
