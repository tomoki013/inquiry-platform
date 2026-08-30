import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AppDetail as App,
  AppLinkType,
  AppPlatform,
  AppStatus,
  AuditEntry,
  ReportListPage,
  SupportThreadListPage,
} from "@tomokichi/admin-contracts";
import { appLinkTypes, appPlatforms, appStatuses } from "@tomokichi/admin-contracts";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Dialog } from "../components/Dialog";
import {
  Button,
  Card,
  DataState,
  inputClass,
  Page,
  StatusPill,
  Timestamp,
} from "../components/primitives";
import { api } from "../lib/api";
import { appLinkTypeLabels, appPlatformLabels, appStatusLabels } from "../lib/labels";

type Tab = "overview" | "reports" | "support" | "links" | "activity";

const TAB_LABELS: Record<Tab, string> = {
  overview: "概要",
  reports: "通報",
  support: "問い合わせ",
  links: "リンク",
  activity: "操作履歴",
};

/** One app: what it is, what is outstanding for it, and what has happened. */
export function AppDetail() {
  const { id = "" } = useParams();
  const client = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [confirmArchive, setConfirmArchive] = useState(false);

  const app = useQuery({ queryKey: ["app", id], queryFn: () => api.get<App>(`/api/apps/${id}`) });

  const onUpdated = (updated: App) => {
    client.setQueryData(["app", id], updated);
    void client.invalidateQueries({ queryKey: ["apps"] });
  };

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      api.post<App>(`/api/apps/${id}/${archived ? "archive" : "restore"}`, {}),
    onSuccess: (updated) => {
      setConfirmArchive(false);
      onUpdated(updated);
    },
  });

  const data = app.data;

  return (
    <Page
      title={data?.name ?? "アプリ"}
      description={data ? `${data.slug} · ${appPlatformLabels[data.platform]}` : undefined}
      actions={
        data ? (
          data.archivedAt ? (
            <Button onClick={() => archive.mutate(false)}>アーカイブを解除</Button>
          ) : (
            <Button onClick={() => setConfirmArchive(true)}>アーカイブ</Button>
          )
        ) : undefined
      }
    >
      <DataState loading={app.isLoading} error={app.error} empty={false} emptyMessage="">
        {data ? (
          <>
            <div role="tablist" aria-label="アプリのタブ" className="mb-6 flex flex-wrap gap-1">
              {(["overview", "reports", "support", "links", "activity"] as Tab[]).map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={tab === name}
                  onClick={() => setTab(name)}
                  className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                    tab === name
                      ? "bg-accent-soft text-accent"
                      : "text-ink-soft hover:bg-line-soft hover:text-ink"
                  }`}
                >
                  {TAB_LABELS[name]}
                </button>
              ))}
            </div>

            {tab === "overview" ? <Overview app={data} onUpdated={onUpdated} /> : null}
            {tab === "reports" ? <AppReports appId={data.id} /> : null}
            {tab === "support" ? <AppSupport appId={data.id} /> : null}
            {tab === "links" ? <Links app={data} onUpdated={onUpdated} /> : null}
            {tab === "activity" ? <Activity appId={data.id} /> : null}
          </>
        ) : null}
      </DataState>

      <Dialog
        open={confirmArchive}
        title="このアプリをアーカイブしますか？"
        onClose={() => setConfirmArchive(false)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirmArchive(false)}>
              キャンセル
            </Button>
            <Button variant="primary" onClick={() => archive.mutate(true)}>
              アーカイブする
            </Button>
          </>
        }
      >
        一覧から非表示になります。通報や問い合わせの履歴は残り、削除はされません。
      </Dialog>
    </Page>
  );
}

function Overview({ app, onUpdated }: { app: App; onUpdated: (app: App) => void }) {
  const [form, setForm] = useState({
    name: app.name,
    description: app.description ?? "",
    platform: app.platform,
    bundleId: app.bundleId ?? "",
    status: app.status,
    publicUrl: app.publicUrl ?? "",
    supportUrl: app.supportUrl ?? "",
    appStoreUrl: app.appStoreUrl ?? "",
  });

  const save = useMutation({
    mutationFn: () => api.patch<App>(`/api/apps/${app.id}`, form),
    onSuccess: onUpdated,
  });
  const fields = (save.error as { fields?: Record<string, string> } | null)?.fields;

  return (
    <Card className="space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Text
          label="名前"
          value={form.name}
          onChange={(v) => setForm({ ...form, name: v })}
          error={fields?.name}
        />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">ステータス</span>
          <select
            className={inputClass}
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as AppStatus })}
          >
            {appStatuses.map((status) => (
              <option key={status} value={status}>
                {appStatusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">プラットフォーム</span>
          <select
            className={inputClass}
            value={form.platform}
            onChange={(e) => setForm({ ...form, platform: e.target.value as AppPlatform })}
          >
            {appPlatforms.map((platform) => (
              <option key={platform} value={platform}>
                {appPlatformLabels[platform]}
              </option>
            ))}
          </select>
        </label>
        <Text
          label="Bundle ID"
          value={form.bundleId}
          onChange={(v) => setForm({ ...form, bundleId: v })}
          error={fields?.bundleId}
        />
        <Text
          label="Public URL"
          value={form.publicUrl}
          onChange={(v) => setForm({ ...form, publicUrl: v })}
          error={fields?.publicUrl}
        />
        <Text
          label="Support URL"
          value={form.supportUrl}
          onChange={(v) => setForm({ ...form, supportUrl: v })}
          error={fields?.supportUrl}
        />
        <Text
          label="App Store URL"
          value={form.appStoreUrl}
          onChange={(v) => setForm({ ...form, appStoreUrl: v })}
          error={fields?.appStoreUrl}
        />
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-soft">説明</span>
        <textarea
          className={`${inputClass} min-h-24`}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </label>
      {/* No API key field, and no feature flags: this screen describes an app,
          it does not configure one. */}
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "保存中…" : "保存"}
        </Button>
        {save.error ? (
          <span role="alert" className="text-xs text-danger">
            {(save.error as Error).message}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function Links({ app, onUpdated }: { app: App; onUpdated: (app: App) => void }) {
  const [draft, setDraft] = useState({
    type: "brand" as AppLinkType,
    label: "",
    url: "",
    sortOrder: 0,
  });
  const add = useMutation({
    mutationFn: () => api.post<App>(`/api/apps/${app.id}/links`, draft),
    onSuccess: (updated) => {
      setDraft({ type: "brand", label: "", url: "", sortOrder: 0 });
      onUpdated(updated);
    },
  });
  const remove = useMutation({
    mutationFn: (linkId: string) => api.del<App>(`/api/apps/links/${linkId}`),
    onSuccess: onUpdated,
  });

  return (
    <div className="space-y-5">
      <Card className="divide-y divide-line-soft">
        {app.links.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-faint">リンクがありません。</p>
        ) : (
          app.links.map((link) => (
            <div key={link.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm text-ink">{link.label}</p>
                <p className="truncate text-xs text-ink-faint">
                  {appLinkTypeLabels[link.type]} · {link.url}
                </p>
              </div>
              <Button variant="quiet" onClick={() => remove.mutate(link.id)}>
                削除
              </Button>
            </div>
          ))
        )}
      </Card>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">種類</span>
            <select
              className={inputClass}
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as AppLinkType })}
            >
              {appLinkTypes.map((type) => (
                <option key={type} value={type}>
                  {appLinkTypeLabels[type]}
                </option>
              ))}
            </select>
          </label>
          <Text
            label="表示名"
            value={draft.label}
            onChange={(v) => setDraft({ ...draft, label: v })}
          />
          <div className="sm:col-span-2">
            <Text
              label="URL"
              value={draft.url}
              onChange={(v) => setDraft({ ...draft, url: v })}
              error={(add.error as { fields?: Record<string, string> } | null)?.fields?.url}
            />
          </div>
        </div>
        <div className="mt-3">
          <Button
            disabled={draft.label.trim() === "" || draft.url.trim() === "" || add.isPending}
            onClick={() => add.mutate()}
          >
            リンクを追加
          </Button>
        </div>
      </Card>
    </div>
  );
}

function AppReports({ appId }: { appId: string }) {
  const reports = useQuery({
    queryKey: ["reports", { appId }],
    queryFn: () => api.get<ReportListPage>(`/api/reports?appId=${appId}`),
  });
  return (
    <DataState
      loading={reports.isLoading}
      error={reports.error}
      empty={(reports.data?.items.length ?? 0) === 0}
      emptyMessage="このアプリの通報はありません。"
    >
      <Card className="divide-y divide-line-soft">
        {(reports.data?.items ?? []).map((report) => (
          <Link
            key={report.id}
            to={`/reports/${report.id}`}
            className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-line-soft/50"
          >
            <span className="font-mono text-xs text-accent">{report.externalReportId}</span>
            <span className="text-ink-soft">{report.reasonCode}</span>
            <StatusPill status={report.status} />
          </Link>
        ))}
      </Card>
    </DataState>
  );
}

function AppSupport({ appId }: { appId: string }) {
  const threads = useQuery({
    queryKey: ["support-threads", { appId }],
    queryFn: () => api.get<SupportThreadListPage>(`/api/support/threads?appId=${appId}`),
  });
  return (
    <DataState
      loading={threads.isLoading}
      error={threads.error}
      empty={(threads.data?.items.length ?? 0) === 0}
      emptyMessage="このアプリの問い合わせはありません。"
    >
      <Card className="divide-y divide-line-soft">
        {(threads.data?.items ?? []).map((thread) => (
          <Link
            key={thread.id}
            to={`/support/${thread.id}`}
            className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-line-soft/50"
          >
            <span className="min-w-0 truncate text-ink">{thread.subject}</span>
            <StatusPill status={thread.status} />
          </Link>
        ))}
      </Card>
    </DataState>
  );
}

function Activity({ appId }: { appId: string }) {
  const activity = useQuery({
    queryKey: ["activity", appId],
    queryFn: () => api.get<AuditEntry[]>(`/api/activity?appId=${appId}`),
  });
  return (
    <DataState
      loading={activity.isLoading}
      error={activity.error}
      empty={(activity.data?.length ?? 0) === 0}
      emptyMessage="記録がありません。"
    >
      <ul className="space-y-2">
        {(activity.data ?? []).map((entry) => (
          <li key={entry.id} className="flex items-baseline justify-between gap-4 text-sm">
            <span className="font-mono text-xs text-ink">{entry.action}</span>
            <span className="text-xs text-ink-faint">
              <Timestamp value={entry.createdAt} />
            </span>
          </li>
        ))}
      </ul>
    </DataState>
  );
}

function Text({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} />
      {error ? (
        <span role="alert" className="mt-1 block text-xs text-danger">
          {error}
        </span>
      ) : null}
    </label>
  );
}
