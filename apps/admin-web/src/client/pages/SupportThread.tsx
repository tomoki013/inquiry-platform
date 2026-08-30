import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AppSummary,
  SupportMessage,
  SupportStatus,
  SupportThreadDetail as Thread,
} from "@tomokichi/admin-contracts";
import { supportStatuses } from "@tomokichi/admin-contracts";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { Card, DataState, inputClass, Page, StatusPill, Timestamp } from "../components/primitives";
import { ReplyComposer } from "../components/ReplyComposer";
import { api } from "../lib/api";
import { splitFormSubject, supportSourceLabels, supportStatusLabels } from "../lib/labels";

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
    <Page title={data?.subject ?? "問い合わせ"}>
      <DataState loading={thread.isLoading} error={thread.error} empty={false} emptyMessage="">
        {data ? (
          <div className="space-y-6">
            <ThreadHeader thread={data} />

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
            </Card>

            <ol className="space-y-4">
              {data.messages.map((message) => (
                <Message key={message.id} thread={data} message={message} />
              ))}
            </ol>

            <ReplyComposer thread={data} mailConfigured={session.data?.mailConfigured ?? false} />
          </div>
        ) : null}
      </DataState>
    </Page>
  );
}

/**
 * The top of the conversation, shaped like the header of an email.
 *
 * A thread that arrived as mail is the common case and the one everything else
 * is a variation on, so it is what the layout is built around: who wrote,
 * what address it came to, when.
 *
 * A submission from an app's support form is the same thing with more known
 * about it — which app, which category the person picked, which request id
 * their receipt quotes. Those rows only exist when there is something to put
 * in them, so an ordinary email is not padded with empty labels.
 */
function ThreadHeader({ thread }: { thread: Thread }) {
  const first = thread.messages.find((message) => message.direction === "inbound");
  const form = splitFormSubject(thread.subject);
  const isForm = thread.source === "web_form";

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusPill status={thread.status} />
        <span className="rounded-full bg-line-soft px-2 py-0.5 text-xs text-ink-soft">
          {supportSourceLabels[thread.source]}
        </span>
        {thread.appName ? (
          <span className="rounded-full bg-line-soft px-2 py-0.5 text-xs text-ink-soft">
            {thread.appName}
          </span>
        ) : null}
      </div>

      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Row label="差出人">
          {thread.requesterName ? (
            <>
              <span className="text-ink">{thread.requesterName}</span>{" "}
              <span className="text-ink-soft">&lt;{thread.requesterEmail}&gt;</span>
            </>
          ) : (
            thread.requesterEmail
          )}
        </Row>
        {/* Which address it was sent to. Worth showing because there is more
            than one — the live `support@tmkch.io` and whatever else Email
            Routing points at the ingress Worker. */}
        {first?.recipient ? <Row label="宛先">{first.recipient}</Row> : null}
        <Row label="受信">
          <Timestamp value={thread.createdAt} />
        </Row>
        {thread.resolvedAt ? (
          <Row label="解決">
            <Timestamp value={thread.resolvedAt} />
          </Row>
        ) : null}
        {isForm && form.category ? <Row label="種別">{form.category}</Row> : null}
        {isForm && form.requestId ? (
          <Row label="受付ID">
            <span className="font-mono text-xs">{form.requestId}</span>
          </Row>
        ) : null}
      </dl>
    </Card>
  );
}

/**
 * One message, addressed.
 *
 * The sender and recipient are shown rather than only "お客様" / "Tomokichi
 * Studio", because a thread can involve more than one address on either side
 * and knowing which one a reply actually went to is the difference between
 * "they never answered" and "we answered the wrong address".
 */
function Message({ thread, message }: { thread: Thread; message: SupportMessage }) {
  const note = message.direction === "internal_note";
  const sender = message.sender ?? (message.direction === "inbound" ? thread.requesterEmail : "");
  const recipient =
    message.recipient ?? (message.direction === "outbound" ? thread.requesterEmail : "");

  return (
    <li
      className={`rounded-lg border p-4 ${
        note
          ? "border-warn/30 bg-warn-soft/40"
          : message.direction === "outbound"
            ? "border-line bg-accent-soft/40"
            : "border-line bg-surface"
      }`}
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line-soft pb-2">
        <span className="text-sm font-medium text-ink">{DIRECTION_LABEL[message.direction]}</span>
        <span className="text-xs text-ink-faint">
          <Timestamp value={message.createdAt} />
        </span>
        {/* An internal note has no addresses: it was never sent anywhere. */}
        {note ? null : (
          <span className="w-full text-xs text-ink-faint">
            {sender}
            {recipient ? ` → ${recipient}` : ""}
          </span>
        )}
      </div>

      {/* Plain text, always. Inbound HTML was flattened in the mail Worker
          before it was ever stored, and nothing in this application renders
          user-written markup. */}
      <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{message.bodyText}</p>

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
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="mt-0.5 break-all text-ink">{children}</dd>
    </div>
  );
}
