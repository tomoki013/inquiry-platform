# inquiry-platform

アプリや Web サービスに届くお問い合わせ・通報を受け付け、確認し、対応し、履歴を残すための共通運用基盤。
Tomokichi Studio・Remeet・Colorvia・Yohaku などはこの基盤を使う「Project」の 1 つであり、基盤はどのアプリのことも特別扱いしない。

## 構成

| パス | 何か | Cloudflare Worker（Tomokichi 環境の実名） |
|---|---|---|
| `apps/api` | Ticket / Report / Support / Reply / Notification / Audit の全ドメイン規則と D1・R2 | `tomokichi-admin-core`（route なし、Service Binding のみ） |
| `apps/admin` | 管理コンソール。Cloudflare Access の JWT 検証、認可、CSP、`/api/*` | `tomokichi-admin-web`（`admin.tmkch.io`） |
| `apps/mail-ingress` | 受信メールを Ticket に繋ぐ | `tomokichi-mail-ingress` |
| `packages/core` | 境界そのもの: 型・zod・`AdminCoreApi`・エラー語彙・認可表・Branding スキーマ | — |
| `packages/notification` | `./mail`（Resend / 未設定）と `./push`（Web Push、Web Crypto のみ） | — |
| `packages/sdk` | Project が使う契約とクライアント（依存ゼロ）。`scripts/vendor-sdk.mjs` で Project に配る | — |

Worker・D1・R2 の名前は tomokichi-studio から移したときのまま（[ADR](docs/architecture/overview.md#決定事項)）。

## 使い方

```bash
pnpm install
```

```bash
pnpm ci
```

`pnpm ci` = `biome ci` + `check` + `test` + `build`。ローカル開発と Cloudflare の初期設定は [apps/api/README.md](apps/api/README.md)。

## ドキュメント

- [アーキテクチャ](docs/architecture/overview.md) — 境界、Project、Branding、Moderation adapter、Ticket モデルと簡易語彙の写像
- [セキュリティ](docs/security/overview.md) — 認証・認可・公開面・通知に載せない情報
- [移行（cutover）](docs/operations/cutover.md) — tomokichi-studio からデプロイ元を移す手順と現在の Phase
- 運用: [Tickets](docs/operations/tickets.md) / [通報ワークフロー](docs/operations/report-workflow.md) / [通知](docs/operations/notifications.md)
