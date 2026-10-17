# デプロイ

最終更新: 2026-10-10。

このリポジトリは特定の環境を持たない。`apps/*/wrangler.jsonc` はローカル開発とテストのための参照設定で、名前・ID・アドレスはすべてプレースホルダ。自分の Cloudflare アカウントに立てるときは、実際の値を持った設定を**自分のリポジトリ**に置き、release tag を固定してこのリポジトリをデプロイする。

## 1. デプロイ側に置くもの

```text
<deployment-dir>/
  api.jsonc           Core（apps/api）の Wrangler 設定
  admin.jsonc         API gateway（apps/admin）の Wrangler 設定
  mail-ingress.jsonc  受信メール（apps/mail-ingress）の Wrangler 設定
  seed.ts             任意。初期データ（DeploymentSeed、apps/api/seed/types.ts）
```

3 つの `.jsonc` は `apps/*/wrangler.jsonc` をコピーして値を埋める。ファイルは `apps/<app>/` にコピーされてから使われるので、`main`・`migrations_dir` などのパスは参照設定と同じまま（`apps/<app>/` からの相対）にする。

| 設定 | 何を入れるか |
|---|---|
| `name` | Worker 名。`admin.jsonc` と `mail-ingress.jsonc` の `services[].service` は Core の Worker 名に合わせる |
| `api.jsonc` の `d1_databases` / `r2_buckets` | `wrangler d1 create` / `wrangler r2 bucket create` で作った資源 |
| `api.jsonc` の `vars` | 送受信アドレス、`ADMIN_ORIGIN`（旧互換の origin）、`OPERATOR_TICKET_URL_TEMPLATE`、`VAPID_*`、`BRANDING`、`SIGNED_MODERATION` |
| `api.jsonc` の `services` | Moderation adapter を実装した Project の Worker（`SIGNED_MODERATION` の値と同じ binding 名） |
| `admin.jsonc` の `routes` | API gateway のホスト名（`custom_domain: true`） |
| `admin.jsonc` の `vars` | `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ADMIN_ORIGIN`（cookie 認証する利用者クライアントの Origin）、`DEFAULT_ADMIN_ROLE`（任意で `ADMIN_ROLES`） |

`seed.ts` の `mailSettings` で Project ごとの `supportEmail` / `noreplyEmail` /
`notificationEmail` / `fromName` / `ticketUrlTemplate`（通知リンクの行き先、v0.3.1+）/
`notifyByEmail`（`false` でその Project の新着通知メールを止める。Push は届く。v0.3.3+、migration
`0013`）を指定できます。未設定の項目は `api.jsonc` の既存値へ
フォールバックします。`mail-ingress.jsonc` の `APP_MAIL_ROUTES` は受信アドレスから
Project slug と転送先を解決する JSON 配列です。

`BRANDING` の項目は `packages/core/src/branding.ts` を参照（すべて任意。未設定なら中立な既定値）。UI のアイコンや画面は設定しない。利用者の UI は別途用意する。

### Project ごとの送信キーとブランド（v0.3.2+）

共通 API を使いながら送信契約を分けるには、Core の `vars.PROJECT_MAIL_PROVIDERS`
に **Project id** をキーとする設定を追加する。slug やブラウザ入力で Secret を
選ばせない。例:

```json
{
  "project-id": {
    "apiKeyBinding": "MAIL_API_KEY_PROJECT",
    "defaultSignature": "Example Support\nhttps://project.example.com",
    "supportUrl": "https://project.example.com/contact",
    "logo": { "url": "https://project.example.com/logo.png", "alt": "Example" }
  }
}
```

`MAIL_API_KEY_PROJECT` は Core の Worker Secret に登録する。キーを vars、D1、
seed、SDK、リポジトリへ保存しない。設定した Project は専用キーが未登録でも
共有 `MAIL_API_KEY` や共有ロゴへ戻らず、送信だけを拒否して下書きを残す。
設定のない Project は従来どおり。送信元・通知先は引き続き `app_mail_settings`
から解決し、既存の Ticket と返信履歴を移動する必要はない。

送信専用キーではメールの取得 API を呼べないため、Project のバックエンドで
署名検証した `email.sent` の `email_id` と `message_id` だけを、既存の Intake
binding の `fetch` で `POST /internal/projects/<slug>/mail-receipts` へ渡す。
binding の `props.projects` と保存済みの outbound message の Project が一致する
場合だけ記録する。本文・宛先は渡さない。送信確定より receipt が先に届く場合は
404 になるので、バックエンドは webhook を再試行させる。重複は成功、異なる
Message-ID による上書きは 409。これで受信返信のスレッド照合を維持する。
メール取得も許可された専用キーを使う場合だけ `lookupMessageIds: true` を設定
できる。未設定の共有プロバイダは従来の取得処理を維持する。

`reportReceiptTemplate` に、その Project の返信テンプレートの key を指定すると、
通報の受付メールをそのテンプレートで書く（指定しなければ基盤の汎用文面）。
`{{reportId}}` は受付ID、`{{appName}}`・`{{userName}}`・`{{supportUrl}}` は通常の
テンプレートと同じ。返信の照合に使うので本文に `受付ID: {{reportId}}` の行を残す
（無ければ基盤が末尾に足す）。テンプレートが無い・無効・他 Project のもの・未置換の
項目が残る場合は汎用文面で送る（受付メールは文面を理由に止めない）。

### 返信のスレッドと結び

返信は毎回、送信側で決めた `Message-ID`（`<uuid@supportアドレスのドメイン>`）で送り、
保存する（プロバイダが自分の Message-ID を返した場合はそちらを優先）。次の返信は
`In-Reply-To` / `References` でそれに答え、件名は最初の送信の件名に `Re:` を付けたものに
揃うので、1件の問い合わせ・通報のメールは相手のメールソフトで1つの会話にまとまる。
相手がそれに返信すると、同じチケットに入る。

`BRANDING.replyClosing` を設定すると、顧客へのすべてのメール（返信・受付メール）の
署名の直前にその1行を付ける。本文がすでにその文で終わっていれば重ねない。
ルート設定の `replyClosing` で Project ごとに上書きでき、空文字なら付けない。

### 問い合わせの受付メール

ルート設定で `inquiryReceipt: false` にした Project には送らない。

人が新しく問い合わせた時（Web フォーム、または既存スレッドに繋がらない新しいメール）に、
受付番号つきの自動受付メールを1回だけ送る。`Auto-Submitted: auto-replied` を付け、
タイムラインでは自動受付として表示し、初回返信（対応期限）には数えない。
送らないもの: 運営が作ったチケット、返信先の無いフォーム、既存スレッドへの追記、
通報（通報の受付メールがある）、このデプロイ自身の support アドレス、自動送信メール
（`Auto-Submitted`・`Precedence: bulk/list/junk`・`List-Id`・`Return-Path: <>`・
mailer-daemon / no-reply 等の差出人）。Web フォーム分は送信失敗を cron が24時間以内に再送する。

文面は次の順で最初に使えるテンプレート、無ければ基盤の汎用文面。
`inquiryReceiptTemplate`（このルート設定の key）→ `inquiry_receipt_<project slug の - を _ に>`
→ 共通の `inquiry_receipt`。有効で、その Project か共通のもので、未置換項目が残らないこと。
`{{ticketNumber}}` は受付番号。返信の照合に使うので `受付番号: {{ticketNumber}}` の行を残すとよい。

## 2. コマンド

v0.8.0以降はmail-ingressにもCoreと同じprivate bucketを`PRIVATE_FILES`でbindする。D1はCoreだけが保持する。[配送・受信処理の復旧](delivery-jobs.md)を参照。

固定した tag を clone して依存を入れ、`scripts/deploy.mjs` にデプロイ側のディレクトリを渡す。

```bash
git clone --depth 1 --branch v0.3.1 https://github.com/example-org/inquiry-platform.git
cd inquiry-platform
pnpm install --frozen-lockfile
```

```bash
node scripts/deploy.mjs <deployment-dir> check
```

| コマンド | 何をするか |
|---|---|
| `check` | 3 Worker の `wrangler deploy --dry-run`。何も変更しない。bindings と vars を目で確認する |
| `migrate` | `wrangler d1 migrations apply DB --remote` |
| `seed [--dry-run]` | `seed.ts` を SQL にして `wrangler d1 execute DB --remote`。`--dry-run` は SQL を表示するだけ |
| `deploy <api\|gateway\|mail-ingress\|all> [--dry-run]` | デプロイ。`all` は api → gateway → mail-ingress の順（Service Binding の依存順） |

設定ファイルは `apps/<app>/wrangler.deployment.jsonc` にコピーされる（git 管理外）。

## 3. 初回セットアップ

Service Binding は相手の Worker が存在しないと作れないので、この順に行う。

1. **D1 と R2**: `wrangler d1 create <name>`、`wrangler r2 bucket create <name>`。id を `api.jsonc` に入れる。R2 は非公開のまま（証跡は Access の背後の API gateway 経由でしか読まない）。
2. **Migration**: `deploy.mjs <dir> migrate`。
3. **Secret**（Core。`apps/api` で `wrangler secret put <NAME> --config wrangler.deployment.jsonc`、または Cloudflare のダッシュボード）:
   - `HASH_PEPPER`（必須。`openssl rand -hex 32`。通報が入った後に変えると仮名 ID が繋がらなくなる）
   - `MAIL_API_KEY`（任意。無ければ返信の送信ボタンだけが無効）
   - `NOTIFICATION_EMAIL`、`VAPID_PRIVATE_KEY`（任意。[通知](notifications.md)）
4. **Core をデプロイ**して seed: `deploy.mjs <dir> deploy api`、`deploy.mjs <dir> seed`。`0011_project_mail_settings.sql` 適用後、seed の `mailSettings` は指定した Project のメール設定を同期します。未指定の Project は従来の環境変数へフォールバックします。
5. **API gateway をデプロイ**: `deploy.mjs <dir> deploy gateway`（従来の `admin` も互換で利用可能）。
6. **Cloudflare Access**: Zero Trust → Access → Applications で API gateway のホスト名に Self-hosted の Application を作り、AUD tag とチームドメインを `admin.jsonc` に入れて再デプロイ。未設定の間、gateway は**すべての**リクエストを拒否する（意図した失敗モード）。
7. **受信メール**: `apps/mail-ingress` に Secret `SUPPORT_FORWARD_EMAIL` を入れて `deploy.mjs <dir> deploy mail-ingress`。Email Routing は、新しいテスト用アドレスで往復を確認してから本来のアドレスを Worker に向ける。
8. **Project を繋ぐ**: Project の Worker に `@inquiry-platform/sdk` を入れ、`Intake` に Service Binding する（[packages/sdk/README.md](../../packages/sdk/README.md)）。運用者向けの画面、CLI、自動化は利用者が用意し、同 SDK の Operator API client を使う。標準機能を複製しない。ブラウザから別 Origin へ直接呼ぶ構成は CORS を提供しないため、同一 Origin または利用者側の BFF を使う。

## 4. バージョンを上げる

1. 新しい tag の変更点、特に `apps/api/migrations` の追加を確認する。
2. D1 を private にバックアップ（`wrangler d1 export`）し、現在の Worker version を控える。
3. 新しい tag を clone して `check`。
4. `migrate` → `deploy all`。
5. Project 側の `@inquiry-platform/sdk` の tag も同じものに上げる。

ロールバックは直前の tag で `deploy all`。migration は forward-only で、古いコードは新しい列・表を無視するので D1 は戻さない。

## Project専用ストレージのrelease

0015〜0019は共通schemaの準備。Projectごとの実名・prefix・生成migrationはデプロイ側に置く。
[Project storage移行](project-storage.md)の順で、対応Worker検証 → prepare → copy → verify → cutover → sealを実施する。
本番変更にはバックアップ、previewでの復元・照合、明示的承認が必要。既存D1・R2・3 Workerの構成は変わらない。

同じgatewayで担当Projectを分けるときは、複数のscope付きCore Service Bindingを宣言し、
`ADMIN_CORE_ROUTES`（Access subject → binding名）で選ぶ。値は実デプロイ設定だけに置く。
設定を省略した既存gatewayは従来のADMIN_COREを使う。設定した場合は未登録subjectを拒否する。
roleに `support` / `moderator` を追加。従来operatorからModeration判定権限を外したため、既存判定担当は
adminまたはmoderatorへ明示的に割り当てる。Support担当に署名権限を追加しない。
