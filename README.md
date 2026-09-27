# inquiry-platform

アプリや Web サービスに届くお問い合わせ・通報を受け付け、確認し、対応し、履歴を残すための運用基盤。Cloudflare Workers・D1・R2 の上で動く。

基盤を使うアプリ・サイトを「Project」と呼ぶ。基盤はどの Project も特別扱いしない。運営者の名前・ドメイン・署名・Project の一覧は、すべてデプロイする側の設定とデータで与える（このリポジトリには含まれない）。

## 構成

| パス | 何か | Worker（参照設定での名前） |
|---|---|---|
| `apps/api` | Ticket / Report / Support / Reply / Notification / Audit の全ドメイン規則と D1・R2 | `inquiry-core`（route なし、Service Binding のみ） |
| `apps/admin` | 管理コンソール。Cloudflare Access の JWT 検証、認可、CSP、`/api/*` | `inquiry-admin` |
| `apps/mail-ingress` | 受信メールを Ticket に繋ぐ | `inquiry-mail-ingress` |
| `packages/core` | 境界そのもの: 型・zod・`AdminCoreApi`・エラー語彙・認可表・Branding スキーマ | — |
| `packages/notification` | `./mail`（Resend / 未設定）と `./push`（Web Push、Web Crypto のみ） | — |
| `packages/sdk` | Project が使う契約とクライアント（依存ゼロ） | — |

`apps/*/wrangler.jsonc` はローカル開発とテスト用の参照設定で、値はすべてプレースホルダ。実際のデプロイは各自の設定ファイルで行う（[デプロイ](docs/operations/deployment.md)）。

## 使い方

```bash
pnpm install
```

```bash
pnpm run ci
```

`pnpm run ci` = `biome ci` + `check` + `test` + `build`。ローカル開発は [apps/api/README.md](apps/api/README.md)。

### Project から使う

Project の Worker は `packages/sdk` を依存に加え、`Intake` entrypoint に Service Binding する。

```jsonc
// package.json
"@inquiry-platform/sdk": "github:tomoki013/inquiry-platform#v0.1.0&path:/packages/sdk"
```

詳しくは [packages/sdk/README.md](packages/sdk/README.md)。

## ドキュメント

- [アーキテクチャ](docs/architecture/overview.md) — 境界、Project、Branding、Moderation adapter、Ticket モデルと簡易語彙の写像
- [デプロイ](docs/operations/deployment.md) — 自分の Cloudflare アカウントに立てる手順と、バージョンの上げ方
- [セキュリティ](docs/security/overview.md) — 認証・認可・公開面・通知に載せない情報
- 運用: [Tickets](docs/operations/tickets.md) / [通知](docs/operations/notifications.md)

## License

[MIT](LICENSE)
