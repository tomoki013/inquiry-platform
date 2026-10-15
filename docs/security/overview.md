# Security

最終更新: 2026-10-15。どの対策がどこで実装されているかの索引。

| 項目 | 実装 | 場所 |
|---|---|---|
| 認証 | Cloudflare Access + Worker での JWT 再検証（aud / iss / exp / 署名）。未設定なら全拒否 | `apps/admin/src/worker/access.ts`, `identity.ts` |
| 認可 | 業務権限（viewer / operator / admin / support / moderator）× permission。全 `/api/*` に適用、未知メソッドは拒否、未設定 role は viewer | `packages/core/src/authorization.ts`, `apps/admin/src/worker/index.ts` |
| 管理 API と公開 API の分離 | Operator API は Access 背後の gateway のみ。Core は route・`workers.dev` なし、Service Binding のみ | `apps/*/wrangler.jsonc` |
| API-only gateway | HTML、静的 asset、PWA、UI fallback を提供しない。全入口を同じ認証・認可 middleware に通す | `apps/admin/src/worker/index.ts` |
| CSRF / API client | Cookie 認証の変更系は Origin 一致 + `application/json`。Bearer / Access assertion の API client は JSON のみ。CORS ヘッダは出さない | `apps/admin/src/worker/security.ts`, `access.ts` |
| XSS | CSP・`nosniff` 等を全応答に付与。HTML メールはエスケープのみで生成、画像はデプロイ設定のロゴ 1 枚だけ | `security.ts`, `packages/notification/src/mail/html.ts` |
| Input validation | すべての Core 入力を zod で検証 | `packages/core/src/*.ts` |
| IDOR | 単一 Tenant。管理 API は Access + 認可の背後。Push 購読は操作者本人のものしか見えない・消せない。インターネットに Ticket を ID で引く経路は無い。Project 用 `Intake` / `ProjectOperator` は binding の `props` で Project を限定し、他 Project のチケットは存在しないものと同じに扱う。gateway の `AdminCore` binding も `props.scope` で service を限定でき、scope 外は同じく存在しない扱い | `apps/api/src/db/notifications.ts`, `apps/api/src/intake.ts` |
| 内部メモ | `visibility = 'INTERNAL'`。公開面から読む経路は無い。返信経路（`sendSupportReply`）と別メソッドで、メモが送信されることはない | `packages/core/src/core.ts` |
| Rate limit / Turnstile | 公開受付口。基盤は公開 HTTP を持たないので Project 側の Worker が持つ | 各 Project |
| Audit log | 変更と同一 `db.batch()`。削除 API なし。metadata は ID・コード・件数のみ | `apps/api/src/db/audit.ts` |
| エラー応答 | コードと固定文言と requestId のみ。ログにも本文を書かない | `apps/admin/src/worker/http.ts`, `apps/api/src/domain/failures.ts` |
| 通知 | Ticket 番号・種別・アプリ名・リンクのみ。本文・メールアドレスは載せない | `apps/api/src/domain/notification-service.ts` |
| ID の仮名化 | 通報者・投稿者 ID は `HASH_PEPPER` で HMAC。生 ID は保存しない | `apps/api/src/domain/identity.ts` |
| Secret 管理 | Worker Secret のみ（`MAIL_API_KEY`, `NOTIFICATION_EMAIL`, `VAPID_PRIVATE_KEY`, `HASH_PEPPER`, `SUPPORT_FORWARD_EMAIL`）。Repository に置かない。`.dev.vars` は ignore | Cloudflare |

## 既知の未対応

- `mail-ingress` は DKIM / SPF を検証しない。
- Core は Service Binding の呼び出し元を信頼する。Core 内での role 再検証はしていない（`AdminCore` に到達できる Worker が限られるため）。
- `ProjectOperator` の `props` は binding を書いた側（同じ Cloudflare アカウントの Worker）が決める。アカウント内の Worker は信頼境界の内側として扱う。誰がその Project の管理画面を使えるかは Project 側の認証の責務で、基盤は `operator.id` を監査に残すだけ。
- role による UI の出し分けは利用者クライアントの責務（サーバ側では常に拒否される）。

## Project保存先と業務権限（2026-10-15）

切替済みProjectの本文・個人情報・証跡参照・履歴は専用テーブルセットに保存する。
`ProjectRegistry` が登録済みprefixと固定suffixのホワイトリストを検証し、Repositoryは選択済み実表だけを変更する。
FKと所有者triggerを併用する。管理一覧の集約接続では業務表を書けない。偶発的なID衝突は予約表で拒否する。
全切替後はsealで旧表への書込とfallbackを禁止する。[移行手順](../operations/project-storage.md)。

support:read/reply/manage と moderation:read/review/decide を分ける。通常のoperatorは署名付き削除を実行できない。
署名必須Projectの最終判定は一般Ticket API、メール受信、Support状態変更、汎用resolution更新で迂回できない。
審査の開始/再開は `POST /api/reports/:id/review`、判定はdecide権限の専用APIを使う。
Support専用roleはReportの返信threadをIDで指定しても本文を読めない。メモにはmail providerへの経路がない。

複数Projectを同じgatewayで異なる担当者に割り当てる場合、デプロイ側でscope付きCore Service Bindingを宣言し、
`ADMIN_CORE_ROUTES` をAccess subjectからそのbinding名へ対応させる。マッピング設定時の未登録subjectは拒否する。
リクエストのslug・headerでbindingを選ばせない。platform担当は許可Projectをまとめたscopeを選ぶ。
追加WorkerやD1権限の配布は不要。`ProjectOperator`の人物認証は引き続きProject自身の責務。

監査ログ・配送jobは共通機構だが、本文や証跡の複製は載せず、Project scopeを強制する。
新R2キーはProject/domain名前空間を持つ。既存キーはメタデータ経由で所有者チェック後に読む。
共有D1自体の復旧・障害・容量は全Project共通であり、テーブル分離はCloudflareアカウント管理者からの隔離ではない。
