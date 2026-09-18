import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type TicketMaster,
  type TicketMasters,
  ticketTypeLabels,
  ticketTypes,
} from "@tomokichi/admin-contracts";
import { useState } from "react";
import { Button, DataState, Field, inputClass } from "../components/primitives";
import { api } from "../lib/api";
import { useTicketMasters } from "./Tickets";

export function TicketSettings() {
  const q = useTicketMasters(),
    client = useQueryClient();
  const [kind, setKind] = useState("service"),
    [selected, setSelected] = useState<TicketMaster | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => api.post<TicketMasters>("/api/tickets/masters", body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tickets", "masters"] });
      setSelected(null);
    },
  });
  const m = q.data,
    rows = m
      ? ({
          service: m.services,
          component: m.components,
          category: m.categories,
          group: m.groups,
          assignee: m.assignees,
        }[kind] ?? [])
      : [];
  return (
    <section className="ops-page">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">OPERATIONS / SETTINGS</p>
          <h1>運用設定</h1>
        </div>
      </header>
      <DataState loading={q.isLoading} error={q.error} empty={false} emptyMessage="">
        {m && (
          <>
            <section className="ops-panel">
              <h2 className="font-medium mb-3">SLA目標（分）</h2>
              <p className="text-sm text-ink-soft mb-4">
                新規Ticketと優先度変更時に適用します。既存Ticketの目標は遡って変更しません。空の解決期限はBest
                effortです。
              </p>
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                {m.sla.map((s) => (
                  <form
                    className="space-y-3"
                    key={`${s.priority}:${s.ack}:${s.response}:${s.resolution}`}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      save.mutate({
                        kind: "sla",
                        id: s.priority,
                        ack: Number(f.get("ack")),
                        response: Number(f.get("response")),
                        resolution: f.get("resolution") ? Number(f.get("resolution")) : null,
                      });
                    }}
                  >
                    <h3 className="font-semibold">{s.priority}</h3>
                    {[
                      ["ack", "ACK", s.ack],
                      ["response", "初回返信", s.response],
                      ["resolution", "解決", s.resolution],
                    ].map(([name, label, value]) => (
                      <Field key={name} label={String(label)}>
                        <input
                          name={String(name)}
                          type="number"
                          min={1}
                          required={name !== "resolution"}
                          className={inputClass}
                          defaultValue={value ?? ""}
                        />
                      </Field>
                    ))}
                    <Button type="submit" disabled={save.isPending}>
                      保存
                    </Button>
                  </form>
                ))}
              </div>
            </section>
            <h2 className="ops-section-title">マスタ管理</h2>
            <select
              aria-label="マスタ種別"
              className={`${inputClass} mb-4`}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setSelected(null);
              }}
            >
              {[
                ["service", "Service"],
                ["component", "Component"],
                ["category", "Category"],
                ["group", "担当グループ"],
                ["assignee", "担当者"],
              ].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="ops-panel">
                <Button onClick={() => setSelected(null)}>新規登録</Button>
                <ul className="divide-y divide-line mt-3">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <button
                        className="py-3 text-left w-full text-sm"
                        type="button"
                        onClick={() => setSelected(r)}
                      >
                        {r.name}{" "}
                        <span className="text-ink-faint">
                          {r.slug ?? r.id} · {r.is_active ? "有効" : "無効"}
                          {r.type ? ` · ${r.type}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <form
                key={`${kind}:${selected?.id ?? "new"}`}
                className="ops-panel space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  save.mutate({
                    kind,
                    id:
                      selected?.id ??
                      (kind === "assignee" && f.get("self") === "on"
                        ? "self"
                        : crypto.randomUUID()),
                    name: String(f.get("name")),
                    slug: f.has("slug") ? String(f.get("slug")) : undefined,
                    service_id: f.has("service_id") ? String(f.get("service_id")) : undefined,
                    type: f.has("type") ? String(f.get("type")) : undefined,
                    is_active: f.get("is_active") === "on",
                  });
                }}
              >
                <h3 className="font-medium">{selected ? "マスタを編集" : "マスタを追加"}</h3>
                <Field label="表示名">
                  <input
                    required
                    name="name"
                    className={inputClass}
                    defaultValue={selected?.name ?? ""}
                  />
                </Field>
                {["service", "component", "category"].includes(kind) && (
                  <Field label="slug（半角英数字・ハイフン）">
                    <input
                      required
                      pattern="[a-z0-9-]+"
                      name="slug"
                      className={inputClass}
                      defaultValue={selected?.slug ?? ""}
                    />
                  </Field>
                )}
                {kind === "component" && (
                  <Field label="Service">
                    <select
                      name="service_id"
                      className={inputClass}
                      defaultValue={selected?.service_id}
                    >
                      {m.services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {kind === "category" && (
                  <Field label="Type">
                    <select name="type" className={inputClass} defaultValue={selected?.type}>
                      {ticketTypes.map((t) => (
                        <option key={t} value={t}>
                          {ticketTypeLabels[t]}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {kind === "assignee" && !selected && (
                  <label className="block text-sm">
                    <input type="checkbox" name="self" defaultChecked /> ログイン中の自分を登録
                  </label>
                )}
                <label className="block text-sm">
                  <input
                    type="checkbox"
                    name="is_active"
                    defaultChecked={selected ? Boolean(selected.is_active) : true}
                  />{" "}
                  有効
                </label>
                <Button type="submit" variant="primary" disabled={save.isPending}>
                  保存
                </Button>
              </form>
            </div>
            {save.error && (
              <p className="text-danger mt-4" role="alert">
                {save.error.message}
              </p>
            )}
            {save.isSuccess && (
              <p role="status" className="text-good mt-4">
                設定を保存しました。
              </p>
            )}
          </>
        )}
      </DataState>
    </section>
  );
}
