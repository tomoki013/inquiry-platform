import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AppSummary,
  SupportStatus,
  SupportThreadDetail as Thread,
} from "@tomokichi/admin-contracts";
import { supportStatuses } from "@tomokichi/admin-contracts";
import { useParams } from "react-router";
import { Card, DataState, inputClass, Page, StatusPill, Timestamp } from "../components/primitives";
import { ReplyComposer } from "../components/ReplyComposer";
import { api } from "../lib/api";
import { supportStatusLabels } from "../lib/labels";

const DIRECTION_LABEL = {
  inbound: "お客様",
  outbound: "Tomokichi Studio",
  internal_note: "運営メモ",
} as const;

/** One conversation: the messages, who it is about, and the composer. */
export function SupportThread() {
  const { id = "" } = useParams();
  const client = useQueryClient();

  const thread = useQuery({
    queryKey: ["support-thread", id],
    queryFn: () => api.get<Thread>(`/api/support/threads/${id}`),
  });
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.get<AppSummary[]>("/api/apps") });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<{ mailConfigured: boolean }>("/api/session"),
  });

  const update = (updated: Thread) => {
    client.setQueryData(["support-thread", id], updated);
    void client.invalidateQueries({ queryKey: ["support-threads"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const setStatus = useMutation({
    mutationFn: (status: SupportStatus) =>
      api.post<Thread>(`/api/support/threads/${id}/status`, { status }),
    onSuccess: update,
  });
  const setApp = useMutation({
    mutationFn: (appId: string) =>
      api.post<Thread>(`/api/support/threads/${id}/app`, { appId: appId || null }),
    onSuccess: update,
  });

  const data = thread.data;

  return (
    <Page title={data?.subject ?? "問い合わせ"} description={data?.requesterEmail}>
      <DataState loading={thread.isLoading} error={thread.error} empty={false} emptyMessage="">
        {data ? (
          <div className="space-y-6">
            <Card className="flex flex-wrap items-end gap-4 p-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-soft">ステータス</span>
                <select
                  className={inputClass}
                  value={data.status}
                  onChange={(event) => setStatus.mutate(event.target.value as SupportStatus)}
                >
                  {supportStatuses.map((status) => (
                    <option key={status} value={status}>
                      {supportStatusLabels[status]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-soft">アプリ</span>
                <select
                  className={inputClass}
                  value={data.appId ?? ""}
                  onChange={(event) => setApp.mutate(event.target.value)}
                >
                  <option value="">未設定</option>
                  {(apps.data ?? []).map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="ml-auto flex items-center gap-3 text-xs text-ink-faint">
                <StatusPill status={data.status} />
                <span>{data.source}</span>
              </div>
            </Card>

            <ol className="space-y-4">
              {data.messages.map((message) => (
                <li
                  key={message.id}
                  className={`rounded-lg border p-4 ${
                    message.direction === "internal_note"
                      ? "border-warn/30 bg-warn-soft/40"
                      : message.direction === "outbound"
                        ? "border-line bg-accent-soft/40"
                        : "border-line bg-surface"
                  }`}
                >
                  <p className="mb-2 flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-medium text-ink">
                      {DIRECTION_LABEL[message.direction]}
                    </span>
                    <span className="text-ink-faint">
                      <Timestamp value={message.createdAt} />
                    </span>
                  </p>
                  {/* Plain text, always. Inbound HTML was flattened in the mail
                      Worker before it was ever stored, and nothing in this
                      application renders user-written markup. */}
                  <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">
                    {message.bodyText}
                  </p>
                  {message.attachments.length > 0 ? (
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {message.attachments.map((attachment) => (
                        <li key={attachment.id}>
                          <a
                            href={`/api/support/messages/${message.id}/attachments/${attachment.id}`}
                            className="rounded-md border border-line px-2 py-1 text-xs text-accent hover:bg-line-soft"
                          >
                            {attachment.originalFilename ?? "添付ファイル"} (
                            {Math.round(attachment.byteSize / 1024)} KB)
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>

            <ReplyComposer thread={data} mailConfigured={session.data?.mailConfigured ?? false} />
          </div>
        ) : null}
      </DataState>
    </Page>
  );
}
