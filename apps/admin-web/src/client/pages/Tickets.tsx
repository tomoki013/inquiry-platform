import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Ticket,
  type TicketDashboard,
  type TicketDetail,
  type TicketMasters,
  type TicketPage,
  type TicketType,
  ticketPriorities,
  ticketStatuses,
  ticketStatusLabels,
  ticketTypeLabels,
  ticketTypes,
} from "@tomokichi/admin-contracts";
import { useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { Dialog } from "../components/Dialog";
import { Button, DataState, Field, inputClass, Timestamp } from "../components/primitives";
import { api } from "../lib/api";

export const useTicketMasters = () =>
  useQuery({
    queryKey: ["tickets", "masters"],
    queryFn: () => api.get<TicketMasters>("/api/tickets/masters"),
  });
export function TicketBadge({ value }: { value: string }) {
  const danger = ["P1", "BREACHED"].includes(value),
    warn = ["P2", "AT_RISK", "NEW"].includes(value);
  return (
    <span className={`ops-badge ${danger ? "ops-danger" : warn ? "ops-warn" : ""}`}>
      {(
        {
          NEW: "未確認",
          ACKNOWLEDGED: "確認済み",
          WAITING_INTERNAL: "内部確認待ち",
          WAITING_CUSTOMER: "返信待ち",
          CLOSED: "クローズ",
          AT_RISK: "SLA注意",
          BREACHED: "SLA超過",
          OK: "期限内",
        } as Record<string, string>
      )[value] ??
        ticketStatusLabels[value as keyof typeof ticketStatusLabels] ??
        value}
    </span>
  );
}
function age(at: string) {
  const h = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 3600000));
  return h < 24 ? `${h}時間` : `${Math.floor(h / 24)}日`;
}
export function TicketTable({ items, masters }: { items: Ticket[]; masters?: TicketMasters }) {
  return (
    <>
      <div className="ops-cards">
        {items.map((t) => (
          <Link key={t.id} to={`/tickets/${t.id}`} className="ops-card">
            <div className="ops-card-top">
              <span className="ops-ticket-number">{t.ticket_number}</span>
              <TicketBadge value={t.priority} />
              <TicketBadge value={t.status} />
            </div>
            <h3>{t.subject}</h3>
            <div className="ops-card-meta">
              <span>
                {t.service_name} · {ticketTypeLabels[t.type]}
              </span>
              <span>{age(t.created_at)}</span>
            </div>
            {t.next_action && (
              <p className="ops-card-next">
                {t.next_action}
                {t.next_action_at && (
                  <>
                    {" "}
                    · <Timestamp value={t.next_action_at} />
                  </>
                )}
              </p>
            )}
            {t.sla_state !== "OK" && (
              <div className="ops-card-alert">
                <TicketBadge value={t.sla_state} />
              </div>
            )}
          </Link>
        ))}
      </div>
      <div className="ops-table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              {[
                "Ticket",
                "優先度",
                "サービス / 種別",
                "件名・次の対応",
                "状態",
                "担当",
                "SLA",
                "経過",
                "更新",
              ].map((x) => (
                <th key={x}>{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link className="text-accent font-mono" to={`/tickets/${t.id}`}>
                    {t.ticket_number}
                  </Link>
                </td>
                <td>
                  <TicketBadge value={t.priority} />
                </td>
                <td>
                  {t.service_name}
                  <small>{ticketTypeLabels[t.type]}</small>
                </td>
                <td>
                  <Link to={`/tickets/${t.id}`}>{t.subject}</Link>
                  {t.next_action && (
                    <small
                      className={
                        t.next_action_at && Date.parse(t.next_action_at) < Date.now()
                          ? "text-danger"
                          : ""
                      }
                    >
                      次: {t.next_action}
                      {t.next_action_at && (
                        <>
                          {" "}
                          · <Timestamp value={t.next_action_at} />
                        </>
                      )}
                    </small>
                  )}
                </td>
                <td>
                  <TicketBadge value={t.status} />
                </td>
                <td>
                  {masters?.assignees.find((a) => a.id === t.assignee_id)?.name ??
                    t.assignee_id ??
                    "未割当"}
                </td>
                <td>
                  <TicketBadge value={t.sla_state} />
                </td>
                <td>{age(t.created_at)}</td>
                <td>
                  <Timestamp value={t.updated_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
export function Tickets({ type }: { type?: TicketType }) {
  const [search, setSearch] = useSearchParams();
  const masters = useTicketMasters();
  const [creating, setCreating] = useState(false);
  const params = new URLSearchParams(search);
  if (!params.has("queue") && !params.has("status") && params.get("view") !== "all")
    params.set("queue", "OPEN");
  params.delete("view");
  if (type) params.set("type", type);
  if (!params.has("limit")) params.set("limit", "50");
  const list = useQuery({
    queryKey: ["tickets", "list", params.toString()],
    queryFn: () => api.get<TicketPage>(`/api/tickets?${params}`),
    refetchInterval: 60000,
  });
  const set = (key: string, value: string) => {
    const p = new URLSearchParams(search);
    value ? p.set(key, value) : p.delete(key);
    p.delete("offset");
    if (key === "status") {
      p.delete("queue");
      p.delete("view");
    }
    if (key === "service_id") p.delete("component_id");
    if (key === "type") p.delete("category_id");
    setSearch(p);
  };
  const quickViews = [
    { label: "未完了", queue: "OPEN", status: "" },
    { label: "未確認", queue: "UNACKNOWLEDGED", status: "" },
    { label: "対応中", queue: "", status: "IN_PROGRESS" },
    { label: "返信待ち", queue: "", status: "WAITING_CUSTOMER" },
    { label: "クローズ済み", queue: "", status: "CLOSED" },
    { label: "すべて", queue: "", status: "" },
  ];
  const quickView = (queue: string, status: string) => {
    const p = new URLSearchParams(search);
    for (const key of ["queue", "status", "view", "offset"]) p.delete(key);
    if (queue) p.set("queue", queue);
    else if (status) p.set("status", status);
    else p.set("view", "all");
    setSearch(p);
  };
  const filterCount = [
    "priority",
    "service_id",
    "component_id",
    "type",
    "category_id",
    "assignee_id",
    "sla",
    "next",
    "created_from",
    "created_to",
  ].filter((k) => search.has(k)).length;
  const offset = Number(search.get("offset") ?? 0);
  const filters: Array<[string, string, Array<{ id: string; name: string }>]> = [
    ["status", "状態", ticketStatuses.map((id) => ({ id, name: ticketStatusLabels[id] }))],
    ["priority", "優先度", ticketPriorities.map((id) => ({ id, name: id }))],
    ["service_id", "サービス", masters.data?.services ?? []],
    [
      "component_id",
      "機能",
      (masters.data?.components ?? []).filter(
        (c) => !search.get("service_id") || c.service_id === search.get("service_id"),
      ),
    ],
    ["type", "種別", ticketTypes.map((id) => ({ id, name: ticketTypeLabels[id] }))],
    [
      "category_id",
      "分類",
      (masters.data?.categories ?? [])
        .filter((c) => !(type ?? search.get("type")) || c.type === (type ?? search.get("type")))
        .map((c) => ({
          ...c,
          name:
            !(type ?? search.get("type")) && c.type
              ? `${ticketTypeLabels[c.type]} / ${c.name}`
              : c.name,
        })),
    ],
    [
      "assignee_id",
      "担当",
      [{ id: "unassigned", name: "未割当" }, ...(masters.data?.assignees ?? [])],
    ],
    ["sla", "SLA", ["OK", "AT_RISK", "BREACHED"].map((id) => ({ id, name: id }))],
    [
      "next",
      "次の対応",
      [
        { id: "OVERDUE", name: "期限超過" },
        { id: "TODAY", name: "今日 (UTC)" },
        { id: "UPCOMING", name: "これから" },
      ],
    ],
  ];
  return (
    <section className="ops-page">
      <header className="ops-header">
        <div>
          <h1>
            {type ? ticketTypeLabels[type] : "チケット"}
            <span className="ops-count">{list.data?.total ?? "—"}</span>
          </h1>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          新規作成
        </Button>
      </header>
      <nav className="ops-quick-views" aria-label="チケットの状態">
        {quickViews.map((v) => {
          const active = v.queue
            ? params.get("queue") === v.queue
            : v.status
              ? params.get("status") === v.status && !params.has("queue")
              : search.get("view") === "all" && !params.has("status") && !params.has("queue");
          return (
            <button
              type="button"
              key={v.label}
              aria-pressed={active}
              onClick={() => quickView(v.queue, v.status)}
            >
              {v.label}
            </button>
          );
        })}
      </nav>
      <div className="ops-search">
        <input
          aria-label="チケットを検索"
          className={inputClass}
          value={search.get("query") ?? ""}
          onChange={(e) => set("query", e.target.value)}
          placeholder="件名・メール・チケット番号で検索"
        />
      </div>
      <details className="ops-filter-panel">
        <summary>
          絞り込み{filterCount > 0 && <span className="ops-filter-count">{filterCount}</span>}
        </summary>
        <div className="ops-filters">
          {filters
            .filter(([key]) => !(key === "type" && type))
            .map(([key, label, options]) => (
              <Field key={key} label={label}>
                <select
                  className={inputClass}
                  value={search.get(key) ?? ""}
                  onChange={(e) => set(key, e.target.value)}
                >
                  <option value="">すべて</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          <Field label="作成日から (UTC)">
            <input
              type="date"
              className={inputClass}
              value={search.get("created_from")?.slice(0, 10) ?? ""}
              onChange={(e) =>
                set("created_from", e.target.value ? `${e.target.value}T00:00:00Z` : "")
              }
            />
          </Field>
          <Field label="作成日まで (UTC)">
            <input
              type="date"
              className={inputClass}
              value={search.get("created_to")?.slice(0, 10) ?? ""}
              onChange={(e) =>
                set("created_to", e.target.value ? `${e.target.value}T23:59:59Z` : "")
              }
            />
          </Field>
        </div>
        <button
          className="ops-clear-filters"
          type="button"
          onClick={() => {
            const p = new URLSearchParams(search);
            for (const key of [
              "priority",
              "service_id",
              "component_id",
              "type",
              "category_id",
              "assignee_id",
              "sla",
              "next",
              "created_from",
              "created_to",
              "offset",
            ])
              p.delete(key);
            setSearch(p);
          }}
        >
          絞り込みを解除
        </button>
      </details>
      <DataState
        loading={list.isLoading}
        error={list.error ?? masters.error}
        empty={!list.data?.items.length}
        emptyMessage="該当するチケットはありません。"
      >
        {list.data && <TicketTable items={list.data.items} masters={masters.data} />}
      </DataState>
      <div className="ops-pagination">
        <Button
          disabled={offset === 0}
          onClick={() => {
            const p = new URLSearchParams(search);
            p.set("offset", String(Math.max(0, offset - 50)));
            setSearch(p);
          }}
        >
          前へ
        </Button>
        <span>
          {list.data?.total ? offset + 1 : 0}–{Math.min(offset + 50, list.data?.total ?? 0)} /{" "}
          {list.data?.total ?? 0}
        </span>
        <Button
          disabled={offset + 50 >= (list.data?.total ?? 0)}
          onClick={() => {
            const p = new URLSearchParams(search);
            p.set("offset", String(offset + 50));
            setSearch(p);
          }}
        >
          次へ
        </Button>
      </div>
      {creating && masters.data && (
        <CreateTicket
          masters={masters.data}
          onClose={() => setCreating(false)}
          initialType={type}
        />
      )}
    </section>
  );
}
function CreateTicket({
  masters,
  onClose,
  initialType,
}: {
  masters: TicketMasters;
  onClose: () => void;
  initialType?: TicketType;
}) {
  const [type, setType] = useState<TicketType>(initialType ?? "INQUIRY"),
    [service, setService] = useState(
      masters.services.find((s) => s.id === "studio")?.id ?? masters.services[0]?.id ?? "",
    ),
    [subject, setSubject] = useState(""),
    [summary, setSummary] = useState(""),
    [email, setEmail] = useState("");
  const navigate = useNavigate(),
    client = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      api.post<TicketDetail>("/api/tickets", {
        type,
        service_id: service,
        subject,
        summary,
        requester_email: email || undefined,
      }),
    onSuccess: (d) => {
      void client.invalidateQueries({ queryKey: ["tickets"] });
      navigate(`/tickets/${d.ticket.id}`);
    },
  });
  return (
    <Dialog
      open
      title="新規作成"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          disabled={!subject.trim() || !service || create.isPending}
          onClick={() => create.mutate()}
        >
          作成
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="種別">
          <select
            className={inputClass}
            value={type}
            onChange={(e) => setType(e.target.value as TicketType)}
          >
            {ticketTypes.map((t) => (
              <option key={t} value={t}>
                {ticketTypeLabels[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="サービス">
          <select
            className={inputClass}
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            {masters.services
              .filter((s) => s.is_active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="件名">
          <input
            className={inputClass}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>
        <Field label="概要（内部向け）">
          <textarea
            className={inputClass}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>
        <Field label="返信先メール（任意）">
          <input
            type="email"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        {create.error && (
          <p role="alert" className="text-danger">
            {create.error.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
export function TicketOperationsDashboard() {
  const data = useQuery({
    queryKey: ["tickets", "dashboard"],
    queryFn: () => api.get<TicketDashboard>("/api/tickets/dashboard"),
    refetchInterval: 60000,
  });
  const masters = useTicketMasters();
  const d = data.data;
  return (
    <section className="ops-page">
      <header className="ops-header">
        <div>
          <h1>ダッシュボード</h1>
        </div>
        <Link className="text-accent" to="/tickets">
          チケット一覧 →
        </Link>
      </header>
      <DataState loading={data.isLoading} error={data.error} empty={false} emptyMessage="">
        {d && (
          <>
            <div className="ops-metrics">
              {[
                ["未完了", d.open, "queue=OPEN"],
                ["未確認", d.unacknowledged, "queue=UNACKNOWLEDGED"],
                ["優先対応", d.urgent, "queue=URGENT"],
                ["SLA注意", d.slaRisk, "queue=SLA_RISK"],
                ["期限超過", d.overdue, "next=OVERDUE"],
                ["返信待ち", d.waitingCustomer, "status=WAITING_CUSTOMER"],
              ].map(([label, n, query]) => (
                <Link key={label} to={`/tickets?${query}`}>
                  <span>{label}</span>
                  <strong>{n}</strong>
                </Link>
              ))}
            </div>
            <h2 className="ops-section-title">優先対応</h2>
            {d.priorityQueue.length ? (
              <TicketTable items={d.priorityQueue} masters={masters.data} />
            ) : (
              <p>対応待ちのチケットはありません。</p>
            )}
            <h2 className="ops-section-title">要確認</h2>
            {d.needsAttention.length ? (
              <TicketTable items={d.needsAttention} masters={masters.data} />
            ) : (
              <p>確認が必要なチケットはありません。</p>
            )}
          </>
        )}
      </DataState>
    </section>
  );
}
export function LegacyTicketRedirect({ kind }: { kind: "report" | "support" }) {
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["tickets", "source", kind, id],
    queryFn: () => api.get<{ id: string }>(`/api/tickets/source/${kind}/${id}`),
  });
  return q.data ? (
    <Navigate replace to={`/tickets/${q.data.id}`} />
  ) : (
    <DataState loading={q.isLoading} error={q.error} empty={false} emptyMessage="">
      {null}
    </DataState>
  );
}
