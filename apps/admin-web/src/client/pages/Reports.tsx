import { useQuery } from "@tanstack/react-query";
import type { AppSummary, ReportListPage } from "@tomokichi/admin-contracts";
import { reportStatuses } from "@tomokichi/admin-contracts";
import { Link, useSearchParams } from "react-router";
import { Card, DataState, inputClass, Page, StatusPill, Timestamp } from "../components/primitives";
import { api, query } from "../lib/api";
import { reportStatusLabels } from "../lib/labels";

/**
 * The moderation queue.
 *
 * Filters live in the URL, not in component state, so a filtered view is a link
 * somebody can keep — which is what an operator actually does when they are
 * working through one app's reports over a couple of days.
 */
export function Reports() {
  const [params, setParams] = useSearchParams();
  const filters = {
    appId: params.get("appId") ?? "",
    status: params.get("status") ?? "",
    reasonCode: params.get("reasonCode") ?? "",
    contentType: params.get("contentType") ?? "",
    query: params.get("query") ?? "",
  };

  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.get<AppSummary[]>("/api/apps") });
  const reports = useQuery({
    queryKey: ["reports", filters],
    queryFn: () => api.get<ReportListPage>(`/api/reports${query(filters)}`),
  });

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <Page title="通報" description="各アプリから届いたコンテンツ通報">
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Select label="アプリ" value={filters.appId} onChange={(v) => setFilter("appId", v)}>
          <option value="">すべて</option>
          {(apps.data ?? []).map((app) => (
            <option key={app.id} value={app.id}>
              {app.name}
            </option>
          ))}
        </Select>
        <Select label="ステータス" value={filters.status} onChange={(v) => setFilter("status", v)}>
          <option value="">すべて</option>
          {reportStatuses.map((status) => (
            <option key={status} value={status}>
              {reportStatusLabels[status]}
            </option>
          ))}
        </Select>
        <Text
          label="理由"
          value={filters.reasonCode}
          onChange={(v) => setFilter("reasonCode", v)}
        />
        <Text
          label="コンテンツ種別"
          value={filters.contentType}
          onChange={(v) => setFilter("contentType", v)}
        />
        <Text
          label="通報 ID"
          value={filters.query}
          placeholder="完全一致"
          onChange={(v) => setFilter("query", v)}
        />
      </div>

      <DataState
        loading={reports.isLoading}
        error={reports.error}
        empty={(reports.data?.items.length ?? 0) === 0}
        emptyMessage="条件に一致する通報はありません。"
      >
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-soft">
              <tr>
                <Th>アプリ</Th>
                <Th>通報 ID</Th>
                <Th>コンテンツ</Th>
                <Th>理由</Th>
                <Th>優先度</Th>
                <Th>ステータス</Th>
                <Th>受信</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {(reports.data?.items ?? []).map((report) => (
                <tr key={report.id} className="hover:bg-line-soft/50">
                  <Td>{report.appName}</Td>
                  <Td>
                    <Link
                      to={`/reports/${report.id}`}
                      className="font-mono text-xs text-accent underline-offset-2 hover:underline"
                    >
                      {report.externalReportId}
                    </Link>
                  </Td>
                  <Td>{report.contentType}</Td>
                  <Td>{report.reasonCode}</Td>
                  <Td>{report.priority}</Td>
                  <Td>
                    <StatusPill status={report.status} />
                  </Td>
                  <Td>
                    <span className="text-xs text-ink-faint">
                      <Timestamp value={report.createdAt} />
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-3 text-xs text-ink-faint">{reports.data?.total ?? 0} 件</p>
      </DataState>
    </Page>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 font-medium">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 align-middle">{children}</td>;
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function Text({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      <input
        className={inputClass}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
