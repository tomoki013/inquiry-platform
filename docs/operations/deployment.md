# デプロイ

最終更新: 2026-09-27。

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
`notificationEmail` / `fromName` を指定できます。未設定の項目は `api.jsonc` の既存値へ
フォールバックします。`mail-ingress.jsonc` の `APP_MAIL_ROUTES` は受信アドレスから
Project slug と転送先を解決する JSON 配列です。

`BRANDING` の項目は `packages/core/src/branding.ts` を参照（すべて任意。未設定なら中立な既定値）。UI のアイコンや画面は設定しない。利用者の UI は別途用意する。

## 2. コマンド

固定した tag を clone して依存を入れ、`scripts/deploy.mjs` にデプロイ側のディレクトリを渡す。

```bash
git clone --depth 1 --branch v0.2.0 https://github.com/example-org/inquiry-platform.git
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
