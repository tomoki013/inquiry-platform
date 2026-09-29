# Support 通知

最終更新: 2026-09-27。通知は Core が所有し、利用者には同じ API と通知 payload だけを提供する。UI、PWA、Service Worker はこの repository には含めない。

## 責務分離

```text
Support DB (Core D1) = 問い合わせ・通報の唯一の正本
API gateway          = 認証・認可済みの標準 API
Email / Web Push     = 新着の通知だけ
利用者               = 任意の画面・CLI・自動化
```

`TicketNotificationEvent`（`packages/core/src/notifications.ts`）は
`ticketId / ticketNumber / category / app` だけを持つ。本文、件名、氏名、メールアドレス、時刻は通知 payload に入らない。`renderTicketNotificationMail()` と `renderPushPayload()` が唯一の変換点である。

## フロー

```text
Project → Intake.submitContact / Intake.submitReport
  → Core: D1 batch (ticket + message + audit)
  → Core: notify({ ticketId, category })
      ├─ Email : 番号 + 種別 + Project 名 + リンク
      └─ Push  : { type, ticketNumber, category, app, title, url }
```

通知失敗は Ticket 作成を失敗させない。通知は batch 確定後に `ctx.waitUntil` で実行する。`idempotencyKey` / `externalReportId` の再送は既存 Ticket を返し、通知も 1 回だけ送る。

## API 契約

通知設定と端末管理は API gateway の次の標準 path で行う。

- `GET /api/notifications`
- `PUT /api/notifications/settings`
- `POST /api/notifications/push/subscriptions`
- `POST /api/notifications/push/unsubscribe`
- `DELETE /api/notifications/push/subscriptions/:id`

全 path は Access JWT の再検証、role による認可、JSON 入力検証、`private, no-store` を gateway/Core で強制する。対象操作者は request body ではなく検証済み JWT の subject から決める。利用者はこれらの機能を Project 側で再実装しない。

## セキュリティ

- 通知には Ticket 番号・種別・Project 名・リンクだけを載せる。
- `endpoint` / `p256dh` / `auth` は API response と監査 metadata に返さない。
- 他人の購読は list に出ず、revoke も `NOT_FOUND` とする。
- Web Push は RFC 8291 / RFC 8292 を `packages/notification` の Web Crypto 実装で行う。通知 URL はデプロイ設定の `OPERATOR_TICKET_URL_TEMPLATE` から生成し、利用者の UI の route を基盤が固定しない。
- `404/410` の push endpoint は失効し、それ以外の送信失敗は Ticket 作成結果に影響させない。

## 設定

| Worker | 名前 | 種別 |
|---|---|---|
| Core | `VAPID_PUBLIC_KEY` | var |
| Core | `VAPID_SUBJECT` | var |
| Core | `VAPID_PRIVATE_KEY` | secret |
| Core | `NOTIFICATION_EMAIL` | secret |
| Core | `MAIL_API_KEY` | secret |

`OPERATOR_TICKET_URL_TEMPLATE` は `https://operator.example.com/tickets/{ticketNumber}` のような URL template。利用者が作る運用クライアントの実際の route を指定し、`{ticketNumber}` だけを基盤が差し替える。

Project が自分の管理画面を持つ場合は、seed の `mailSettings[].ticketUrlTemplate`（`app_mail_settings.ticket_url_template`、migration 0012）でその Project の通知リンクだけを差し替える。メールと Web Push の両方に効く。

具体的な値はデプロイ側の設定に置く。API gateway は通知を送らず、Core の結果を認証済み利用者へ返すだけである。
