# inquiry-platform

アプリや Web サービスに届くお問い合わせ・通報を受け付け、確認し、対応し、履歴を残すための運用基盤。Cloudflare Workers・D1・R2 の上で動く。

## 配布と運用

- ソースコードは Git repository と release tag で配布する。npm への公開は前提にしない。
- ホスティング済みの共用環境は提供しない。利用者が自分の Cloudflare アカウントへセルフホストする。
- 利用者固有の Worker 名、D1/R2、ドメイン、表示名、署名、seed、運用クライアント URL はデプロイ側の設定に置く。
- SDK の型や標準 API が変わる場合は新しい release tag を切り、Project は tag を固定して更新する。

基盤を使うアプリ・サイトを「Project」と呼ぶ。基盤はどの Project も特別扱いしない。運営者の名前・ドメイン・署名・Project の一覧は、すべてデプロイする側の設定とデータで与える（このリポジトリには含まれない）。

## 構成

| パス | 何か | Worker（参照設定での名前） |
|---|---|---|
| `apps/api` | Ticket / Report / Support / Reply / Notification / Audit の全ドメイン規則と D1・R2 | `inquiry-core`（route なし、Service Binding のみ） |
| `apps/admin` | API gateway。Cloudflare Access の JWT 検証、認可、CSRF 保護、`/api/*`。UI は提供しない | `inquiry-api` |
| `apps/mail-ingress` | 受信メールを Ticket に繋ぐ | `inquiry-mail-ingress` |
| `packages/core` | 境界そのもの: 型・zod・`AdminCoreApi`・API descriptor・エラー語彙・認可表 | — |
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
"@inquiry-platform/sdk": "github:example-org/inquiry-platform#v0.2.0&path:/packages/sdk"
```

詳しくは [packages/sdk/README.md](packages/sdk/README.md)。

### Operator API から使う

運用者向けの標準機能も API だけを提供します。管理画面・CLI・自動化は各利用者が実装し、`@inquiry-platform/sdk` の `createPlatformApiClient` で同じ API を使います。認証・認可・入力検証・監査・通知・個人情報の扱いは gateway/Core が強制するため、利用者側で再実装しません。`GET /api` が標準機能とセキュリティ契約を返します。ブラウザから別 Origin へ直接呼ぶための CORS は提供しないため、同一 Origin または利用者側の BFF を使います。

標準 API と同じ機能を Project 側で置き換えることは許可しません。追加機能は標準 API の外側にある独自拡張として実装します。

## ドキュメント

- [アーキテクチャ](docs/architecture/overview.md) — 境界、Project、Branding、Moderation adapter、Ticket モデルと簡易語彙の写像
- [デプロイ](docs/operations/deployment.md) — 自分の Cloudflare アカウントに立てる手順と、バージョンの上げ方
- [セキュリティ](docs/security/overview.md) — 認証・認可・公開面・通知に載せない情報
- 運用: [Tickets](docs/operations/tickets.md) / [通知](docs/operations/notifications.md)

## License

[MIT](LICENSE)
