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
      {ticketStatusLabels[value as keyof typeof ticketStatusLabels] ?? value}
    </span>
  );
}
function age(at: string) {
  const h = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 3600000));
  return h < 24 ? `${h}時間` : `${Math.floor(h / 24)}日`;
}
export function TicketTable({ items, masters }: { items: Ticket[]; masters?: TicketMasters }) {
  return (
    <div className="ops-table-wrap">
      <table className="ops-table">
        <thead>
          <tr>
            {[
              "Ticket",
              "優先度",
              "Service / Type",
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
  );
}
export function Tickets({ type }: { type?: TicketType }) {
  const [search, setSearch] = useSearchParams();
  const masters = useTicketMasters();
  const [creating, setCreating] = useState(false);
  const params = new URLSearchParams(search);
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
    setSearch(p);
  };
  const offset = Number(search.get("offset") ?? 0);
  const filters: Array<[string, string, Array<{ id: string; name: string }>]> = [
    ["status", "状態", ticketStatuses.map((id) => ({ id, name: ticketStatusLabels[id] }))],
    ["priority", "優先度", ticketPriorities.map((id) => ({ id, name: id }))],
    ["service_id", "Service", masters.data?.services ?? []],
    [
      "component_id",
      "Component",
      (masters.data?.components ?? []).filter(
        (c) => !search.get("service_id") || c.service_id === search.get("service_id"),
      ),
    ],
    ["type", "Type", ticketTypes.map((id) => ({ id, name: ticketTypeLabels[id] }))],
    [
      "category_id",
      "Category",
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
          <p className="ops-eyebrow">OPERATIONS / QUEUE</p>
          <h1>{type ? ticketTypeLabels[type] : "Tickets"}</h1>
          <p className="text-ink-soft">{list.data?.total ?? "—"}件 · 優先度 → SLA → 経過時間</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          Ticketを作成
        </Button>
      </header>
      <div className="ops-filters">
        <Field label="検索: TK番号・件名・メール・ユーザーID・本文">
          <input
            className={inputClass}
            value={search.get("query") ?? ""}
            onChange={(e) => set("query", e.target.value)}
            placeholder="検索語を入力"
          />
        </Field>
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
            onChange={(e) => set("created_to", e.target.value ? `${e.target.value}T23:59:59Z` : "")}
          />
        </Field>
      </div>
      <DataState
        loading={list.isLoading}
        error={list.error ?? masters.error}
        empty={!list.data?.items.length}
        emptyMessage="条件に合うTicketはありません。"
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
          {offset + 1}–{Math.min(offset + 50, list.data?.total ?? 0)} / {list.data?.total ?? 0}
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
      title="Ticketを作成"
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
        <Field label="Type">
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
        <Field label="Service">
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
          <p className="ops-eyebrow">TOMOKICHI STUDIO</p>
          <h1>Operations</h1>
          <p className="text-ink-soft">確認する、対応する、次につなぐ。</p>
        </div>
        <Link className="text-accent" to="/tickets">
          すべてのTicket →
        </Link>
      </header>
      <DataState loading={data.isLoading} error={data.error} empty={false} emptyMessage="">
        {d && (
          <>
            <div className="ops-metrics">
              {[
                ["Open Tickets", d.open, "queue=OPEN"],
                ["未ACK", d.unacknowledged, "queue=UNACKNOWLEDGED"],
                ["P1 / P2", d.urgent, "queue=URGENT"],
                ["SLA Risk", d.slaRisk, "queue=SLA_RISK"],
                ["次の対応・期限超過", d.overdue, "next=OVERDUE"],
                ["ユーザー待ち", d.waitingCustomer, "status=WAITING_CUSTOMER"],
              ].map(([label, n, query]) => (
                <Link key={label} to={`/tickets?${query}`}>
                  <span>{label}</span>
                  <strong>{n}</strong>
                </Link>
              ))}
            </div>
            <h2 className="ops-section-title">Priority Queue</h2>
            {d.priorityQueue.length ? (
              <TicketTable items={d.priorityQueue} masters={masters.data} />
            ) : (
              <p>対応待ちのTicketはありません。</p>
            )}
            <h2 className="ops-section-title">Needs Attention</h2>
            <p className="mb-3 text-sm text-ink-soft">
              SLAリスク・次の対応の期限超過・未割当・3日以上の待機
            </p>
            {d.needsAttention.length ? (
              <TicketTable items={d.needsAttention} masters={masters.data} />
            ) : (
              <p>注意が必要なTicketはありません。</p>
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
