import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReportDetail as Report, ReportStatus } from "@tomokichi/admin-contracts";
import { allowedReportTransitions } from "@tomokichi/admin-contracts";
import { useState } from "react";
import { useParams } from "react-router";
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
import { reportStatusLabels } from "../lib/labels";

/**
 * One report, and everything that has happened to it.
 *
 * The action buttons are built from `allowedReportTransitions`, the same table
 * Admin Core enforces — so the screen cannot offer a move the server will
 * refuse. The server still refuses it independently; this is about not showing
 * somebody a button that does nothing.
 */
export function ReportDetail() {
  const { id = "" } = useParams();
  const client = useQueryClient();
  const report = useQuery({
    queryKey: ["report", id],
    queryFn: () => api.get<Report>(`/api/reports/${id}`),
  });

  const [note, setNote] = useState("");
  const [resolutionCode, setResolutionCode] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");

  const onChanged = (updated: Report) => {
    client.setQueryData(["report", id], updated);
    void client.invalidateQueries({ queryKey: ["reports"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const changeStatus = useMutation({
    mutationFn: (to: ReportStatus) => api.post<Report>(`/api/reports/${id}/status`, { to }),
    onSuccess: onChanged,
  });
  const addNote = useMutation({
    mutationFn: () => api.post<Report>(`/api/reports/${id}/notes`, { note }),
    onSuccess: (updated) => {
      setNote("");
      onChanged(updated);
    },
  });
  const setResolution = useMutation({
    mutationFn: () =>
      api.post<Report>(`/api/reports/${id}/resolution`, { resolutionCode, resolutionNote }),
    onSuccess: onChanged,
  });

  const data = report.data;

  return (
    <Page title="通報" description={data ? `${data.appName} / ${data.reasonCode}` : undefined}>
      <DataState loading={report.isLoading} error={report.error} empty={false} emptyMessage="">
        {data ? (
          <div className="space-y-8">
            <Section title="概要">
              <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                <Row label="ステータス">
                  <StatusPill status={data.status} />
                </Row>
                <Row label="優先度">{data.priority}</Row>
                <Row label="アプリ">{data.appName}</Row>
                <Row label="通報 ID">
                  <span className="font-mono text-xs">{data.externalReportId}</span>
                </Row>
                <Row label="受信">
                  <Timestamp value={data.createdAt} />
                </Row>
                <Row label="更新">
                  <Timestamp value={data.updatedAt} />
                </Row>
              </dl>
            </Section>

            <Section title="通報されたコンテンツ">
              <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                <Row label="コンテンツ種別">{data.contentType}</Row>
                <Row label="コンテンツ ID">
                  <span className="font-mono text-xs">{data.contentExternalId ?? "—"}</span>
                </Row>
                <Row label="コンテキスト ID">
                  <span className="font-mono text-xs">{data.contextExternalId ?? "—"}</span>
                </Row>
                <Row label="通報者 / 投稿者">
                  {/* Pseudonymised references, not the apps' own user ids —
                      enough to notice "the same author again", useless to
                      anybody who gets this table without the pepper. */}
                  <span className="font-mono text-xs break-all">
                    {short(data.reporterRefHash)} / {short(data.authorRefHash)}
                  </span>
                </Row>
              </dl>
              {data.snapshotText ? (
                <div className="mt-4">
                  <p className="mb-1 text-xs font-medium text-ink-soft">通報対象の本文</p>
                  {/* Plain text in a <p>. Nothing user-written is ever rendered
                      as markup anywhere in this application. */}
                  <p className="rounded-md bg-line-soft/60 p-3 text-sm whitespace-pre-wrap text-ink">
                    {data.snapshotText}
                  </p>
                </div>
              ) : null}
              {data.detail ? (
                <div className="mt-4">
                  <p className="mb-1 text-xs font-medium text-ink-soft">通報者のコメント</p>
                  <p className="rounded-md bg-line-soft/60 p-3 text-sm whitespace-pre-wrap text-ink">
                    {data.detail}
                  </p>
                </div>
              ) : null}
            </Section>

            <Section title="証跡">
              {data.attachments.length === 0 ? (
                <p className="text-sm text-ink-faint">添付はありません。</p>
              ) : (
                <ul className="flex flex-wrap gap-4">
                  {data.attachments.map((attachment) => (
                    <li key={attachment.id} className="w-48">
                      {/* Served through this Worker from the private bucket.
                          There is no public URL for any of these bytes. */}
                      <img
                        src={`/api/reports/${data.id}/attachments/${attachment.id}`}
                        alt="通報された添付画像"
                        className="w-full rounded-md border border-line object-cover"
                      />
                      <p className="mt-1 text-xs text-ink-faint">
                        {Math.round(attachment.byteSize / 1024)} KB · {attachment.contentType}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="操作">
              <div className="flex flex-wrap gap-2">
                {allowedReportTransitions[data.status].map((to) => (
                  <Button
                    key={to}
                    variant={to === "closed" ? "default" : "primary"}
                    disabled={changeStatus.isPending}
                    onClick={() => changeStatus.mutate(to)}
                  >
                    {reportStatusLabels[to]}にする
                  </Button>
                ))}
              </div>
              {changeStatus.error ? (
                <p role="alert" className="mt-2 text-xs text-danger">
                  {(changeStatus.error as Error).message}
                </p>
              ) : null}
            </Section>

            <Section title="経過">
              <ol className="space-y-3">
                {data.events.map((event) => (
                  <li key={event.id} className="border-l-2 border-line pl-3 text-sm">
                    <p className="text-ink">
                      <span className="font-mono text-xs">{event.eventType}</span>
                      {event.fromStatus && event.toStatus ? (
                        <span className="ml-2 text-ink-soft">
                          {reportStatusLabels[event.fromStatus as ReportStatus] ?? event.fromStatus}{" "}
                          → {reportStatusLabels[event.toStatus as ReportStatus] ?? event.toStatus}
                        </span>
                      ) : null}
                    </p>
                    {event.note ? (
                      <p className="mt-1 whitespace-pre-wrap text-ink-soft">{event.note}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-ink-faint">
                      <Timestamp value={event.createdAt} />
                    </p>
                  </li>
                ))}
              </ol>

              <div className="mt-5">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-soft">メモを追加</span>
                  <textarea
                    className={`${inputClass} min-h-24`}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <div className="mt-2">
                  <Button
                    disabled={note.trim().length === 0 || addNote.isPending}
                    onClick={() => addNote.mutate()}
                  >
                    追加
                  </Button>
                </div>
              </div>
            </Section>

            <Section title="対応の記録">
              <p className="mb-3 text-xs text-ink-faint">
                「対応記録済み」は運営が行った対応を記録した、という意味です。
                アプリ内のコンテンツが必ず削除されたことを意味しません。
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-soft">対応コード</span>
                  <input
                    className={inputClass}
                    value={resolutionCode || (data.resolutionCode ?? "")}
                    onChange={(e) => setResolutionCode(e.target.value)}
                    placeholder="content_hidden など"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-soft">対応メモ</span>
                  <input
                    className={inputClass}
                    value={resolutionNote || (data.resolutionNote ?? "")}
                    onChange={(e) => setResolutionNote(e.target.value)}
                  />
                </label>
              </div>
              <div className="mt-3">
                <Button
                  disabled={resolutionCode.trim().length === 0 || setResolution.isPending}
                  onClick={() => setResolution.mutate()}
                >
                  記録する
                </Button>
              </div>
            </Section>
          </div>
        ) : null}
      </DataState>
    </Page>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-medium text-ink">{title}</h2>
      <Card className="p-5">{children}</Card>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}

function short(value: string | undefined): string {
  return value ? `${value.slice(0, 12)}…` : "—";
}
