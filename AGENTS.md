# inquiry-platform — agent rules

Tomokichi Development Rules に従う（`.tomokichi/project.yml`、`tomokichi-dev-rules-mcp`）。この Repository 固有の規則:

1. **Core にアプリ・運営者の固有名を入れない。** `apps/*/src` と `packages/*/src` に Tomokichi Studio・Remeet 等の名前、`tmkch.io` のアドレスを書かない。表示名・署名・ロゴは `BRANDING`（`apps/api/wrangler.jsonc`）、アプリ固有の対応手段は `SIGNED_MODERATION` の adapter、運用データは `apps/api/seed/<deployment>/` に置く。`if (slug === "remeet")` の形の分岐は作らない。
2. **Cloudflare の資源名を変えない。** Worker 名・D1 `tomokichi-admin`・R2・`admin.tmkch.io` は既存の本番資源。名前の中立化は別作業（Owner 承認が必要）。
3. **認可は Worker で。** 新しい `/api/*` route は `permissionFor`（`packages/core/src/authorization.ts`）で分類される。設定系の書き込みを足すときは `CONFIGURATION_PATHS` に加える。UI で隠すだけにしない。
4. **通知に本文を載せない。** メール・Push に載せてよいのは Ticket 番号・種別・アプリ名・リンクだけ（[docs/operations/notifications.md](docs/operations/notifications.md)）。
5. **D1 migration は forward-only。** 本番への適用は Owner 承認を得てから。
6. **Project の入口は `Intake` だけ。** Project 向けの機能は `apps/api/src/intake.ts` と `packages/sdk` に足し、Project に `AdminCore` を bind させない。SDK の型を変えたら `scripts/vendor-sdk.mjs` で各 Project に配り直す。
7. **デプロイ元の切替中。** [docs/operations/cutover.md](docs/operations/cutover.md) の Phase を確認し、tomokichi-studio と同じ Worker を二重にデプロイしない。
