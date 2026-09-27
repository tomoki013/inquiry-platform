# inquiry-platform — agent rules

メンテナのツール設定は `.tomokichi/project.yml`。この Repository 固有の規則:

1. **特定の運営者・Project の名前を入れない。** コード・テスト・ドキュメント・migration・参照設定（`apps/*/wrangler.jsonc`）に、実在の運営者名・アプリ名・ドメイン・連絡先を書かない。例示は `example.com` と架空の名前を使う。表示名・署名・ロゴは `BRANDING`、アプリ固有の対応手段は `SIGNED_MODERATION` の adapter、運用データはデプロイ側の seed（`seed/types.ts` の `DeploymentSeed`）で与える。`if (slug === "some-app")` の形の分岐は作らない。
2. **参照設定はプレースホルダのまま。** 実在の Worker 名・D1 id・route・Access の値は各デプロイの設定ファイルに置く（[docs/operations/deployment.md](docs/operations/deployment.md)）。
3. **認可は Worker で。** 新しい `/api/*` route は `permissionFor`（`packages/core/src/authorization.ts`）で分類される。設定系の書き込みを足すときは `CONFIGURATION_PATHS` に加える。UI で隠すだけにしない。
4. **通知に本文を載せない。** メール・Push に載せてよいのは Ticket 番号・種別・アプリ名・リンクだけ（[docs/operations/notifications.md](docs/operations/notifications.md)）。
5. **D1 migration は forward-only。** 既存の DB で挙動が変わる migration には、既存の値を引き継ぐ手段を持たせる（例: `0010_default_service_setting.sql`）。
6. **Project の入口は `Intake` だけ。** Project 向けの機能は `apps/api/src/intake.ts` と `packages/sdk` に足し、Project に `AdminCore` を bind させない。SDK の型を変えたら新しいタグを切る（Project は tag で SDK を固定している）。
