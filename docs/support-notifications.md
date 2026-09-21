# Support 通知・PWA — Notification Only

最終更新: 2026-09-21。実装: `apps/admin-core/src/domain/notification-service.ts`、`packages/admin-push`、`apps/admin-web/public/sw.js`。

## 1. 責務分離

```text
Support DB (Core D1)  = 問い合わせ・通報の唯一の正本
Admin (admin.tmkch.io) = 内容を見る・対応する唯一の場所
Email                  = 「新着がある」と知らせるだけ
Web Push               = 同上をリアルタイムに
AI                     = 明示的に許可された場合のみ（未実装。`aiProcessingAllowed` を足す余地だけ確保）
```

この分離は **DTO で固定** している。`TicketNotificationEvent`（`packages/admin-contracts/src/notifications.ts`）は `ticketId / ticketNumber / category / app / createdAt` しか持たず、本文・件名・氏名・メールアドレスのフィールドが存在しない。`renderTicketNotificationMail()` と `renderPushPayload()` はこの型の純関数なので、本文が漏れるにはまず型を変える必要がある。

## 2. フロー

```text
User → /support (Turnstile) or app (client key)
  → api /api/v1/support
      Validate → recordSupportMessage() → Core.createSupportThread   ← ここで受付。失敗は 502
  → Core: D1 batch (thread + message + audit) → trigger → tickets(INQUIRY)
  → Core: notify({ticketId, category}) を ctx.waitUntil で
      ├─ Email  : NOTIFICATION_EMAIL 宛に番号 + リンク
      └─ Push   : 有効な購読すべてに {type, ticketNumber, category, app, url}

Remeet → api /remeet/v1/reports
  → R2 outbox に書けたら 201（Core 不達でも受付。cron */5 で再送）
  → Core.createReport → tickets(REPORT) → 同じ notify
```

- **通知失敗 ≠ Ticket 作成失敗**。通知は batch 確定後に `ctx.waitUntil` で走り、`NotificationService.ticketCreated()` は投げない（`tests/notifications.test.ts` "notification failure is not ticket failure"）。
- **冪等**: フォームの `requestId` は `provider_message_id = form-<requestId>` として保存され、同じ requestId の再送は既存 Ticket を返す（通知も 1 回）。
- 受信メールで新規スレッドができた場合は **Push のみ**（メール本体が `SUPPORT_FORWARD_EMAIL` へ転送されているため）。

## 3. メール（Notification Only）

件名 `[Tomokichi Studio] 新しいお問い合わせがあります` / `新しい通報があります`。本文は 種別・対象アプリ・受付日時・`Ticket ID: #TK-000123`・`https://admin.tmkch.io/tickets/TK-000123` のみ。`Reply-To` 無し。冪等キー `ticket-notify-<ticketId>`。

`apps/api` から本文入りメールを送っていた `support/template.ts`・`reports.ts#notifyOperator` は削除。`apps/api` の `RESEND_API_KEY` / `SUPPORT_TO_EMAIL` は manifest 期限警告（本文なし）にだけ残る。

## 4. 管理画面リンクと認証

`/tickets/{ticketNumber}`。`TicketService.row()` は UUID でも `TK-` 番号でも引く。URL に番号以外は付けない（`safePath()` が `?` `#` を拒否）。

未認証時は Cloudflare Access が `admin.tmkch.io/*` を止め、ログイン後に元 URL へ戻す。Worker 側も JWT を再検証して 401（`worker.test.ts` "still gates /tickets/TK-000123"）。例外は `/manifest.webmanifest` と `/icons/*` だけ（ブラウザが cookie 無しで取りに来るため。中身は名前と画像）。

## 5. PWA

| 要素 | 場所 |
|---|---|
| manifest | `apps/admin-web/public/manifest.webmanifest`（`standalone`、`id: "/"`、`crossorigin="use-credentials"` で参照） |
| Service Worker | `apps/admin-web/public/sw.js`。**Cache Storage を一切使わない**。navigation 失敗時だけインライン HTML の「オフラインです」 |
| アイコン | `public/icons/`（main サイトのロゴを流用） |
| 登録 | `client/lib/pwa.ts` `registerServiceWorker()`（load 後、権限は要求しない） |
| 更新 | `useServiceWorkerUpdate()` → 画面右下に「再読み込み」バナー → `SKIP_WAITING` → `controllerchange` で reload |
| iOS | Home Screen に追加後のみ Push 可。設定画面がその旨を案内 |

Worker は `/sw.js` に `Cache-Control: no-cache` と `Service-Worker-Allowed: /` を付ける。

## 6. Web Push

- 実装: `packages/admin-push`。RFC 8291（aes128gcm, 1 record）+ RFC 8292（VAPID ES256）。**Web Crypto と fetch のみ**。Node の `web-push` は `crypto.createECDH` 等に依存し Workers で動かないので使わない。RFC 8291 Appendix A のテストベクタをバイト単位で照合するテストがある。
- 送信は Core（`NotificationService.sendPush`）。購読ごとに暗号化し並列送信。`404/410` は即 `revoked_at`、それ以外の失敗はカウントのみ。
- payload（復号後）:

```json
{ "type": "support.ticket.created", "ticketNumber": "TK-000123", "category": "inquiry", "app": "Remeet", "url": "/tickets/TK-000123" }
```

- `sw.js` の表示は固定文言 + `app • #番号`。payload に未知フィールドがあっても描画しない。
- タップ: 既存の管理画面ウィンドウを focus → `navigate`。無ければ `openWindow`。
- `pushsubscriptionchange`: 新しい購読を同じ操作者で再登録（cookie が乗る）。

## 7. Push Subscription

`push_subscriptions(id, admin_user_id, endpoint UNIQUE, p256dh, auth, user_agent, device_name, created_at, last_used_at, revoked_at)`（migration `0009`）。

- `admin_user_id` は Access の `sub`。API は `ActorRef` から取り、body の値は使わない。
- 他人の endpoint を登録しようとすると `CONFLICT`、他人の端末は list にも出ず revoke も `NOT_FOUND`（`tests/notifications.test.ts` "a subscription belongs to the operator who registered it"）。
- `endpoint` / `p256dh` / `auth` はブラウザに返さない。`assertSafeAuditMetadata` が `endpoint`/`p256dh`/`auth` キーを拒否する。
- 失効行は 30 日後に cron（Core `*/5`）で削除。

## 8. 通知設定

`/settings/notifications`（ナビ「通知設定」）。`admin_notification_settings(admin_user_id, inquiry_push, report_push, email_enabled)`。Push の種類は購読者ごと、メールは「設定行が無い or 誰かが ON」なら送る（運営 1 名の今は画面のトグルそのもの）。

Notification permission は「Push通知を有効にする」ボタンの中でだけ要求する（`NotificationSettings.test.tsx`）。

## 9. 環境変数

| Worker | 名前 | 種別 | 意味 |
|---|---|---|---|
| admin-core | `ADMIN_ORIGIN` | var | リンク先 `https://admin.tmkch.io` |
| admin-core | `VAPID_PUBLIC_KEY` | var | 65 byte P-256 点、base64url。ブラウザの `applicationServerKey` |
| admin-core | `VAPID_SUBJECT` | var | `mailto:support@tmkch.io` |
| admin-core | `VAPID_PRIVATE_KEY` | **secret** | 32 byte scalar、base64url |
| admin-core | `NOTIFICATION_EMAIL` | **secret** | 運営の通知先。無ければメール通知なし |
| admin-core | `MAIL_API_KEY` | secret（既存） | メール通知にも使う |

生成: `pnpm --filter @tomokichi/admin-core run vapid:generate`。**鍵を変えると全端末の再登録が必要**。

## 10. Cloudflare 側の手動設定

1. `wrangler secret put VAPID_PRIVATE_KEY` / `NOTIFICATION_EMAIL`、`wrangler.jsonc` の `VAPID_PUBLIC_KEY` を埋めて Core を deploy → Web を deploy。
2. Access: `admin.tmkch.io/manifest.webmanifest` と `admin.tmkch.io/icons/*` に **Bypass** ポリシーの Application を追加（無いとインストール画面のアイコンが Access のログイン HTML になる。ログインや通知タップの動作には影響しない）。
3. `pnpm admin:migrate:remote`（`0009_notifications.sql`）。

## 11. 実装フェーズとの対応

| Phase | 状態 |
|---|---|
| 1 メールから本文・PII を削除 | 済（api から本文メール自体を削除し、Core が番号だけ送る） |
| 2 Ticket URL と認証後 redirect | 済（Access + Worker 401。URL は番号のみ） |
| 3 PWA | 済（manifest / sw / icons / standalone / 更新バナー / オフライン画面） |
| 4 Web Push | 済（`admin-push`、Core 送信、sw 表示・タップ） |
| 5 通知設定・端末管理 | 済（`/settings/notifications`） |
| 6 Badging・通知カテゴリ・AI 制御 | 未（`aiProcessingAllowed` は列未追加） |
