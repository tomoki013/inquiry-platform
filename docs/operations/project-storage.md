# Project 専用ストレージへの移行

この手順は単一の共有 D1 を維持する。SQL生成はオフライン。本番への読み取り・バックアップ・適用・デプロイは
別の明示的な承認を得て実施する。以下の例は架空の `orbit` Project。

## 移行前の準備

1. 稼働release、D1 migration適用履歴、apps / services の対応、default_service_id、Service Binding props、
   SIGNED_MODERATION、メール設定・通知先を棚卸しする。共有受信箱の返信もテストする。
2. 承認のうえ D1 の論理exportと Time Travel bookmarkを保存する。R2 の保持・ライフサイクル規則も確認する。
   exportに本文・個人情報が含まれるため、暗号化・限定アクセス・保持期限を設定する。バックアップを共有Gitに入れない。
3. exportをローカル/previewへ復元し、適用済みschemaとgeneratorの基点schemaが一致することを確認する。
4. 0015〜0019を適用し、対応Core・gateway・mail-ingressを検証する。この段階ではregistryが空なので旧経路で受付する。
   0016は既存の状態や判定を書き換えず、以降のメールと通報の状態連動を止める。
   0018は送信前にprovider keyを保存する。アップグレード前の古い返信RPCはドレインしてから移行を始める。
5. 対象serviceのslugに対し、リクエストとは無関係なprefixをデプロイ側で割り当てる。prefixは
   `p_[a-z][a-z0-9_]{0,30}`。一度登録した対応を変更・再利用しない。既定service・unassignedも計画に含める。

## SQL生成と段階適用

Node 24 の組み込み SQLite がschemaをメモリ上で再現する。Cloudflareの認証情報は使わない。

```sh
node scripts/deploy.mjs /path/to/deployment storage prepare orbit p_product01 > 0020_orbit_prepare.sql
node scripts/deploy.mjs /path/to/deployment storage copy orbit p_product01 > copy.sql
node scripts/deploy.mjs /path/to/deployment storage verify orbit p_product01 > verify.sql
node scripts/deploy.mjs /path/to/deployment storage cutover orbit p_product01 > 0021_orbit_cutover.sql
```

SQLはデプロイ側のGitで管理する。基盤の参照設定や共通migrationに実在のProject名を追加しない。
デプロイの `migrations_dir` は基盤の0019までと生成済みの番号付きmigrationを含む組み立て済みディレクトリに向ける。
同名・同番号の衝突を禁止し、生成元release SHAも記録する。準備・切替SQLをコピー先だけに置き忘れない。

- **prepare**: 移行元・先の列一覧を照合してschema driftを拒否し、Project Registry登録、17業務表、FK・既存index・専用のprojection trigger・所有者guardを作成。
  旧表のINSERT/UPDATE/DELETEを専用表へ追従するmirrorを設置する。切替前の専用表の業務projectionは停止するので
  コピーでTicketを作り直したり、通知・メール・Adapterを呼んだりしない。準備は単一migration/batchで適用する。
- **copy**: 親から子の順にコピーする。同値の既存行は処理せず、欠落・差分だけをsourceの現行値で補完する。コピー中は旧表が正で、SELECTとupsertは一つのwrite statementとして直列実行されるため、古いsnapshotで新しいmirrorを上書きしない。
  全コピーは小規模なpreview用。本番では次の表単位・件数限定コピーを繰り返す。
- **verify**: 表ごとに元と先の件数、全列の双方向EXCEPTによる差分数を出す。件数だけ一致していても合格にしない。
- **cutover**: 全表差分0・物理FK整合性を再検証し、registryをactiveにする。**全statementを一つのD1 batchまたは
  一つのmigrationで適用する**。途中で分割しない。アサーション失敗は全体をrollbackし、旧経路で受付を続ける。

大きい表は、`storage tables` の一覧に対応する旧表名（`src/storage/schema.ts` の storageTables順）ごとに実施する。
たとえば `support_threads` を完了させてから `support_messages` へ進む。

```sh
node scripts/deploy.mjs /path/to/deployment storage copy orbit p_product01 support_threads 1000 > copy-threads.sql
```

同じSQLを changes=0 まで繰り返し、次の表へ進む。削除済み・更新済みの値もmirrorが追従する。
まだコピーされていない親への新着子レコードはmirrorでは待機し、親のコピー後に現行の値をコピーする。
DBの外に本文を持ち出す必要はない。D1のクエリ時間・書込量を見ながらbatchを小さくする。

## 切替時の整合性

切替と旧表フェンスは同じregistryのstateを参照する。旧Workerが切替後に書くと `ProjectStorageMoved` で失敗する。
成功した受付が旧表に取り残されることはない。呼び出し側は同じ冪等キーで再送する。コピー中のProjectを跨ぐ
割り当て・結合は止める。切替前に未完了の返信RPCをドレインし、メール・通知ジョブの再試行を確認する。

フォームの冪等キー・通報外部IDは専用表のローカルキー。別Projectで同じキーを使っても相互参照しない。
フォーム同時受付には専用unique indexがある。既存のUUID・番号は維持し、共有の不透明ID予約表で偶発的な
ID衝突を拒否する。providerの送信keyは送信前intentに保存され、切替を跨いだ再試行でも変わらない。
切替後に始まる返信はProject・thread・キーから導出したprovider keyを使う。

古いDBに重複フォームキー、孤児、Projectを跨ぐ結合・関連、所有者不一致があるとコピーまたは切替は失敗する。
失敗を無視したり、INSERT OR REPLACEで上書きしたり、元データを削除して帳尻を合わせない。
両方の履歴を保持する是正migrationを個別にレビューし、コピー・照合を再開する。

各Projectの切替後、実際のIntake / ProjectOperator / 管理API / 返信・受信 / 証跡 / 通知 / 監査 / SLA / 署名処理を確認する。
全service（既定・unassignedを含む）がactiveになったら、最後にsealを生成する。

```sh
node scripts/deploy.mjs /path/to/deployment storage seal > 0030_storage_sealed.sql
```

全serviceの登録を確認するアサーションと `project_storage_required=1` の更新を一つのmigration/batchとして適用する。
以後、未準備のProjectへの受付は拒否し、旧業務表への全書き込みを禁止する。appsの登録だけでは受付可能にならない。
旧表は読取用の保管データとして残す。active後のcopy/prepare/cutover再実行は稼働中データを戻さない。

## 障害と前進修復

- prepare/copy失敗: 旧経路が正。registryはcopyingのまま。原因を直し、親からcopyと照合を再実行する。
- 切替チェック失敗: activeになっていないことを確認し、差分を修復する。通知・メールを手動再送してはいけない。
- active後の障害: 専用表が正。旧releaseへの書込rollback、stateをcopyingへ戻す、旧表からの上書きは禁止。
  対応releaseを修正して再デプロイする。どうしても逆移行が必要なら、受付・送信を止め、専用表の全変更を含めた
  別の逆移行migrationと全列照合をレビューする。DB全体をTime Travelで戻すと他Projectも巻き戻る。
- Adapter障害: Reportは未判定のまま。同じoperation IDと署名で再試行する。Coreのリースは2分後に回復する。
  Adapterはoperation IDに対して同じ公開revisionを返す必要がある。成功レスポンス消失時も削除を重複実行しない。
  遅いrevisionは新しい判定を上書きしない。`actioned`は指示公開であり、端末での削除確認を意味しない。
- R2: 旧キーは移動しない。Report証跡は元のcreated_atから30日で期限切れ。Support添付と原文mailは各保持手順に従う。

## 新Project・将来のschema変更

Projectのseed/設定 → prefix登録計画 → prepare → copy/verify（空でも実施）→ cutover → Binding props登録 → preview確認。
1 Projectにつき17業務表とindex/triggerが増えるが、SQL・Repository・Workerのコピーは増やさない。
返信署名・通知先・Adapterは引き続きデプロイ設定とseedで指定する。

今後のschema変更では旧表だけをALTERしない。全active prefixへのforward migrationとgeneratorのschema versionを
同じreleaseで更新し、全prefixで照合する。対応しないschema versionは実行時に拒否する。
複数Project一覧はSQL生成のread-only UNIONであり、D1のcompound SELECT制限を避けるため小さな群に分ける。
SQLサイズが95KBを超える集約は拒否するので、運用画面のbinding scopeを小さくする。

D1は共有の障害・バックアップ・復旧単位。テーブル分離で物理DB単位の可用性分離は得られない。
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/) に従い、クエリ時間、100KBのSQL、
bind数、Worker当たりのクエリ数、DB容量を監視する。既存indexも専用表へ複製される。

## Project単位の論理バックアップ・抽出

`storage tables <slug> <prefix>` の固定一覧が抽出対象。テーブル全体を個別exportするため、本文取得をproject_idの
WHEREだけに依存しない。対応する `apps/services/app_links/app_mail_settings/reply_templates` と、番号予約、
ProjectのID予約・監査ログ・配送ジョブのメタデータ、添付のr2_keyとsha256のmanifestも別に抽出する。
共有設定の他Projectの値は含めない。整合した抽出には対象Projectの書込・ジョブを停止するか、同一bookmarkから
復元した検証DBで抽出する。復旧時は別のpreviewでFK・全列・キー/sha256を検証してから、専用の復旧migrationを作る。
R2のオブジェクトはmanifestに含むキーだけを複製し、元のオブジェクトを移動・削除しない。
