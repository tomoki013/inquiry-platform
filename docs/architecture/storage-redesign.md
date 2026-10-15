# Project storage と業務ドメインの移行

調査基点: main `1bd610c` (2026-10-15)。本番データの読み取り・変更・デプロイは実施していない。

## 現状調査

3 Worker は Core、Access を検証する API gateway、メール受信。UI は利用側にある。
Project は props で許可を固定した Intake / ProjectOperator に接続し、D1 / R2 は Core だけが持つ。

保存の起点は SupportService → support_threads / support_messages、ReportService → reports / report_events。
Report は返信用 support_thread を作る。0006/0010 のトリガが tickets / ticket_sources / ticket_messages /
ticket_events / ticket_reports へ投影する。TicketService はチケットを直接変更し、一部を旧表に反映する。
旧 ID、TK 番号、Report 外部受付 ID、Message-ID、返信の冪等キーに外部依存がある。
Support と Report の状態は別の語彙だが、Ticket 再開と受信メールのトリガが Report まで再開してしまう。
署名の prepare / complete は ReportService と SIGNED_MODERATION にある。

0014 は配送ジョブと送信進捗を追加。原文は private R2 に30日保持し、ジョブのリース・再試行・原文からの
復旧を行う。返信はプロバイダの冪等キーを使う。通知は番号・種別・Project 名・リンクだけ。
本文、宛先、下書き、証跡、署名用操作、履歴が複数の関連表に存在するため tickets だけを移す方法では不十分。
Audit は本文を原則保存しないが、ticket_events の旧履歴には通報メモが含まれる。

## 設計判断

D1 と3 Workerを維持する。共通設定（apps / services / templates / メール設定 / 認証・通知設定）、
番号の採番、配送ジョブの実行基盤は共有する。業務データと履歴は Project 専用のテーブルセットに保存する。
Project slug を SQL 識別子に変換しない。デプロイ側が生成・レビューした migration が registry に
Project と安全な storage prefix を登録し、実行時は registry の許可済み suffix と prefix の検証を通して選ぶ。

共通 Repository とドメインサービスの SQL は再利用し、Project Database が固定テーブルセットへ解決する。
管理一覧はアプリケーションが構成する読み取り専用の UNION で集約し、業務表に対する書き込みは必ず
単一の Project Database を使用する。ID だけの旧 API で所有者が曖昧なら拒否する。
既存の Service Binding props による認可を重ね、利用側入力だけではプロダクトを選べないようにする。

Support は会話・担当・メモ・返信・下書き・解決・再開と SLA を持つ。
Moderation の正は reports の審査状態・処理結果・署名 revision・操作履歴とする。
Ticket は受付番号・担当・優先度・一覧の互換表現として残す。Support の会話の再開が Moderation の判定を
変更してはならず、一般 Ticket API から通報を決定してはならない。
Report のメール会話は受付・追加情報の通信経路であり、審査の状態機械から独立する。
投稿時の自動チェックは対象外。異議申立ては将来の独立したイベントとして拡張可能とする。

## 互換性とリスク

公開 SDK メソッド・応答・ID・番号・R2 の既存キーを維持する。Project を跨ぐ移管・結合は暗黙に行わず拒否する。
新オブジェクトには Project / domain の名前空間を使う。旧キーはメタデータから読み、移動・削除しない。
通報の最終決定は署名フローまたは専用 Moderation 権限を必要とする。通常 operator に削除権限を与えない。

移行は表作成 → 旧経路で受付を続ける間の同期 → 冪等なコピー → 全列照合・参照整合性確認 → 切替。
切替時には旧書き込みをフェンスし、古い Worker が受付成功を返して取り残すことを防ぐ。
コピーや照合は通知・返信・Adapter を実行しない。失敗したデータを消してやり直す運用にしない。
共有 D1 の障害・バックアップ・Time Travel の復旧単位は全プロダクト共通。
Project 単位の論理抽出は registry のテーブル一覧と共有設定の参照を含む別手順を設ける。

実装: `apps/api/src/storage/schema.ts`（識別子・所有者）、`database.ts`（専用接続・読み取り集約）、
`migration.ts`（デプロイ固有SQL生成）、`services.ts`（操作前の保存先解決）。
詳細な生成・検証・切替・復旧は [Project storage運用手順](../operations/project-storage.md)。

## 検証結果

ローカルCloudflare Workers/D1で、旧経路と専用表経路を検証した。
基盤の `pnpm run ci`（Biome、型検査、全356テスト、3 Workerのdry-run build）が通過。
移行・専用表の13統合テストには、全列・件数照合、繰り返しコピー、コピー中の新着、照合失敗時の原子的切替中止、
旧書き込み拒否、全serviceのseal、ID衝突・外部キー・未登録/許可外Projectの拒否、同じ冪等キーを別Projectで使う受付、
内部メモ非送信、送信者/署名、provider keyの切替互換、共有受信箱の返信紐付け、証跡所有者を含む。
既存SDKの5テストも変更なしで通過。署名Adapterの障害・同時完了・同一operationの再試行と遅延revisionも検証した。
生成prepare SQLはWranglerの実際のsplitterとSQLiteでも検証した。
本番の全列照合・稼働release・バックアップ復元検証は、各デプロイ側の実行記録に保管する。
実メール配送やコンテンツ操作の本番テストは、送信先・対象を定めた運用確認として別途扱う。

## 段階的な互換性変更

- 既存Intake / ProjectOperatorのメソッド・公開型は維持した。SDKの型変更・新tagはこの変更では不要。
- 未登録slugの暗黙の既定Projectへの格納、一般Ticket APIの通報判定、Supportのメール受信による通報再開は廃止。
- operatorは審査メモ・Support運用を維持し、Moderation判定担当はadmin/moderatorへ明示設定する。
- 一般Ticketを通報に変更する操作、新しいREPORT種別の汎用Ticket作成は拒否し、Report受付APIを使う。
- Project移管は専用表を跨ぐデータ移行。通常APIの暗黙の付け替えは行わない。
- 旧表の削除は行わず、active後は専用表だけを正とする。デプロイには対応サーバーreleaseを使用し、
  利用側が基盤のreleaseをSDK tagから選ぶ場合は、公開済み対応releaseへ計画的に更新する。
