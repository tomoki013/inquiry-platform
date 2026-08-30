import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AppliedTemplate,
  ReplyTemplate,
  SupportDraft,
  SupportThreadDetail,
} from "@tomokichi/admin-contracts";
import { replySubjectFor } from "@tomokichi/admin-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { Dialog } from "./Dialog";
import { Button, inputClass } from "./primitives";

type Mode = "reply" | "note";
type DraftState = "idle" | "saving" | "saved" | "failed";

const DRAFT_DEBOUNCE_MS = 800;

/**
 * Writing back.
 *
 * Three things this component is careful about, in order of how bad getting
 * them wrong would be:
 *
 * 1. **An internal note is a different tab and a different endpoint.** Not a
 *    checkbox on the send button. The two paths do not share a request, and on
 *    the server they do not share a service — see `SupportService` versus
 *    `ReplyService`.
 * 2. **The draft is never thrown away by this component.** It is autosaved,
 *    restored on mount, and only the server deletes it, only after a provider
 *    has accepted the mail. A failed send leaves the text exactly where it was.
 * 3. **Inserting a template over existing text asks first.** Losing a half
 *    written reply to a mis-click is the small disaster that makes people stop
 *    trusting a composer.
 */
export function ReplyComposer({
  thread,
  mailConfigured,
}: {
  thread: SupportThreadDetail;
  mailConfigured: boolean;
}) {
  const client = useQueryClient();
  const [mode, setMode] = useState<Mode>("reply");
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [draftState, setDraftState] = useState<DraftState>("idle");
  const [pendingTemplate, setPendingTemplate] = useState<(AppliedTemplate & { id: string }) | null>(
    null,
  );
  /**
   * The template the operator inserted, if any.
   *
   * Kept so the send can name it. Only its **id** goes to the server, which
   * looks the subject up itself — the browser still never says what a reply's
   * subject is; it says which template was used and the subject is derived
   * there. Editing the inserted text does not clear it, because a reply is
   * normally a template with the specifics filled in, and dropping the subject
   * on the first keystroke would take it away exactly when it is wanted.
   */
  const [appliedTemplate, setAppliedTemplate] = useState<{ id: string; subject: string } | null>(
    null,
  );
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // One key per composed reply, reused across retries so a double-click or a
  // retried fetch produces one mail. Regenerated only after a send succeeds.
  const idempotencyKey = useRef(crypto.randomUUID());
  const loadedDraftFor = useRef<string | null>(null);

  const draft = useQuery({
    queryKey: ["support-draft", thread.id],
    queryFn: () => api.get<SupportDraft | null>(`/api/support/threads/${thread.id}/draft`),
  });

  const templates = useQuery({
    queryKey: ["reply-templates", thread.appId ?? "studio"],
    queryFn: () =>
      api.get<ReplyTemplate[]>(
        `/api/support/templates${thread.appId ? `?forAppId=${thread.appId}` : ""}`,
      ),
  });

  // Restore once per thread. Not on every fetch: a background refetch must not
  // overwrite what somebody is in the middle of typing.
  useEffect(() => {
    if (draft.data === undefined || loadedDraftFor.current === thread.id) return;
    loadedDraftFor.current = thread.id;
    setBody(draft.data?.bodyText ?? "");
  }, [draft.data, thread.id]);

  const saveDraft = useMutation({
    mutationFn: (bodyText: string) =>
      api.put<SupportDraft>(`/api/support/threads/${thread.id}/draft`, { bodyText }),
    onMutate: () => setDraftState("saving"),
    onSuccess: () => setDraftState("saved"),
    // The text on screen is never touched by a save failure. Somebody's words
    // are not this component's to discard because a request failed.
    onError: () => setDraftState("failed"),
  });

  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;

  /** Debounced, so a paragraph of typing is one write rather than forty. */
  useEffect(() => {
    if (loadedDraftFor.current !== thread.id) return;
    if (body === (draft.data?.bodyText ?? "")) return;
    const timer = setTimeout(() => saveRef.current.mutate(body), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [body, thread.id, draft.data?.bodyText]);

  const applyTemplate = useCallback(
    async (templateId: string) => {
      if (!templateId) return;
      const applied = await api.post<AppliedTemplate>(
        `/api/support/threads/${thread.id}/apply-template`,
        { templateId },
      );
      if (body.trim().length === 0) {
        setBody(applied.bodyText);
        setAppliedTemplate({ id: templateId, subject: applied.subject });
      } else {
        setPendingTemplate({ ...applied, id: templateId });
      }
    },
    [body, thread.id],
  );

  const onSent = (updated: SupportThreadDetail) => {
    idempotencyKey.current = crypto.randomUUID();
    setBody("");
    setAppliedTemplate(null);
    setDraftState("idle");
    loadedDraftFor.current = null;
    setSendError(null);
    client.setQueryData(["support-thread", thread.id], updated);
    void client.invalidateQueries({ queryKey: ["support-draft", thread.id] });
    void client.invalidateQueries({ queryKey: ["support-threads"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const send = useMutation({
    mutationFn: (reopenIfResolved: boolean) =>
      api.post<SupportThreadDetail>(`/api/support/threads/${thread.id}/reply`, {
        bodyText: body,
        idempotencyKey: idempotencyKey.current,
        reopenIfResolved,
        templateId: appliedTemplate?.id,
      }),
    onSuccess: onSent,
    onError: (error) =>
      setSendError(error instanceof Error ? error.message : "送信できませんでした。"),
  });

  const addNote = useMutation({
    mutationFn: () =>
      api.post<SupportThreadDetail>(`/api/support/threads/${thread.id}/notes`, { bodyText: note }),
    onSuccess: (updated) => {
      setNote("");
      client.setQueryData(["support-thread", thread.id], updated);
    },
  });

  const isSpam = thread.status === "spam";
  // Nothing to reply to. The app forms only ask for an address when somebody
  // wants an answer, so a thread can legitimately arrive with nowhere to send
  // one — the message is still here to be read, and 運営メモ still works.
  const hasReplyAddress = Boolean(thread.requesterEmail);
  const canSend =
    mailConfigured && hasReplyAddress && !isSpam && body.trim().length > 0 && !send.isPending;

  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <div role="tablist" aria-label="返信モード" className="mb-4 flex gap-1">
        <ModeTab active={mode === "reply"} onClick={() => setMode("reply")}>
          返信
        </ModeTab>
        <ModeTab active={mode === "note"} onClick={() => setMode("note")}>
          運営メモ
        </ModeTab>
      </div>

      {mode === "reply" ? (
        <>
          <dl className="mb-4 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            <Meta label="宛先">{thread.requesterEmail ?? "返信先なし"}</Meta>
            <Meta label="差出人">support@tmkch.io</Meta>
            <Meta label="件名">{appliedTemplate?.subject ?? replySubjectFor(thread)}</Meta>
          </dl>

          <div className="mb-3">
            <label className="block max-w-sm">
              <span className="mb-1 block text-xs font-medium text-ink-soft">定型文を選択</span>
              <select
                className={inputClass}
                value=""
                onChange={(event) => void applyTemplate(event.target.value)}
              >
                <option value="">選択してください</option>
                {(templates.data ?? []).map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.appSlug ? `[${template.appSlug}] ` : ""}
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            {(templates.data ?? []).length === 0 ? (
              <p className="mt-1 text-xs text-ink-faint">登録された定型文がありません。</p>
            ) : null}
          </div>

          <label className="block">
            <span className="sr-only">返信本文</span>
            <textarea
              className={`${inputClass} min-h-56 leading-relaxed`}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="返信を書く"
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p aria-live="polite" className="text-xs text-ink-faint">
              {draftState === "saving"
                ? "保存中…"
                : draftState === "saved"
                  ? "下書き保存済み"
                  : draftState === "failed"
                    ? "下書きを保存できませんでした"
                    : ""}
            </p>
            <Button
              variant="primary"
              disabled={!canSend}
              title={
                !mailConfigured
                  ? "メール送信機能が設定されていません"
                  : !hasReplyAddress
                    ? "返信先のアドレスがありません"
                    : isSpam
                      ? "迷惑メールに分類されています。先に解除してください。"
                      : undefined
              }
              onClick={() => {
                setSendError(null);
                // A resolved thread is reopened only after somebody says so.
                if (thread.status === "resolved") setConfirmReopen(true);
                else send.mutate(false);
              }}
            >
              {send.isPending ? "送信中…" : "送信"}
            </Button>
          </div>

          {!mailConfigured ? (
            <p className="mt-2 text-xs text-warn">メール送信機能が設定されていません。</p>
          ) : null}
          {!hasReplyAddress ? (
            <p className="mt-2 text-xs text-warn">
              返信を希望せずに送られた問い合わせです。返信先のアドレスがないため送信できません。
            </p>
          ) : null}
          {isSpam ? (
            <p className="mt-2 text-xs text-warn">
              迷惑メールに分類された問い合わせには返信できません。
            </p>
          ) : null}
          {sendError ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              {sendError}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="mb-2 text-xs text-ink-faint">
            運営メモは運営内のメモです。相手にメール送信されません。
          </p>
          <label className="block">
            <span className="sr-only">運営メモ</span>
            <textarea
              className={`${inputClass} min-h-40`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="mt-3 flex justify-end">
            <Button
              disabled={note.trim().length === 0 || addNote.isPending}
              onClick={() => addNote.mutate()}
            >
              {addNote.isPending ? "保存中…" : "メモを追加"}
            </Button>
          </div>
        </>
      )}

      <Dialog
        open={pendingTemplate !== null}
        title="現在の下書きを置き換えますか？"
        onClose={() => setPendingTemplate(null)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setPendingTemplate(null)}>
              キャンセル
            </Button>
            <Button
              onClick={() => {
                // Appending mixes two templates' words together; whichever
                // subject is already in force stays in force.
                setBody((current) => `${current}\n\n${pendingTemplate?.bodyText ?? ""}`);
                setPendingTemplate(null);
              }}
            >
              末尾に追加
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setBody(pendingTemplate?.bodyText ?? "");
                if (pendingTemplate) {
                  setAppliedTemplate({ id: pendingTemplate.id, subject: pendingTemplate.subject });
                }
                setPendingTemplate(null);
              }}
            >
              置き換える
            </Button>
          </>
        }
      >
        すでに書きかけの本文があります。
      </Dialog>

      <Dialog
        open={confirmReopen}
        title="この問い合わせは解決済みです"
        onClose={() => setConfirmReopen(false)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirmReopen(false)}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmReopen(false);
                send.mutate(true);
              }}
            >
              再開して返信
            </Button>
          </>
        }
      >
        送信するとステータスを「未対応」に戻します。
      </Dialog>
    </section>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        active ? "bg-accent-soft text-accent" : "text-ink-soft hover:bg-line-soft hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="truncate text-ink">{children}</dd>
    </div>
  );
}
