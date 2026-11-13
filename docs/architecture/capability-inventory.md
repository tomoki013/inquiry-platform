# 共通基盤の機能棚卸し

調査日: 2026-11-11。対象: `main` の `b25832b`。このリポジトリの実装と参照設定を対象とし、各デプロイでの利用実績は未確認。後半の区分は再設計のたたき台。

## 現在の提供機能

| 機能 | 現在の動作と利用者 | 主な実装 |
| --- | --- | --- |
| 問い合わせ受付 | Project が `Intake` に送信。Project 範囲と入力を検証し、受付 ID・Ticket 番号を返す。同じ受付キーでの再送を重複登録しない。未分類受付は binding で明示許可 | [Intake](../../apps/api/src/intake.ts)、[SDK](../../packages/sdk/README.md) |
| 問い合わせ対応 | 一覧・検索・会話履歴、状態変更・再開、内部メモ、添付閲覧。メール送信と内部メモは別操作 | [SupportService](../../apps/api/src/domain/support-service.ts)、[TicketService](../../apps/api/src/domain/ticket-service.ts) |
| 高度な Ticket 運用 | 手動起票、ACK、優先度、担当・分類、次のアクション、SLA、関連付け・結合、ダッシュボード。Project 管理用 API が公開する項目はこの一部 | [TicketService](../../apps/api/src/domain/ticket-service.ts)、[Ticket 運用](../operations/tickets.md) |
| 通報・審査 | 外部通報 ID で重複排除し、対象・理由・証跡・履歴を管理。審査・最終判定・再審査は問い合わせと別の状態遷移。証跡は非公開 R2 で期限管理。署名が必要な Project は adapter 経由で措置を指示し、コンテンツ自体の操作は Project 側が担う | [ReportService](../../apps/api/src/domain/report-service.ts)、[証跡](../../apps/api/src/evidence.ts)、[Moderation 契約](../../packages/core/src/moderation.ts) |
| 送信メール | 問い合わせ・通報の受付メール、運用者返信、下書き・テンプレート、署名、引用・返信先制御、スレッド追跡、プロバイダーの配送結果反映。プロバイダーは Resend。Project 側が webhook を検証してから配送結果を `Intake` へ渡す | [ReplyService](../../apps/api/src/domain/reply-service.ts)、[配送設定](../../apps/api/src/project-mail.ts)、[配送結果](../../apps/api/src/mail-receipts.ts) |
| 受信メール | Email Routing から受け、転送を先に試みた後、原本を非公開 R2 に保存して Core へ渡す。送信者とメールの参照情報等で既存会話に照合し、添付も取り込む | [mail-ingress](../../apps/mail-ingress/src/index.ts)、[取り込みジョブ](../../apps/api/src/domain/inbound-jobs.ts) |
| 運用者通知 | 新着をメール・Web Push で通知。Push 端末・通知設定を管理。通知に含める情報は Ticket 番号・種別・Project 名・リンクに限定 | [NotificationService](../../apps/api/src/domain/notification-service.ts)、[通知の契約](../operations/notifications.md) |
| 配送復旧 | 受信取り込み・新着通知・障害通知を D1 のジョブで再試行し、運用 API から失敗を確認・再処理。受付メールの再試行と送信済み Message-ID の確認は別処理として同じ Cron に同居 | [DeliveryJobs](../../apps/api/src/domain/delivery-jobs.ts)、[Core の Cron](../../apps/api/src/index.ts) |
| 運用 API・横断集計 | 基盤運用者向け `/api/*` は Access と Worker の認可を経由。Project 自身の管理は既存の `ProjectOperator` で、自身の認証を使い binding の範囲内で操作。画面は利用側が持つ | [gateway](../../apps/admin/src/worker/index.ts)、[ProjectOperator](../../apps/api/src/project-operator.ts) |
| Project・運用設定 | Project 台帳、表示情報・リンク、既定受付先、分類マスタ、SLA、テンプレート、署名、メール設定。値の入力元は管理 API、デプロイ seed、Worker 変数・Secret に分散 | [seed](../../apps/api/seed/types.ts)、[Worker 環境](../../apps/api/src/env.ts)、[管理ルート](../../apps/admin/src/worker/routes/api.ts) |
| 共通の保護と保存 | Project 境界、検証、エラー形式、監査、個人情報保護。D1 は共有で、切替済み Project の業務データは専用テーブル。添付・証跡は非公開 R2。移行・暗号化の保守手順を持つ | [構成と保存先](overview.md)、[非公開ストレージ](../operations/private-storage.md) |

公開フォーム、公開ルートの認証やスパム対策、Project の管理画面、コンテンツへの措置、実際の送信アドレスやロゴは、現在も Project またはデプロイ側が用意する。Project は `AdminCore` を直接 bind しない。

## 機能がつながっている箇所

| 現在の依存 | 設計時に切り分けたいこと |
| --- | --- |
| **受付 → 通知・受付メール。** `Intake`、`ProjectOperator`、`AdminCore` は共通の [`buildServices`](../../apps/api/src/services.ts) を通る。フォーム受付はレコードと一緒に通知ジョブを保存し、受付メールも起動する。送信設定を空にしても配線そのものは残る | 受付の成功条件を保存・監査・受付結果に限定できるか。通知とメールは、有効な場合だけ配送処理を登録できるか |
| **通報 → Support 会話 → Ticket。** [`ReportService.create`](../../apps/api/src/domain/report-service.ts) は通報を作るたび、メール連絡先の有無にかかわらず Support スレッドと最初の内部メモも作る。そのスレッドの Ticket が通報の Ticket として使われる | 通報を単独で保存・審査し、連絡用の会話と横断一覧をそれぞれ必要なときだけ付けられるか |
| **返信・受付メール・運用通知 → メール設定。** [`buildLocalServices`](../../apps/api/src/services.ts) が同じ配送先解決と設定リポジトリを使用。送信者・宛先・署名・リンク・プロバイダー・スレッド運用の設定が `BRANDING`、seed/DB、`PROJECT_MAIL_PROVIDERS` などにまたがる | 「誰にどの内容を送ってよいか」「重複をどう防ぐか」は有効な機能の共通ルールにする。文面・表示・送信経路の値は機能の設定や Project に渡す |
| **デプロイ・保存も一式。** [`deploy.mjs`](../../scripts/deploy.mjs) の `check` と `deploy all` は 3 Worker を対象にし、[専用表の生成](../../apps/api/src/storage/migration.ts) は全 17 表を扱う。標準の Core Cron はメール・通知・証跡管理をまとめて処理 | 設定で送信を止めるだけでなく、使わない機能の Worker、binding、Secret、ジョブ、テーブルを新規導入時に要求しない構成を考える |

`GET /api` の capability 一覧は標準 API の説明。Project ごとに有効な機能を示す一覧としては使われていない。

## 提供範囲を決めるためのたたき台

| 区分 | 候補 |
| --- | --- |
| どの構成でも守る契約 | Project の識別と境界、入力検証、重複受付の防止、安定した ID・結果・エラー形式。保存したデータの認可・監査・個人情報保護。利用する機能の意味と状態遷移は Project 間で共通にする |
| 選んで追加する標準機能 | 問い合わせ受付・基本対応、通報受付・審査、送信メール、受信メール、運用通知、高度な運用（SLA・担当・分類など）、横断運用。配送復旧や証跡の保護は、それを必要とする機能に同梱する候補 |
| Project・デプロイ側が持つ値や処理 | 公開 UI・認証・公開入力の制御、ブランド・署名・文面、連絡先・管理画面 URL、分類の値や SLA 目標、プロバイダーの資格情報、実際のコンテンツ措置。必要なら対応する標準機能にだけ設定を渡す |

最初に「問い合わせ対応」と「通報・審査」を独立に選べるかを決める。仮に独立とするなら、次の構成で成り立つことを分離の判断基準にする。

- **問い合わせだけ**: 受付・一覧・詳細・内部メモ・解決が、メール設定や通報関連の設定なしで使える。
- **通報だけ**: 受付・審査・判定が、Support の会話や通知ジョブを作らずに使える。署名が必要なら Project の adapter を追加する。
- **メール付き**: 有効にした Project の会話だけに受付メール、返信、取り込みを足せる。運用通知と利用者向けのメールは別に選べる。

この段階では既存の API・SDK・保存形式を変更しない。削除や互換契約の変更は、実際に使われている機能をデプロイ側で確認した後に検討する。
