# Cutover — tomokichi-studio からの移行

最終更新: 2026-09-24。

## 現在の Phase

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 依存箇所の棚卸し | 完了（tomokichi-studio `docs/inquiry-platform-extraction.md`） |
| 2 | 本 Repository へ抽出（履歴付き）、ブランド・アプリ固有分岐・認可の分離 | PR #1（レビュー待ち） |
| 3 | Project 用 `Intake` entrypoint と SDK、tomokichi-api をそれ経由に | 基盤側: PR #2。tomokichi-studio 側: 切替 PR（Core のデプロイ後にマージ） |
| 4 | 本 Repository からのデプロイへ切替、旧管理画面との比較 | 未着手 |
| 5 | tomokichi-studio から旧コードを削除 | 未着手 |

**今のデプロイ元は tomokichi-studio だけ。** 本 Repository にはデプロイ workflow を置いていない。Phase 4 までは、tomokichi-studio 側の `apps/admin-core` / `admin-web` / `mail-ingress` / `packages/admin-*` への変更は凍結し、やむを得ず入れた変更は本 Repository にも移す。

## 承認記録

| 日付 | 操作 | 承認者 | 結果 |
|---|---|---|---|
| 2026-09-24 | Repository 作成（GitHub private、履歴付き）、Ticket モデル維持、Cloudflare 資源名維持 | Owner（tomoki013） | 実施済み（tomokichi-studio ADR-022） |
| 2026-09-24 | hono `^4.13.2` → `^4.13.5`（解決 4.13.8）。GHSA-crvj-82cr-hjcx ほか moderate 3 件の解消 | Owner（tomoki013） | 実施済み。`pnpm audit --prod` 0 件 |
| 2026-09-24 | dev 依存の脆弱性解消: vitest `^4.1.11`、lockfile 更新、`miniflare>sharp` / `miniflare>undici` の override | Owner（tomoki013） | 実施済み。`pnpm audit`（dev 含む）0 件 |
| 2026-09-24 | GitHub Actions が課金設定で起動しないため、CI をローカル実行で代替 | Owner（tomoki013） | PR #1 にローカル CI 結果を記録 |

## デプロイ順序（Phase 3 と 4 の関係）

tomokichi-api の新しい binding（`entrypoint: "Intake"`）は、`Intake` を含む Core が本番に出ていないと動かない。Core の本番は今 tomokichi-studio から出ているので、順序は次のとおり:

1. 本 Repository の PR #1 → #2 をマージ。
2. **Phase 4**: 本 Repository から 3 Worker をデプロイ（`Intake` を含む Core が本番に出る。既存の `AdminCore` 経由の動作は不変）。
3. tomokichi-studio の切替 PR（vendored SDK + `INQUIRY` binding、`ADMIN_CORE` binding の削除）をマージしてデプロイ。
4. tomokichi-api から `AdminCore` 全体への binding が消えたことを確認（`wrangler deploy --dry-run` の bindings）。

## Phase 4 の手順（予定）

同じ Worker 名・同じ D1・同じ R2 にデプロイするので、データ移行は無い。Worker の Secret は Worker に残っているので再設定も不要。

1. tomokichi-studio の admin 系変更が凍結されていることを確認する。
2. 差分確認:
   - `apps/api/migrations` が tomokichi-studio の `apps/admin-core/migrations` と一致すること（新規 migration がある場合は先に Owner 承認）。
   - 3 Worker の `wrangler deploy --dry-run` で bindings（D1、R2、Service Binding、vars）が既存と一致し、追加は `BRANDING` / `SIGNED_MODERATION` / `DEFAULT_ADMIN_ROLE` だけであること。
   - 本番 D1 の件数を記録する: `tickets`, `support_threads`, `reports`, `audit_logs`, `ticket_events` と status 別件数。
3. Cloudflare API token を本 Repository の GitHub Secret に設定し、deploy workflow を追加する（CI/CD 構成変更として Owner 承認）。
4. デプロイ順: `apps/api` → `apps/admin` → `apps/mail-ingress`（Service Binding の依存順）。
5. スモークテスト:
   - 管理画面の表示名・PWA 名が「Tomokichi Studio Admin」/「Tomokichi Admin」のまま。
   - テスト問い合わせ（Web フォーム）→ Ticket 作成 → 通知メール件名 `[Tomokichi Studio] 新しいお問い合わせがあります` と Push。
   - 返信の署名・HTML ロゴが従来どおり。
   - Remeet の通報で「クローズ」ボタンが出ず、署名付き操作だけが出る。
   - 2. で記録した件数が変わっていない（テスト分を除く）。
6. 同じ PR で tomokichi-studio の `deploy.yml` / `ci.yml` から admin 3 Worker を外す。

ロールバック: tomokichi-studio の直前のコミットから 3 Worker を再デプロイする（D1 / R2 は共有なので戻す対象はコードだけ）。

## Phase 3 で決めること

- 基盤の公開受付 API をどの Worker に置くか（Core は非公開のまま、別の公開 Worker を足すのが既存の境界に沿う）。
- SDK の配布方法（GitHub Packages 等は新しい外部サービス = Owner 承認）。
- Project ごとの client key（現在は全アプリ共通の 1 本）。
