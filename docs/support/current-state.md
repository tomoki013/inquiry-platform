# 現状調査と再設計の差分

最終更新: 2026-10-10。対象: v0.3.2（`910da98`）。

共通お問い合わせ基盤の再設計（「機能と運用は共通化し、データ・メール・Project 固有の責任は分離する」）に入る前の現状記録。実在の Project 名は書かない（AGENTS.md 規則 1）。各デプロイ固有の対応表はデプロイ側リポジトリに置く。

## 1. 現在の構成

| 要素 | 実装 | 状態 |
|---|---|---|
| Core | `apps/api`（`AdminCore` / `Intake` / `ProjectOperator` の 3 entrypoint、route なし） | 全 Project の業務規則・D1・R2 を 1 Worker が持つ |
| API gateway | `apps/admin`（Access JWT 再検証、`permissionFor`、CSRF、`/api/*`、UI なし） | Core に `AdminCore` で bind |
| 受信メール | `apps/mail-ingress`（Email Worker、転送 → 解析 → `ingestInboundEmail`） | 1 Worker が全 Project の受信アドレスを `APP_MAIL_ROUTES` で振り分け |
| 契約 | `packages/core`（zod・型・API descriptor・認可表）、`packages/sdk`（依存ゼロ、tag 固定） | OpenAPI は無い。`GET /api` が descriptor を返す |
| 通知 | `packages/notification`（Resend / Web Push） | 番号だけの通知（規則 4） |
| 非同期 | cron `*/5`、`ctx.waitUntil` | Queue は無い。outbox 表も無い |
| 管理 UI | 基盤には無い。Project 自身の管理画面が `ProjectOperator` 経由で自 Project を扱う | 横断 UI は存在しない |

### 1.1 API（入口ごと）

| 指示書の系統 | 現状 | 場所 |
|---|---|---|
| Public Intake | `Intake`（`submitContact` / `submitReport` / 証跡 PUT / mail receipt）。公開 HTTP・Turnstile・rate limit は Project の Worker 側 | `apps/api/src/intake.ts`, `packages/sdk` |
| Admin | gateway の `/api/*` → `AdminCore`。Project 管理画面は `ProjectOperator` | `apps/admin/src/worker/routes/api.ts`, `apps/api/src/project-operator.ts` |
| Product Integration | `ModerationAdapter`（prepare / complete の署名付き決定）だけ | `packages/core/src/moderation.ts`, `apps/api/src/domain/moderation.ts` |
| Mail Adapter | `MailProvider`（Resend / 未設定）、`PROJECT_MAIL_PROVIDERS`（v0.3.2）、`/internal/projects/<slug>/mail-receipts` | `packages/notification/src/mail`, `apps/api/src/project-mail.ts`, `apps/api/src/mail-receipts.ts` |
| Event | 無い（moderation の完了は RPC の戻り値、配送結果は receipt のみ） | — |

### 1.2 データモデル（単一 D1）

- 旧表: `apps`, `app_links`, `reports`, `report_events`, `report_attachments`, `report_operations`, `support_threads`, `support_messages`, `support_attachments`, `support_drafts`, `support_reply_sends`, `support_thread_redirects`, `reply_templates`, `app_mail_settings`, `audit_logs`, `push_subscriptions`, `admin_notification_settings`。
- Ticket 表（0006、旧表からトリガで同期）: `tickets`, `ticket_numbers`, `ticket_sources`, `ticket_messages`, `ticket_events`, `ticket_reports`, `ticket_relations`, マスタ（`services`, `service_components`, `ticket_categories`, `assignment_groups`, `ticket_assignees`, `ticket_sla_settings`, `platform_settings`）。
- Project の分離は `tickets.service_id`（= `apps.id`）列と、`Intake` / `ProjectOperator` の `props.projects` による。**物理 DB は 1 つ。**
- 表示番号 `ticket_numbers.seq` はデプロイ全体で単調増加。
- 添付は 1 つの private R2（`PRIVATE_FILES`）。
- SQL は `apps/api/src/db/*` の Repository に大半があるが、`ticket-service.ts`・`reply-service.ts`・`report-service.ts`・`notification-service.ts`・`project-operator.ts`・`mail-receipts.ts`・`report-retention.ts`・`report-threading.ts` にも直接 `prepare` がある。

### 1.3 状態

内部 status は 8 値（`NEW`/`TRIAGE`/`ACKNOWLEDGED`/`IN_PROGRESS`/`WAITING_CUSTOMER`/`WAITING_INTERNAL`/`RESOLVED`/`CLOSED`）。遷移・楽観ロック・SLA・ACK・再オープン・merge は `TicketService` が強制（[tickets.md](../operations/tickets.md)）。SDK には簡易語彙（`OPEN`/`IN_PROGRESS`/`RESOLVED`/`CLOSED`）へ写像して返す。

### 1.4 認証・認可

- 運用者: Cloudflare Access + Worker での JWT 再検証。role は `viewer`/`operator`/`admin` の 3 段階で**全 Project 共通**（`ADMIN_ROLES` は Access subject → role）。Project 単位の付与は無い。
- Project 管理画面: Project 自身の認証。基盤は `operator.id` を監査に残すだけ。

### 1.5 メール

- 送信: Core が `MAIL_API_KEY`（共有）または `PROJECT_MAIL_PROVIDERS` の Project 専用キーで Resend を呼ぶ。**専用キーも Core の Worker Secret に置かれる**。送信元・宛先は `app_mail_settings`。冪等キーは `support_reply_sends`。
- 受信: Project ドメインの Email Routing が基盤の `mail-ingress` に向く。転送 → Core に保存。スレッド照合は Message-ID / In-Reply-To / References、次に通報 ID + 送信者。DKIM/SPF は未検証。
- 送信結果: Project の webhook が receipt を `Intake` の fetch へ渡す（v0.3.2）。

### 1.6 テスト・CI・デプロイ

- `pnpm run ci`（biome + tsc + vitest + build）。2026-10-10 時点で api 173 passed / 1 expected fail、他 package も全通過。
- `scripts/deploy.mjs <dir> check|migrate|seed|deploy`。デプロイ設定はデプロイ側リポジトリ。`cf` CLI は未導入（`wrangler` を `pnpm` 経由で使用）。
- 復旧: D1 export + 直前 tag で再デプロイ。migration は forward-only。

## 2. 指示書との差分

| # | 指示書の要求 | 現状 | 差分の大きさ |
|---|---|---|---|
| G1 | Project ごとに物理 Support DB | 単一 D1 + `service_id` | **大**。指示書が明示的に禁止する形 |
| G2 | Control DB（Project 登録・運用者・Project 単位ロール・接続状態） | 無い。`apps` 表と vars に分散 | 大 |
| G3 | Project 別 Support Worker（独立デプロイ・障害分離） | 1 Core が全 Project を処理 | 大 |
| G4 | メール資格情報は Project 側の実行環境が所有 | Project 専用キーも Core の Secret に集約 | 中 |
| G5 | 受信も Project 所有の Mail Adapter | 1 つの `mail-ingress` が全 Project のアドレスを受信 | 中 |
| G6 | 5 ロール × Project 単位付与 | 3 ロール × 全 Project | 中 |
| G7 | 横断一覧は各 Project API から取得（中央に複製しない） | 単一 DB を直接読むので「横断」は自明に成立 | G1 に従属 |
| G8 | outbox / Queue、未処理・失敗ジョブの可視化 | cron + waitUntil。送信は同期 | 中 |
| G9 | OpenAPI 等の公開契約 | zod + 型 + descriptor | 小〜中 |
| G10 | 標準 7 status | 内部 8 status + SDK 簡易 4 語彙 | 小（写像で足りる） |
| G11 | 添付の一時署名付き URL | gateway 経由のストリーム | 小 |
| G12 | 製品別の保持期限・削除処理 | 通報証跡の期限切れのみ（`report-retention.ts`） | 中 |
| G13 | Admin UI | 基盤は UI を持たない方針（README） | 方針の衝突（§4） |

## 3. 分類

| 分類 | 対象 |
|---|---|
| **そのまま共通化（Support Core として再利用）** | `TicketService`（遷移・SLA・ACK・merge・楽観ロック）、`ReplyService`（冪等・Message-ID 系・署名）、`SupportService` のスレッド照合、`ReportService` と署名付き moderation、監査を変更と同一 batch に書く方式、`packages/core` の zod 契約・エラー語彙、`packages/notification`、通知に本文を載せない規則 |
| **Control Plane へ移す** | `apps` 表の登録情報（Project の正）、`ADMIN_ROLES`/`DEFAULT_ADMIN_ROLE`（→ Project 単位のロール付与）、`SIGNED_MODERATION` などの接続設定の参照、ヘルスチェック、基盤自身の監査 |
| **Project 側（Product Support Worker のデプロイ設定）に残す** | Support DB・R2・メール資格情報・送受信アドレス・署名・ロゴ・`ticketUrlTemplate`・Turnstile / rate limit・Moderation adapter の実装 |
| **Adapter を新設して分離** | Database（Repository を D1 binding 単位に）、Mail（送信・受信・receipt を Project 所有の Worker へ）、Storage（R2 + 署名付き URL）、Product Integration（Moderation adapter を一般化）、Event / Queue（outbox） |
| **統合・廃止候補** | 旧表 → Ticket 表のトリガ二重化（新規 DB では Ticket 表を直接書く）、`AdminCore` の `listSupportThreads`/`listReports` 系の旧 API（409 を返すだけの旧遷移 route）、Ticket に写像済みの `services` 同期トリガ。いずれも既存 DB では保持し、新規 Project DB では使わない |

## 4. 決定（2026-10-10）

| 論点 | 決定 |
|---|---|
| 管理 UI | 基盤は API + バックエンドだけ。横断 UI は作らず、各製品の管理画面が `ProjectOperator` / Admin API を使う |
| DB | 製品ごとに D1 を分けない（G1・G3 は採らない）。1 つの Core・D1 の中で Project 単位に分ける現行の構成を維持する。チケットは `tickets.service_id` で Project に属し、Project 側の入口は binding の `props.projects` に限られる。複数アプリを 1 製品として扱うときは、その binding の `props.projects` に複数の slug を並べ、アプリは `service_id` で識別したまま |
| メール | Project ごとに `app_mail_settings`（送信元・通知先）、`PROJECT_MAIL_PROVIDERS`（専用送信キー）、`APP_MAIL_ROUTES`（受信アドレス → Project と転送先）で分ける（現行の仕組み） |
| ディレクトリ名・実在名 | 既存名を維持。製品固有の実装は各製品のリポジトリ（AGENTS.md 規則 1） |
| status 語彙 | 内部 8 値を維持し、契約で写像する |
| CLI | `wrangler` のまま |

製品別 D1 を前提にした差分（G1〜G3、§3 の Control Plane・製品別 Worker の分類）は採らない。§2 のその他の差分（G6 以降）は、必要になった時点で個別に扱う。
