# Architecture

最終更新: 2026-09-27。

## 1. 境界

```mermaid
flowchart TB
  subgraph Projects["各 Project（基盤の外）"]
    Site["ブランドサイトの /support フォーム"]
    ProjAPI["各 Project の公開 API"]
    Adapter["Moderation adapter\n（Project が実装）"]
  end
  subgraph Platform["inquiry-platform"]
    Admin["apps/admin\nAccess JWT → 認可 → /api/*"]
    Core["apps/api\nTicket / Report / Support / Reply\nNotification / Audit"]
    Ingress["apps/mail-ingress"]
  end
  Site --> ProjAPI
  ProjAPI -- "Service Binding → Intake entrypoint\n（submitContact / submitReport / 証跡 PUT）" --> Core
  Email((Email Routing)) --> Ingress --> Core
  Admin -- "Service Binding（AdminCoreApi）" --> Core
  Core -- "SIGNED_MODERATION に登録された binding" --> Adapter
  Core --> D1[(D1)]
  Core --> R2[(R2 private)]
  Core -- "番号だけの通知" --> Mail["Resend / Web Push"]
```

- Core（`apps/api`）は route も `workers.dev` も持たない。到達手段は Service Binding だけで、呼び出し側は `@inquiry-platform/core` の型しか知らない。
- Core には入口が 2 つある。`AdminCore`（基盤自身: 管理コンソールと mail-ingress）と `Intake`（Project 用: 受付だけ）。Project は `Intake` にだけ bind する（§7）。
- インターネットに面した受付口（Turnstile・client key・rate limit）は Project 側の Worker にある。基盤は公開 HTTP を持たないので、独自ドメインは要らない。Service Binding が使えない相手（別アカウントの Worker、iOS から直接など）が出たときに、`Intake` の前に公開 Worker を足す。
- 基盤が知るのは「誰が・どの対象を・何の理由で」まで。対象が何であるか、どう消すかは Project が知る（Moderation adapter）。

## 2. Project

- **Project の正は `apps` 表**（slug、名前、リンク、メール署名）。管理画面の「アプリ」は Project のこと。
- `services` 表は Ticket 分類用の写しで、`apps` への INSERT トリガで同期される（`0006_ticket_core.sql`）。Project を持たない問い合わせは `platform_settings.default_service_id` の service に入る。未設定なら組み込みの `unassigned`。どの service にするかはデプロイ側の seed（`defaultServiceId`）で決める（`0010_default_service_setting.sql`）。
- Tenant は導入しない。外部提供を始めるときに `Tenant → Project` へ拡張する。

## 3. Ticket モデル

現行モデルを正とする。

| 項目 | 値 |
|---|---|
| type | `INQUIRY` / `REPORT` / `BUG` / `INCIDENT` / `BILLING` / `PRIVACY` / `OTHER` |
| status | `NEW` / `TRIAGE` / `ACKNOWLEDGED` / `IN_PROGRESS` / `WAITING_CUSTOMER` / `WAITING_INTERNAL` / `RESOLVED` / `CLOSED` |
| resolution | `RESOLVED` / `NO_ACTION_REQUIRED` / `SPAM` / `DUPLICATE` / … / `CONTENT_REMOVED` |
| 表示 ID | `ticket_numbers.seq`（DB の主キーとは別） |
| 旧 ID | `ticket_sources(source_type, source_id)` — 旧 `support_threads` / `reports` の ID |

公開 API / SDK（Phase 3）では次の簡易語彙に写像する。DB には写像後の値を保存しない。

| 簡易 status | 内部 status |
|---|---|
| `OPEN` | `NEW`, `TRIAGE`, `ACKNOWLEDGED` |
| `IN_PROGRESS` | `IN_PROGRESS`, `WAITING_CUSTOMER`, `WAITING_INTERNAL` |
| `RESOLVED` | `RESOLVED` |
| `CLOSED` | `CLOSED` |

| 簡易 type | 内部 type |
|---|---|
| `contact` | `INQUIRY` |
| `report` | `REPORT` |
| `bug` | `BUG` |

Report の拡張項目は指示書の語彙と次の対応: `targetType`=`contentType`、`targetId`=`contentExternalId`、`targetOwnerId`=`authorRefHash`（HMAC 仮名。生 ID は保存しない）、`reason`=`reasonCode`、`description`=`detail`、`evidence`=R2 の添付。

内部メモは `ticket_messages.visibility = 'INTERNAL'`。公開面から取得する経路は存在せず、Project 用の `Intake` には読み取りメソッドが無い。

## 4. Branding

表示名・フォールバック署名・旧署名・メールロゴ・既定 Project はデプロイ設定の `BRANDING`（Core の構造化 var）だけに置く。`parseBranding`（`packages/core/src/branding.ts`）が検証し、不正・未設定なら中立な既定値（"Inquiry Platform"、署名なし、ロゴなし）になる。

- Core: 通知メール件名、返信のフォールバック署名、HTML メールのロゴ、Push のタイトル。
- 管理コンソール: `consoleProfile()` を `/api/session` で受け取り表示。PWA manifest と HTML の `<title>` は Worker が配信時に書き換える（ビルド成果物は "Admin" のみ）。
- Project ごとの署名は従来どおり `app_mail_settings`。

## 5. Moderation adapter

通報対象の「削除」を Project が自分で実行する仕組み。`SIGNED_MODERATION`（Project slug → Service Binding 名）に登録された Project は:

- 報告のクローズがラベル変更ではできず、Core → adapter.prepare → 運営が端末で署名 → adapter.complete の署名付き決定でのみ閉じる。
- adapter が到達不能でも「署名必須」は維持される（安全側）。

実装: `apps/api/src/domain/moderation.ts`（`ModerationRegistry`）、契約 `ModerationAdapter`（`packages/core/src/moderation.ts`）。

## 6. 認可

`packages/core/src/authorization.ts` に権限表を置き、管理 Worker が全 `/api/*` に適用する（UI の表示制御は補助）。

| role | 権限 |
|---|---|
| `viewer` | 閲覧、自分の通知設定 |
| `operator` | + Ticket 操作（返信・メモ・状態・通報の決定） |
| `admin` | + Project・マスタ・定型文・署名の設定 |

role は `ADMIN_ROLES`（Access subject → role）、なければ `DEFAULT_ADMIN_ROLE`、なければ `viewer`。運営者が 1 人なら `DEFAULT_ADMIN_ROLE=admin` でよい。

Core 自身は呼び出し元を Service Binding で信頼する（Core に到達できる Worker は宣言済みの 3 つだけ）。

## 7. Intake と SDK

Project が使う唯一の入口。`apps/api/src/intake.ts`（`Intake` entrypoint）と `packages/sdk`。

```ts
const inquiry = createInquiryClient(env.INQUIRY);
await inquiry.createContact({ projectSlug, idempotencyKey, subject, message, email, channel: "web_form" });
const r = await inquiry.createReport({ projectSlug, externalReportId, targetType, targetId, targetOwnerId, reason, description });
if (r.ok) await inquiry.attachReportEvidence(r.value.reportId, { bytes, contentType });
```

- **どの Project に書けるかは binding が決める。** Project 側 `wrangler.jsonc` の Service Binding に `props: { caller, projects, allowUnassigned }` を書く。`props` が無い・不正なら全拒否。許可外の `projectSlug` は `FORBIDDEN`。
- 冪等キー（`externalReportId`、`idempotencyKey`）が他 Project のものと衝突した場合は `CONFLICT` を返し、相手の ID も番号も返さない。証跡も他 Project の通報には「存在しない」と同じ 404。
- 返すのは受付番号と簡易 status（`OPEN` 等）だけ。本文は返さない。
- 読み取り・メモ・状態変更は `Intake` に存在しない。
- SDK は依存ゼロ。Project は release tag を指定した git 依存で取り込む（[packages/sdk/README.md](../../packages/sdk/README.md)）。

## 決定事項

- 3 Worker 分割（Core は非公開、管理コンソールは D1 / R2 を持たない）、Access JWT の Worker 側再検証、監査ログを変更と同一 batch に書く、署名付き削除、通報者・投稿者 ID の HMAC 仮名化、旧表 + トリガによる Ticket モデルへの移行、番号だけの通知、依存なしの Web Push。
- 運営者固有の値はコードにも参照設定にも置かず、デプロイ設定（`BRANDING`、`SIGNED_MODERATION`、Worker 名・資源名）と seed で与える。
