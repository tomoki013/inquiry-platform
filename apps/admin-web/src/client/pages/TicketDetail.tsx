import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type TicketDetail as Detail,
  type ReportDetail,
  type SupportThreadDetail,
  slaClock,
  type Ticket,
  type TicketEvent,
  type TicketMasters,
  ticketLevels,
  ticketPriorities,
  ticketRelationTypes,
  ticketResolutions,
  ticketStatusLabels,
  ticketTransitions,
  ticketTypeLabels,
  ticketTypes,
} from "@tomokichi/admin-contracts";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Dialog } from "../components/Dialog";
import { Button, DataState, Field, inputClass, Timestamp } from "../components/primitives";
import { ReplyComposer } from "../components/ReplyComposer";
import { api } from "../lib/api";
import { ContentActions } from "./ReportDetail";
import { TicketBadge, useTicketMasters } from "./Tickets";

const eventLabels: Record<string, string> = {
  TICKET_CREATED: "受付",
  STATUS_CHANGED: "状態を変更",
  TYPE_CHANGED: "種別を変更",
  PRIORITY_CHANGED: "優先度を変更",
  ACKNOWLEDGED: "ACK・確認済み",
  ASSIGNMENT_CHANGED: "担当を変更",
  MESSAGE_RECEIVED: "受信",
  MESSAGE_SENT: "返信を送信",
  INTERNAL_NOTE_ADDED: "内部メモ",
  SERVICE_CHANGED: "対象サービスを変更",
  CATEGORY_CHANGED: "分類を変更",
  RESOLVED: "解決",
  CLOSED: "クローズ",
  REOPENED: "再開",
  RELATION_ADDED: "関連を追加",
  MERGED: "統合",
  NEXT_ACTION_CHANGED: "次の対応を変更",
  REPORT_ACTION: "通報への対応",
  LEGACY_EVENT: "移行前の履歴",
  DETAILS_CHANGED: "情報を更新",
};
function EventBody({ event }: { event: TicketEvent }) {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(event.metadata);
  } catch {}
  const status = (v: unknown) =>
    typeof v === "string"
      ? (ticketStatusLabels[v as keyof typeof ticketStatusLabels] ?? v)
      : String(v ?? "—");
  return (
    <div className="text-xs text-ink-soft space-y-1">
      {Boolean(data.previousStatus || data.newStatus) && (
        <p>
          {status(data.previousStatus)} → {status(data.newStatus)}
        </p>
      )}
      {Boolean(data.field) && (
        <p>
          {String(data.field)}: {status(data.from)} → {status(data.to)}
        </p>
      )}
      {Boolean(data.resolution) && (
        <p>
          処理結果:{" "}
          {typeof data.resolution === "object"
            ? `${status((data.resolution as Record<string, unknown>).from)} → ${status((data.resolution as Record<string, unknown>).to)}`
            : String(data.resolution)}
        </p>
      )}
      {Boolean(data.reason) && <p>理由: {String(data.reason)}</p>}
      {Boolean(data.note) && <p className="whitespace-pre-wrap">{String(data.note)}</p>}
      {Boolean(data.legacyType) && (
        <p>
          {String(data.legacyType)} {status(data.from)} → {status(data.to)}
        </p>
      )}
      {Boolean(data.action) && <p>{String(data.action)}</p>}
      {data.data !== undefined && (
        <details>
          <summary>変更内容</summary>
          <pre className="whitespace-pre-wrap break-words">
            {JSON.stringify(data.data, null, 2)}
          </pre>
        </details>
      )}
      {Boolean(data.source) && (
        <Link className="text-accent" to={`/tickets/${data.source}`}>
          統合元の履歴を開く →
        </Link>
      )}
      {Boolean(data.target) && (
        <Link className="text-accent" to={`/tickets/${data.target}`}>
          関連Ticketを開く →
        </Link>
      )}
      {event.event_type === "PRIORITY_CHANGED" && (
        <p>
          {status(data.from)} → {status(data.to)} / Impact {String(data.impact)} / Urgency{" "}
          {String(data.urgency)}
        </p>
      )}
    </div>
  );
}
export function TicketDetail() {
  const { id = "" } = useParams(),
    client = useQueryClient(),
    masters = useTicketMasters();
  const [offset, setOffset] = useState(0);
  const [operationsOpen, setOperationsOpen] = useState(
    () => window.matchMedia("(min-width: 900px)").matches,
  );
  const detail = useQuery({
    queryKey: ["tickets", "detail", id, offset],
    refetchOnWindowFocus: false,
    queryFn: () => api.get<Detail>(`/api/tickets/${id}?offset=${offset}`),
  });
  const t = detail.data?.ticket;
  const context = useQuery({
    queryKey: ["tickets", "reply-context", id],
    queryFn: () => api.get<SupportThreadDetail>(`/api/tickets/${id}/reply-context`),
    enabled: Boolean(t?.thread_id),
  });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<{ mailConfigured: boolean }>("/api/session"),
  });
  const report = useQuery({
    queryKey: ["tickets", "report", t?.report_id],
    queryFn: () => api.get<ReportDetail>(`/api/reports/${t?.report_id}`),
    enabled: Boolean(t?.report_id),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["tickets"] });
  };
  const ack = useMutation({
    mutationFn: () => api.post(`/api/tickets/${id}/ack`, {}),
    onSuccess: refresh,
  });
  return (
    <section className="ops-page">
      <DataState loading={detail.isLoading} error={detail.error} empty={false} emptyMessage="">
        {t && detail.data && (
          <>
            <header className="ops-header">
              <div>
                <Link className="text-accent text-xs" to="/tickets">
                  ← Tickets
                </Link>
                <p className="ops-eyebrow mt-4">
                  {t.ticket_number} · {t.service_name} / {ticketTypeLabels[t.type]}
                </p>
                <h1>{t.subject}</h1>
                <div className="flex gap-2 mt-3">
                  <TicketBadge value={t.priority} />
                  <TicketBadge value={t.status} />
                  <TicketBadge value={t.sla_state} />
                </div>
              </div>
              {["NEW", "TRIAGE"].includes(t.status) && !t.merged_into && (
                <Button variant="primary" disabled={ack.isPending} onClick={() => ack.mutate()}>
                  ACK・確認済みにする
                </Button>
              )}
            </header>
            {ack.error && (
              <p role="alert" className="text-danger">
                {ack.error.message}
              </p>
            )}
            {t.merged_into && (
              <p className="ops-panel mb-5">
                このTicketは統合済みです。履歴は保持しています。{" "}
                <Link className="text-accent" to={`/tickets/${t.merged_into}`}>
                  統合先を開く →
                </Link>
              </p>
            )}
            <div className="ops-detail">
              <div>
                {t.summary && (
                  <div className="ops-panel mb-5">
                    <h2 className="font-medium mb-2">概要</h2>
                    <p className="whitespace-pre-wrap text-sm">{t.summary}</p>
                  </div>
                )}
                {report.error && (
                  <p role="alert" className="text-danger">
                    {report.error.message}
                  </p>
                )}
                {report.data && (
                  <div className="ops-panel mb-5">
                    <h2 className="font-medium mb-3">通報対象</h2>
                    <p className="text-xs text-ink-soft">
                      {report.data.contentType} · {report.data.reasonCode} · 受付ID{" "}
                      {report.data.externalReportId}
                    </p>
                    <p className="whitespace-pre-wrap text-sm mt-3">
                      {report.data.snapshotText ?? "本文なし"}
                    </p>
                    {report.data.detail && (
                      <p className="whitespace-pre-wrap text-sm mt-3">
                        通報者の補足: {report.data.detail}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-3 my-4">
                      {report.data.attachments.map((a) => (
                        <a
                          key={a.id}
                          href={`/api/reports/${report.data?.id}/attachments/${a.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            className="max-w-40 rounded border border-line"
                            src={`/api/reports/${report.data?.id}/attachments/${a.id}`}
                            alt="通報の証跡"
                            loading="lazy"
                          />
                        </a>
                      ))}
                    </div>
                    {!t.merged_into && <ContentActions report={report.data} onChanged={refresh} />}
                  </div>
                )}
                <h2 className="ops-section-title">
                  Timeline{" "}
                  <span className="text-xs text-ink-faint">
                    新しい順 · {detail.data.totalTimeline}件
                  </span>
                </h2>
                <div className="ops-timeline">
                  {detail.data.timeline.map((item) => (
                    <article key={`${item.kind}:${item.value.id}`}>
                      <header>
                        <strong>
                          {item.kind === "message"
                            ? item.value.visibility === "INTERNAL"
                              ? "内部メモ・送信なし"
                              : item.value.direction === "INBOUND"
                                ? "ユーザーから受信"
                                : "運営から送信"
                            : (eventLabels[item.value.event_type] ?? item.value.event_type)}
                        </strong>
                        <Timestamp value={item.value.created_at} />
                        {item.kind === "event" && item.value.actor_id && (
                          <span>by {item.value.actor_id}</span>
                        )}
                      </header>
                      {item.kind === "message" ? (
                        <>
                          <p className="text-xs text-ink-faint mb-2">
                            {item.value.sender}
                            {item.value.recipient ? ` → ${item.value.recipient}` : ""}
                          </p>
                          <pre
                            className={item.value.visibility === "INTERNAL" ? "ops-internal" : ""}
                          >
                            {item.value.body}
                          </pre>
                          {item.value.legacy_message_id && (
                            <span>
                              {item.value.attachments?.map((a) => (
                                <a
                                  className="text-accent text-xs mr-3"
                                  key={a.id}
                                  href={`/api/support/messages/${item.value.legacy_message_id}/attachments/${a.id}`}
                                >
                                  {a.originalFilename ?? "添付ファイル"}
                                </a>
                              ))}
                            </span>
                          )}
                        </>
                      ) : (
                        <EventBody event={item.value} />
                      )}
                    </article>
                  ))}
                </div>
                <div className="ops-pagination">
                  <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
                    新しい履歴
                  </Button>
                  <Button
                    disabled={offset + 50 >= detail.data.totalTimeline}
                    onClick={() => setOffset(offset + 50)}
                  >
                    過去の履歴
                  </Button>
                </div>
                {!t.merged_into && t.status !== "CLOSED" && (
                  <div className="ops-panel mt-6">
                    {context.data ? (
                      <ReplyComposer
                        key={t.id}
                        thread={context.data}
                        ticketId={t.id}
                        mailConfigured={session.data?.mailConfigured ?? false}
                      />
                    ) : t.thread_id ? (
                      <DataState
                        loading={context.isLoading}
                        error={context.error}
                        empty={false}
                        emptyMessage=""
                      >
                        {null}
                      </DataState>
                    ) : (
                      <StandaloneNote id={t.id} onChanged={refresh} />
                    )}
                  </div>
                )}
              </div>
              <aside className="ops-sidebar">
                <details
                  className="ops-panel"
                  open={operationsOpen}
                  onToggle={(e) => setOperationsOpen(e.currentTarget.open)}
                >
                  <summary className="font-medium cursor-pointer mb-4">Ticketの運用情報</summary>
                  {masters.data && (
                    <TicketEditor
                      key={`${t.id}:${t.revision}`}
                      ticket={t}
                      masters={masters.data}
                      onChanged={refresh}
                    />
                  )}
                </details>
                <SlaPanel ticket={t} />
                <Relations data={detail.data} onChanged={refresh} />
              </aside>
            </div>
          </>
        )}
      </DataState>
    </section>
  );
}
function TicketEditor({
  ticket: t,
  masters: m,
  onChanged,
}: {
  ticket: Ticket;
  masters: TicketMasters;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState(t.status),
    [type, setType] = useState(t.type),
    [service, setService] = useState(t.service_id);
  const mutation = useMutation({
    mutationFn: (body: unknown) => api.patch(`/api/tickets/${t.id}`, body),
    onSuccess: onChanged,
  });
  const disabled = Boolean(t.merged_into) || mutation.isPending;
  const select = (
    name: string,
    label: string,
    options: Array<{ id: string; name: string }>,
    value: string | null,
    optional = true,
  ) => (
    <Field label={label}>
      <select name={name} defaultValue={value ?? ""} className={inputClass}>
        {optional && <option value="">未設定</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body: Record<string, unknown> = { id: t.id, revision: t.revision };
        const get = (k: string) => String(f.get(k) ?? "").trim();
        for (const k of [
          "status",
          "type",
          "service_id",
          "component_id",
          "category_id",
          "assignment_group_id",
          "assignee_id",
          "subject",
          "summary",
          "next_action",
        ] as const) {
          const v = get(k);
          if ((v || null) !== (t[k] || null)) body[k] = v || null;
        }
        const resolution = get("resolution");
        if (resolution && ["RESOLVED", "CLOSED"].includes(status)) body.resolution = resolution;
        const next = get("next_action_at");
        const nextIso = next ? new Date(next).toISOString() : null;
        if (nextIso !== t.next_action_at) body.next_action_at = nextIso;
        if (
          get("impact") !== t.impact ||
          get("urgency") !== t.urgency ||
          get("priority") !== (t.priority_override ? t.priority : "") ||
          get("override_reason") !== (t.priority_override ?? "")
        ) {
          body.impact = get("impact");
          body.urgency = get("urgency");
          if (get("priority")) body.priority = get("priority");
          body.override_reason = get("override_reason") || null;
        }
        mutation.mutate(body);
      }}
    >
      <fieldset disabled={disabled} className="space-y-3">
        {t.status === "CLOSED" && (
          <p className="text-xs text-ink-soft">
            編集するには状態を「対応中」に変更して再開してください。
          </p>
        )}
        <Field label="状態">
          <select
            name="status"
            className={inputClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value={t.status}>{ticketStatusLabels[t.status]}</option>
            {ticketTransitions[t.status].map((s) => (
              <option key={s} value={s}>
                {ticketStatusLabels[s]}
              </option>
            ))}
          </select>
        </Field>
        {["RESOLVED", "CLOSED"].includes(status) &&
          select(
            "resolution",
            "処理結果",
            ticketResolutions.map((id) => ({ id, name: id })),
            t.resolution,
          )}
        <Field label="件名">
          <input
            className={inputClass}
            name="subject"
            defaultValue={t.subject}
            required
            maxLength={500}
          />
        </Field>
        <Field label="Type">
          <select
            className={inputClass}
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
          >
            {ticketTypes.map((id) => (
              <option key={id} value={id}>
                {ticketTypeLabels[id]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Service">
          <select
            className={inputClass}
            name="service_id"
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            {m.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <div key={service}>
          {select(
            "component_id",
            "Component",
            m.components.filter((c) => c.service_id === service),
            service === t.service_id ? t.component_id : null,
          )}
        </div>
        <div key={type}>
          {select(
            "category_id",
            "Category",
            m.categories.filter((c) => c.type === type),
            type === t.type ? t.category_id : null,
          )}
        </div>
        {select(
          "impact",
          "Impact",
          ticketLevels.map((id) => ({ id, name: id })),
          t.impact,
          false,
        )}
        {select(
          "urgency",
          "Urgency",
          ticketLevels.map((id) => ({ id, name: id })),
          t.urgency,
          false,
        )}
        <Field label="Priority（自動算出 / 上書き）">
          <select
            className={inputClass}
            name="priority"
            defaultValue={t.priority_override ? t.priority : ""}
          >
            <option value="">Impact × Urgencyで算出</option>
            {ticketPriorities.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="上書き理由">
          <input
            className={inputClass}
            name="override_reason"
            defaultValue={t.priority_override ?? ""}
          />
        </Field>
        {select("assignment_group_id", "担当グループ", m.groups, t.assignment_group_id)}
        {select("assignee_id", "担当者", m.assignees, t.assignee_id)}
        <Field label="概要（内部向け）">
          <textarea className={inputClass} name="summary" defaultValue={t.summary ?? ""} />
        </Field>
        <Field label="次の対応">
          <textarea className={inputClass} name="next_action" defaultValue={t.next_action ?? ""} />
        </Field>
        <Field label="次の対応期限（端末のタイムゾーン）">
          <input
            type="datetime-local"
            className={inputClass}
            name="next_action_at"
            defaultValue={localDate(t.next_action_at)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={disabled}>
          運用情報を保存
        </Button>
        {mutation.error && (
          <p role="alert" className="text-danger text-sm">
            {mutation.error.message}
          </p>
        )}
      </fieldset>
    </form>
  );
}
function localDate(s: string | null) {
  if (!s) return "";
  const d = new Date(s);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function SlaPanel({ ticket: t }: { ticket: Ticket }) {
  return (
    <section className="ops-panel">
      <h2 className="font-medium mb-3">SLA・内部運用目標</h2>
      <p className="text-xs text-ink-faint mb-3">24時間の経過時間で計算。待機中も継続。</p>
      {[
        ["ACK", t.acknowledged_at, t.sla_ack_minutes],
        ["初回返信", t.first_response_at, t.sla_response_minutes],
        ["解決", t.resolved_at, t.sla_resolution_minutes],
      ].map(([label, completed, minutes]) => {
        const c = slaClock(
          t.created_at,
          (completed as string | null) ?? t.closed_at,
          minutes as number | null,
        );
        return (
          <div className="text-xs border-t border-line py-3" key={label}>
            <div className="flex justify-between">
              <strong>{label}</strong>
              <TicketBadge value={c.state} />
            </div>
            <p className="mt-1">
              {completed ? (
                <Timestamp value={String(completed)} />
              ) : minutes === null ? (
                "Best effort"
              ) : (
                "未完了"
              )}
            </p>
            {c.dueAt && (
              <p className="mt-1 text-ink-faint">
                目標: <Timestamp value={c.dueAt} />
              </p>
            )}
          </div>
        );
      })}
      <p className="text-xs mt-3">
        受付: <Timestamp value={t.created_at} />
      </p>
      {t.closed_at && (
        <p className="text-xs mt-2">
          Close: <Timestamp value={t.closed_at} />
        </p>
      )}
    </section>
  );
}
function Relations({ data, onChanged }: { data: Detail; onChanged: () => void }) {
  const [target, setTarget] = useState(""),
    [kind, setKind] = useState("RELATED"),
    [candidate, setCandidate] = useState<Detail | null>(null);
  const t = data.ticket;
  const relation = useMutation({
    mutationFn: () =>
      api.post(`/api/tickets/${t.id}/relations`, { target_id: target, relation_type: kind }),
    onSuccess: () => {
      setTarget("");
      onChanged();
    },
  });
  const load = useMutation({
    mutationFn: () => api.get<Detail>(`/api/tickets/${encodeURIComponent(target)}`),
    onSuccess: setCandidate,
  });
  const merge = useMutation({
    mutationFn: () =>
      api.post(`/api/tickets/${t.id}/merge`, {
        target_id: candidate?.ticket.id,
        revision: t.revision,
        target_revision: candidate?.ticket.revision,
      }),
    onSuccess: () => {
      setCandidate(null);
      onChanged();
    },
  });
  return (
    <section className="ops-panel">
      <h2 className="font-medium mb-3">関連Ticket</h2>
      <ul className="space-y-2 text-xs mb-4">
        {data.relations.map((r) => (
          <li key={r.id}>
            {r.relation_type} ·{" "}
            <Link
              className="text-accent"
              to={`/tickets/${r.source_ticket_id === t.id ? r.target_ticket_id : r.source_ticket_id}`}
            >
              {r.ticket_number}
            </Link>
          </li>
        ))}
      </ul>
      {!t.merged_into && t.status !== "CLOSED" && (
        <div className="space-y-3">
          <Field label="関連先のTK番号 / UUID">
            <input
              className={inputClass}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </Field>
          <select
            aria-label="関連種別"
            className={inputClass}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {ticketRelationTypes.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <Button disabled={!target || relation.isPending} onClick={() => relation.mutate()}>
              関連を追加
            </Button>
            <Button disabled={!target || load.isPending} onClick={() => load.mutate()}>
              統合を確認
            </Button>
          </div>
        </div>
      )}
      {(relation.error || load.error) && (
        <p role="alert" className="text-danger text-xs">
          {(relation.error ?? load.error)?.message}
        </p>
      )}
      <Dialog
        open={Boolean(candidate)}
        title="重複Ticketを統合"
        onClose={() => setCandidate(null)}
        footer={
          <Button disabled={merge.isPending} variant="primary" onClick={() => merge.mutate()}>
            統合する
          </Button>
        }
      >
        <p>
          {t.ticket_number} を {candidate?.ticket.ticket_number}「{candidate?.ticket.subject}
          」へ統合します。元のTicketはCLOSED / DUPLICATEとなり、履歴は残ります。
        </p>
        {merge.error && (
          <p role="alert" className="text-danger">
            {merge.error.message}
          </p>
        )}
      </Dialog>
    </section>
  );
}
function StandaloneNote({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [body, setBody] = useState(""),
    [key, setKey] = useState(crypto.randomUUID());
  const note = useMutation({
    mutationFn: () => api.post(`/api/tickets/${id}/notes`, { body, idempotencyKey: key }),
    onSuccess: () => {
      setBody("");
      setKey(crypto.randomUUID());
      onChanged();
    },
  });
  return (
    <div>
      <Field label="内部メモ（ユーザーへ送信されません）">
        <textarea className={inputClass} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <Button disabled={!body.trim() || note.isPending} onClick={() => note.mutate()}>
        メモを追加
      </Button>
      {note.error && <p role="alert">{note.error.message}</p>}
    </div>
  );
}
