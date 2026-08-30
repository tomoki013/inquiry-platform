import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppSummary, ReplyTemplate, ReplyTemplateCategory } from "@tomokichi/admin-contracts";
import { replyTemplateCategories } from "@tomokichi/admin-contracts";
import { useState } from "react";
import { Button, Card, DataState, inputClass, Page } from "../components/primitives";
import { api } from "../lib/api";
import { replyTemplateCategoryLabels } from "../lib/labels";

/**
 * Managing the canned replies.
 *
 * There is no delete. A template is deactivated, which takes it out of the
 * composer and leaves the record of what existed — and editing one never
 * changes a reply that was already sent, because the finished text was stored
 * on the message.
 */
export function ReplyTemplates() {
  const client = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<ReplyTemplate | null>(null);

  const templates = useQuery({
    queryKey: ["all-templates", showInactive],
    queryFn: () =>
      api.get<ReplyTemplate[]>(`/api/support/templates?includeInactive=${showInactive}`),
  });
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api.get<AppSummary[]>("/api/apps") });

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["all-templates"] });
    void client.invalidateQueries({ queryKey: ["reply-templates"] });
  };

  const save = useMutation({
    mutationFn: (template: ReplyTemplate) =>
      api.patch<ReplyTemplate>(`/api/support/templates/${template.id}`, {
        name: template.name,
        category: template.category,
        appId: template.appId ?? null,
        body: template.body,
        includeSignature: template.includeSignature,
        isActive: template.isActive,
        sortOrder: template.sortOrder,
      }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });

  const deactivate = useMutation({
    mutationFn: (id: string) =>
      api.post<ReplyTemplate>(`/api/support/templates/${id}/deactivate`, {}),
    onSuccess: invalidate,
  });

  return (
    <Page
      title="返信定型文"
      description="問い合わせ返信の定型文"
      actions={
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(event) => setShowInactive(event.target.checked)}
          />
          停止中も表示
        </label>
      }
    >
      <DataState
        loading={templates.isLoading}
        error={templates.error}
        empty={(templates.data?.length ?? 0) === 0}
        emptyMessage="定型文が登録されていません。"
      >
        <Card className="divide-y divide-line-soft">
          {(templates.data ?? []).map((template) => (
            <div key={template.id} className="px-4 py-3">
              {editing?.id === template.id ? (
                <TemplateForm
                  value={editing}
                  apps={apps.data ?? []}
                  onChange={setEditing}
                  onCancel={() => setEditing(null)}
                  onSave={() => save.mutate(editing)}
                  saving={save.isPending}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink">
                      {template.name}
                      {!template.isActive ? (
                        <span className="ml-2 text-xs text-ink-faint">(停止中)</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-faint">
                      <span className="font-mono">{template.key}</span>
                      <span>{replyTemplateCategoryLabels[template.category]}</span>
                      <span>{template.appSlug ?? "studio 共通"}</span>
                      <span>順序 {template.sortOrder}</span>
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={() => setEditing(template)}>編集</Button>
                    {template.isActive ? (
                      <Button variant="quiet" onClick={() => deactivate.mutate(template.id)}>
                        停止
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          ))}
        </Card>
      </DataState>
    </Page>
  );
}

function TemplateForm({
  value,
  apps,
  onChange,
  onCancel,
  onSave,
  saving,
}: {
  value: ReplyTemplate;
  apps: AppSummary[];
  onChange: (next: ReplyTemplate) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-ink-soft">名前</span>
          <input
            className={inputClass}
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">分類</span>
          <select
            className={inputClass}
            value={value.category}
            onChange={(event) =>
              onChange({ ...value, category: event.target.value as ReplyTemplateCategory })
            }
          >
            {replyTemplateCategories.map((category) => (
              <option key={category} value={category}>
                {replyTemplateCategoryLabels[category]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-soft">アプリ</span>
          <select
            className={inputClass}
            value={value.appId ?? ""}
            onChange={(event) => onChange({ ...value, appId: event.target.value || undefined })}
          >
            <option value="">studio 共通</option>
            {apps.map((app) => (
              <option key={app.id} value={app.id}>
                {app.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-ink-soft">本文</span>
        <textarea
          className={`${inputClass} min-h-48 leading-relaxed`}
          value={value.body}
          onChange={(event) => onChange({ ...value, body: event.target.value })}
        />
      </label>
      <p className="text-xs text-ink-faint">
        使用できる変数: {"{{appName}}"} {"{{userName}}"} {"{{supportUrl}}"} ・
        未置換のまま送信することはできません。
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={value.includeSignature}
            onChange={(event) => onChange({ ...value, includeSignature: event.target.checked })}
          />
          署名を付ける
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={value.isActive}
            onChange={(event) => onChange({ ...value, isActive: event.target.checked })}
          />
          有効
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          順序
          <input
            type="number"
            className="w-20 rounded-md border border-line px-2 py-1"
            value={value.sortOrder}
            onChange={(event) => onChange({ ...value, sortOrder: Number(event.target.value) })}
          />
        </label>
        <div className="ml-auto flex gap-2">
          <Button variant="quiet" onClick={onCancel}>
            キャンセル
          </Button>
          <Button variant="primary" disabled={saving} onClick={onSave}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  );
}
