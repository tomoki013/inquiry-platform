# Security

最終更新: 2026-09-24。どの対策がどこで実装されているかの索引。

| 項目 | 実装 | 場所 |
|---|---|---|
| 認証 | Cloudflare Access + Worker での JWT 再検証（aud / iss / exp / 署名）。未設定なら全拒否 | `apps/admin/src/worker/access.ts`, `identity.ts` |
| 認可 | role（viewer / operator / admin）× permission。全 `/api/*` に適用、未知メソッドは拒否、未設定 role は viewer | `packages/core/src/authorization.ts`, `apps/admin/src/worker/index.ts` |
| 管理 API と公開 API の分離 | 管理は `admin.tmkch.io`（Access 背後）のみ。Core は route・`workers.dev` なし、Service Binding のみ | `apps/*/wrangler.jsonc` |
| CSRF | 変更系は Origin 一致 + `application/json` のみ、CORS ヘッダを出さない | `apps/admin/src/worker/security.ts` |
| XSS | CSP・`nosniff` 等を全応答に付与。HTML メールはエスケープのみで生成、画像はデプロイ設定のロゴ 1 枚だけ | `security.ts`, `packages/notification/src/mail/html.ts` |
| Input validation | すべての Core 入力を zod で検証 | `packages/core/src/*.ts` |
| IDOR | 単一 Tenant。管理 API は Access + 認可の背後。Push 購読は操作者本人のものしか見えない・消せない。インターネットに Ticket を ID で引く経路は無い | `apps/api/src/db/notifications.ts` |
| 内部メモ | `visibility = 'INTERNAL'`。公開面から読む経路は無い。返信経路（`sendSupportReply`）と別メソッドで、メモが送信されることはない | `packages/core/src/core.ts` |
| Rate limit / Turnstile | 公開受付口（現在は Project 側の tomokichi-api） | tomokichi-studio `apps/api` |
| Audit log | 変更と同一 `db.batch()`。削除 API なし。metadata は ID・コード・件数のみ | `apps/api/src/db/audit.ts` |
| エラー応答 | コードと固定文言と requestId のみ。ログにも本文を書かない | `apps/admin/src/worker/http.ts`, `apps/api/src/domain/failures.ts` |
| 通知 | Ticket 番号・種別・アプリ名・リンクのみ。本文・メールアドレスは載せない | `apps/api/src/domain/notification-service.ts` |
| ID の仮名化 | 通報者・投稿者 ID は `HASH_PEPPER` で HMAC。生 ID は保存しない | `apps/api/src/domain/identity.ts` |
| Secret 管理 | Worker Secret のみ（`MAIL_API_KEY`, `NOTIFICATION_EMAIL`, `VAPID_PRIVATE_KEY`, `HASH_PEPPER`, `SUPPORT_FORWARD_EMAIL`）。Repository に置かない。`.dev.vars` は ignore | Cloudflare |

## 既知の未対応

- `mail-ingress` は DKIM / SPF を検証しない（tomokichi-studio `docs/DECISIONS.md` 「根拠が文書に無いもの」）。
- Core は Service Binding の呼び出し元を信頼する。Core 内での role 再検証はしていない（到達できる Worker が 3 つに限られるため）。
- **Project 側 Worker（tomokichi-api）の binding は `AdminCore` entrypoint 全体に届く。** コード上は `createReport` / `createSupportThread` / 添付の `fetch` しか呼ばないが、読み取りや内部メモの RPC も技術的には呼べる。Phase 3 で Project 用の狭い entrypoint（受付だけ）に分ける。
- role による UI の出し分けは未実装（サーバ側では拒否される）。
