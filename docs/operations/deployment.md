# デプロイ

最終更新: 2026-09-27。

このリポジトリは特定の環境を持たない。`apps/*/wrangler.jsonc` はローカル開発とテストのための参照設定で、名前・ID・アドレスはすべてプレースホルダ。自分の Cloudflare アカウントに立てるときは、実際の値を持った設定を**自分のリポジトリ**に置き、release tag を固定してこのリポジトリをデプロイする。

## 1. デプロイ側に置くもの

```text
<deployment-dir>/
  api.jsonc           Core（apps/api）の Wrangler 設定
  admin.jsonc         管理コンソール（apps/admin）の Wrangler 設定
  mail-ingress.jsonc  受信メール（apps/mail-ingress）の Wrangler 設定
  seed.ts             任意。初期データ（DeploymentSeed、apps/api/seed/types.ts）
  admin-assets/       任意。管理コンソールのアイコン等（ビルド成果物に上書きされる）
```

3 つの `.jsonc` は `apps/*/wrangler.jsonc` をコピーして値を埋める。ファイルは `apps/<app>/` にコピーされてから使われるので、`main`・`migrations_dir`・`assets.directory` などのパスは参照設定と同じまま（`apps/<app>/` からの相対）にする。

| 設定 | 何を入れるか |
|---|---|
| `name` | Worker 名。`admin.jsonc` と `mail-ingress.jsonc` の `services[].service` は Core の Worker 名に合わせる |
| `api.jsonc` の `d1_databases` / `r2_buckets` | `wrangler d1 create` / `wrangler r2 bucket create` で作った資源 |
| `api.jsonc` の `vars` | 送受信アドレス、`ADMIN_ORIGIN`、`VAPID_*`、`BRANDING`、`SIGNED_MODERATION` |
| `api.jsonc` の `services` | Moderation adapter を実装した Project の Worker（`SIGNED_MODERATION` の値と同じ binding 名） |
| `admin.jsonc` の `routes` | 管理コンソールのホスト名（`custom_domain: true`） |
| `admin.jsonc` の `vars` | `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ADMIN_ORIGIN`、`DEFAULT_ADMIN_ROLE`（任意で `ADMIN_ROLES`） |

`BRANDING` の項目は `packages/core/src/branding.ts` を参照（すべて任意。未設定なら中立な既定値）。

## 2. コマンド

固定した tag を clone して依存を入れ、`scripts/deploy.mjs` にデプロイ側のディレクトリを渡す。

```bash
git clone --depth 1 --branch v0.1.0 https://github.com/tomoki013/inquiry-platform.git
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
| `deploy <api\|admin\|mail-ingress\|all> [--dry-run]` | デプロイ。`all` は api → admin → mail-ingress の順（Service Binding の依存順） |

設定ファイルは `apps/<app>/wrangler.deployment.jsonc` にコピーされる（git 管理外）。

## 3. 初回セットアップ

Service Binding は相手の Worker が存在しないと作れないので、この順に行う。

1. **D1 と R2**: `wrangler d1 create <name>`、`wrangler r2 bucket create <name>`。id を `api.jsonc` に入れる。R2 は非公開のまま（証跡は Access の背後の管理コンソール経由でしか読まない）。
2. **Migration**: `deploy.mjs <dir> migrate`。
3. **Secret**（Core。`apps/api` で `wrangler secret put <NAME> --config wrangler.deployment.jsonc`、または Cloudflare のダッシュボード）:
   - `HASH_PEPPER`（必須。`openssl rand -hex 32`。通報が入った後に変えると仮名 ID が繋がらなくなる）
   - `MAIL_API_KEY`（任意。無ければ返信の送信ボタンだけが無効）
   - `NOTIFICATION_EMAIL`、`VAPID_PRIVATE_KEY`（任意。[通知](notifications.md)）
4. **Core をデプロイ**して seed: `deploy.mjs <dir> deploy api`、`deploy.mjs <dir> seed`。seed は guarded insert だけで、再実行しても重複せず、管理画面で編集した定型文を上書きしない。
5. **管理コンソールをデプロイ**: `deploy.mjs <dir> deploy admin`。
6. **Cloudflare Access**: Zero Trust → Access → Applications で管理コンソールのホスト名に Self-hosted の Application を作り、AUD tag とチームドメインを `admin.jsonc` に入れて再デプロイ。未設定の間、管理コンソールは**すべての**リクエストを拒否する（意図した失敗モード）。
7. **PWA のアイコン**: `<ホスト名>/manifest.webmanifest` と `<ホスト名>/icons/*` に Bypass ポリシーの Access Application を追加する（ブラウザは cookie なしで取りに来る）。
8. **受信メール**: `apps/mail-ingress` に Secret `SUPPORT_FORWARD_EMAIL` を入れて `deploy.mjs <dir> deploy mail-ingress`。Email Routing は、新しいテスト用アドレスで往復を確認してから本来のアドレスを Worker に向ける。
9. **Project を繋ぐ**: Project の Worker に `@inquiry-platform/sdk` を入れ、`Intake` に Service Binding する（[packages/sdk/README.md](../../packages/sdk/README.md)）。

## 4. バージョンを上げる

1. 新しい tag の変更点、特に `apps/api/migrations` の追加を確認する。
2. D1 を private にバックアップ（`wrangler d1 export`）し、現在の Worker version を控える。
3. 新しい tag を clone して `check`。
4. `migrate` → `deploy all`。
5. Project 側の `@inquiry-platform/sdk` の tag も同じものに上げる。

ロールバックは直前の tag で `deploy all`。migration は forward-only で、古いコードは新しい列・表を無視するので D1 は戻さない。
