import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  NotificationOverview,
  NotificationSettings as Settings,
} from "@tomokichi/admin-contracts";
import { useEffect, useState } from "react";
import { Button, DataState, Timestamp } from "../components/primitives";
import { api } from "../lib/api";
import {
  currentSubscription,
  isStandalone,
  permissionState,
  pushSupport,
  subscribeThisDevice,
  unsubscribeThisDevice,
} from "../lib/push";

/**
 * 設定 → 通知.
 *
 * The one screen that may ask the browser for notification permission, and
 * only when the person presses the button that says so. What it shows about a
 * device is a name and two timestamps; the endpoint and keys never come back
 * from the server and are never displayed.
 */
export function NotificationSettings() {
  const client = useQueryClient();
  const overview = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationOverview>("/api/notifications"),
  });
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const support = pushSupport();
  const permission = permissionState();

  useEffect(() => {
    void currentSubscription().then((sub) => setThisEndpoint(sub?.endpoint ?? null));
  }, []);

  const invalidate = () => client.invalidateQueries({ queryKey: ["notifications"] });

  const enable = useMutation({
    mutationFn: async () => {
      const key = overview.data?.pushPublicKey;
      if (!key) throw new Error("この環境ではPush通知を利用できません。");
      const result = await subscribeThisDevice(key);
      if (!result.ok) {
        throw new Error(
          result.reason === "denied"
            ? "通知が許可されませんでした。ブラウザの設定から許可すると登録できます。"
            : result.reason === "unsupported"
              ? "このブラウザではPush通知を利用できません。"
              : "Push通知の登録に失敗しました。",
        );
      }
      await api.post("/api/notifications/push/subscriptions", {
        endpoint: result.subscription.endpoint,
        keys: result.subscription.keys,
        deviceName: defaultDeviceName(),
      });
      return result.subscription.endpoint ?? null;
    },
    onSuccess: (endpoint) => {
      setThisEndpoint(endpoint);
      setMessage("この端末を登録しました。");
      void invalidate();
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : "登録に失敗しました。"),
  });

  const disable = useMutation({
    mutationFn: async () => {
      const endpoint = (await unsubscribeThisDevice()) ?? thisEndpoint;
      if (endpoint) await api.post("/api/notifications/push/unsubscribe", { endpoint });
    },
    onSuccess: () => {
      setThisEndpoint(null);
      setMessage("この端末の登録を解除しました。");
      void invalidate();
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : "解除に失敗しました。"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/notifications/push/subscriptions/${id}`),
    onSuccess: () => void invalidate(),
  });

  const save = useMutation({
    mutationFn: (settings: Settings) => api.put<Settings>("/api/notifications/settings", settings),
    onSuccess: () => void invalidate(),
  });

  const data = overview.data;
  const registeredHere =
    thisEndpoint !== null && permission === "granted" && data?.pushPublicKey !== undefined;

  return (
    <section className="ops-page">
      <header className="ops-header">
        <div>
          <p className="ops-eyebrow">SETTINGS / NOTIFICATIONS</p>
          <h1>通知設定</h1>
        </div>
      </header>
      <DataState loading={overview.isLoading} error={overview.error} empty={false} emptyMessage="">
        {data && (
          <div className="space-y-6">
            <section className="ops-panel">
              <h2 className="font-medium mb-1">Push通知</h2>
              <p className="text-sm text-ink-soft mb-4">
                新しい問い合わせ・通報をこの端末に通知します。通知にはTicket
                IDと対象アプリだけが含まれ、内容は管理画面でのみ確認できます。
              </p>
              {!data.pushPublicKey ? (
                <p className="text-sm text-warn">この環境ではPush通知が設定されていません。</p>
              ) : support === "needs-install" ? (
                <p className="text-sm text-ink-soft">
                  iPhone /
                  iPadでは、共有メニューから「ホーム画面に追加」した後にPush通知を有効にできます。
                </p>
              ) : support === "unsupported" ? (
                <p className="text-sm text-ink-soft">このブラウザではPush通知を利用できません。</p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  {registeredHere ? (
                    <>
                      <span className="text-sm text-good">この端末は登録済みです</span>
                      <Button onClick={() => disable.mutate()} disabled={disable.isPending}>
                        この端末を解除
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => enable.mutate()}
                      disabled={enable.isPending || permission === "denied"}
                      title={
                        permission === "denied" ? "ブラウザで通知がブロックされています" : undefined
                      }
                    >
                      Push通知を有効にする
                    </Button>
                  )}
                  {permission === "denied" ? (
                    <span className="text-sm text-warn">
                      ブラウザの設定で通知がブロックされています。
                    </span>
                  ) : null}
                  {!isStandalone() ? (
                    <span className="text-xs text-ink-faint">
                      ホーム画面に追加すると、アプリとして起動できます。
                    </span>
                  ) : null}
                </div>
              )}
              {message ? (
                <p role="status" className="mt-3 text-sm text-ink-soft">
                  {message}
                </p>
              ) : null}
            </section>

            <section className="ops-panel">
              <h2 className="font-medium mb-3">通知の種類</h2>
              <div className="space-y-3">
                <Toggle
                  label="お問い合わせ通知（Push）"
                  checked={data.settings.inquiryPush}
                  disabled={save.isPending}
                  onChange={(inquiryPush) => save.mutate({ ...data.settings, inquiryPush })}
                />
                <Toggle
                  label="通報通知（Push）"
                  checked={data.settings.reportPush}
                  disabled={save.isPending}
                  onChange={(reportPush) => save.mutate({ ...data.settings, reportPush })}
                />
                <Toggle
                  label="メール通知"
                  hint={
                    data.emailConfigured
                      ? "新着を知らせるメールです。内容は含まれません。"
                      : "この環境ではメール通知の宛先が設定されていません。"
                  }
                  checked={data.settings.emailEnabled}
                  disabled={save.isPending}
                  onChange={(emailEnabled) => save.mutate({ ...data.settings, emailEnabled })}
                />
              </div>
              {save.error ? (
                <p role="alert" className="mt-3 text-sm text-danger">
                  {save.error.message}
                </p>
              ) : null}
            </section>

            <section className="ops-panel">
              <h2 className="font-medium mb-3">登録済みの端末</h2>
              {data.devices.length === 0 ? (
                <p className="text-sm text-ink-faint">登録された端末はありません。</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.devices.map((device) => (
                    <li
                      key={device.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-ink">
                          {device.deviceName ?? "名称未設定"}
                          {device.userAgent ? (
                            <span className="ml-2 text-xs text-ink-faint">
                              {shortAgent(device.userAgent)}
                            </span>
                          ) : null}
                        </p>
                        <p className="text-xs text-ink-faint">
                          登録 <Timestamp value={device.createdAt} />
                          {device.lastUsedAt ? (
                            <>
                              {" ・ 最終通知 "}
                              <Timestamp value={device.lastUsedAt} />
                            </>
                          ) : null}
                        </p>
                      </div>
                      <Button
                        variant="quiet"
                        onClick={() => remove.mutate(device.id)}
                        disabled={remove.isPending}
                      >
                        解除
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DataState>
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm text-ink">{label}</span>
        {hint ? <span className="block text-xs text-ink-faint">{hint}</span> : null}
      </span>
    </label>
  );
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))
    return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "この端末";
}

function shortAgent(agent: string): string {
  if (/CriOS|Chrome/.test(agent)) return "Chrome";
  if (/FxiOS|Firefox/.test(agent)) return "Firefox";
  if (/Safari/.test(agent)) return "Safari";
  if (/Edg/.test(agent)) return "Edge";
  return "";
}
