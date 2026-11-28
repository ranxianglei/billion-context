# モジュール: 統合ストレージ (`src/persist.ts` + `src/storage/`)

> [アーキテクチャハブ](../architecture.ja.md) の一部 · 中国語版: [storage.zh-CN.md](./storage.zh-CN.md) · 2026-11-08 時点、master、スキーマ v11

![統合ストレージモジュール](./assets/storage.en.svg)
(ビットマップフォールバック: [storage.en.png](./assets/storage.en.png))

## 責務

プロセス再起動後も保持されなければならないすべてのデータは、単一の SQLite ファイルに格納される: セッション、メッセージ行、コンテンツ、圧縮ブロックとその参照台帳、チェックポイント、通知ストアとセッション拡張で使用される `kv_store`、およびメディアである。`src/persist.ts` はレガシーなセッションファイルのファサード（StateStore ラッパー、EPERM アラート層）であり、`src/storage/` は統合された行レベルのストアである。

## 原則

- **単一の WAL ライター。** 単一の SQLite ファイル、単一の書き込みパス（バッチ処理された `ingest.ts`）により、リーダーがライターと競合することがない。
- **正規 ID、ホスト ID ではない。** `messages.msgId` には bili/kernel の正規 ID（`identityOfStoredContent`）が保存される。ホストの要素ごとの msgid は進行中のエンベロープフィールド。`l1_world` はその予定先だったが決済済みとして**劣化プレースホルダ**になった（#7617）：egress-on セッションは ID を op log に置き l1 行を要さない。テーブルの退役ゲートは [deprecations.md](../deprecations.md) 参照。
- **安定した絶対 seq (#421 修正)。** 行の順序はメッセージアイデンティティの主要な担い手である。フォールディングは行を非アクティブにマークするだけで、物理的に削除することはない（GC はカバーブロックのライフサイクルに基づいてパージする）。
- **追加的なマイグレーションのみ。** スキーマバージョンは前方に進む。古い DB は `CREATE IF NOT EXISTS` 経由で移行される — 破壊的なマイグレーションには、まずロールバックドリルが必要である（T1 規律、#5643 テストマトリクス）。

## 動作原理

**書き込み側。** インジェストパスは統合ビューをバッチ書き込みする（安定した絶対 seq; `identityOfStoredContent` によるコンテンツハッシュ ID; バウンダリフレーム `boundaryMsgId` はバッチとともに格納される）。`persist.ts` はセッションファイルの保存/読み込みと EPERM アラート層を処理する。カーネルは、カーネルが提供する StateStore インターフェースを通じて圧縮状態（ブロック / 参照 / dead_refs / チェックポイント）を書き込む — ホストは実装を差し替える。

**kstate JSON は並列の第二の真実の源である（ペインポイント 1）。** 残存する `CompressionState` フィールドリストは `mergeState()` によってシリアライズされる（フィールドリストの単一の源 — `src/state-hydration.ts`）であり、テーブルとともに読み書きされる — 二重チャネルである。**egress-on の carve-out（#7581）：**導出可能な 3 フィールド（`tsStamps`、`tokenSnapshot`、`lastPassIds`）は保存時に `kstate_json` からトリムされる — kstate 残差は明示的な残留フィールドリスト。legacy セッションはバイト等価のまま。カーネル状態のテーブル統合はフォローアップ作業（#6858 が #6785 のスコープ外と明記）；#5874 v2 の基盤（content CAS、messages × blocks × refs、l1_world プレースホルダ — 劣化済み、上参照 — と eg_state/eg_flow op log — fold_journal/egress_snapshot はマージ前に退役済み、7439 裁定）がその収束の着地点である。

**読み込み側。** ハイドレーションは、残存フィールドの単一の源として `mergeState()` を使用する（テーブル + kstate が組み立てられる）。エグレスはフォールディングカバレッジチェックとサーバーサイドの正規レンダリングを実行する（D レーン、#3756 — どのデシンクもレガシーパスにフォールバックし、デグレードしても推測しない）。課金とキャッシュ台帳（`cache-ledger`、`store.ts` 内の CCR 取得）および表示/エクスポートサーフェス（`sessions-data`、`acp_status`、`export` — 誠実な出力、#155）はすべて同じ行を読み取る。メンテナンスは `state-gc` / `storage-maintenance` / オルファン GC（`sessions.gc_*` でのストレージ GC、オプトイン、dead-ref の回収）である。

**整合性。** チェックポイントフレーム署名 + S4 行ごとのチェックサム; 判定はチェーンを信頼し、コンテンツの類似性を決して信頼しない。任意の静止時エンコーディング: AES-256-GCM (#708) + zstd (#1080)。`src/storage/mysql.ts` 配下の mysql ダイアレクトはテストミラーのみである（mysql-contract CI レーン） — SQLite が本番ストレージであり続ける。

**egress プレーン（KDD #23/#24、#7439/#7577/#7591/#7773 — 出向会話 op log）。** `eg_flow`（SQLite レーンのみ、ゲート `rollout.features.egressPlane`）は各セッションの出向ビューの **append-only** I/D/U op log を保持し、行は自己完結（バイトは行に乗る、content CAS 不要）。flow のキーは `(session_id, op_seq)`（稠密な行カーソル、復旧/切り詰め鍵）、I 行はさらに `log_seq`（正規メッセージ番号、再発行なし）を持つ；フロンティアは flow 上の `MAX(log_seq)`（退役した `B` ベース行の `highWater` payload は消滅、#7773）。**`eg_state` は物化ライブビュー**（#7773）：PK `(session_id, rid)`、`pos` 順；各 append は同一トランザクション内で op を行に適用（I 挿入＋シフト、U その場更新、D 物理削除＋シフト）、サービスコピーは構造上ライブビューの大きさに有界 — ベース行も圧縮も op ミラーもない。ログと state キーの行アドレスは再発行されない稠密な `rid` で、msgid ではない（owner 裁定 2026-11-27、#7773 続行：msgid はカーネル同一性 — content-hash 代理・衝突可能・折りたたみ後にどの発生を指すか曖昧 — 、rid は自発行。D 端点 / U 目標 / I アンカーは全て rid を参照し、`idx_eg_state_msgid` が msgid 検索に供される）。egress-on セッションでは op log が**唯一の**正規メッセージ権威：出向バイトはそこから配信、pin チャネルは messages レジャーではなく物化 state を読む、ターンごとの統一 ingest は停止（messages は**遅延射影**に格下げ、ロールバック/web 読み取り/復元時に一括再構築）、セッション JSON エンベロープは bootstrap で凍結。復旧：state コピーが損傷したら**全履歴リプレイで再構築**しそのまま配信（flow が権威）；flow 自体がリプレイ不能なら `recoverEgressBase` が全履歴 walk を 1 度だけ実行（`egressFlowWalkBack`）— 最新健全プレフィックスまで尾を切り詰め；健全な点が皆無 ⇒ ターンはハード失敗（裁定 7439-5）で、クライアントバイトに劣化することはない。裁定 7439-2 は読み書き側を blocks テーブル本体に置く：`summary_bytes` がブロック要約をインライン化（読取り側はこれを優先、content CAS は legacy フォールバックのみ）、`start_msgid`/`end_msgid` は折りたたみ時にフローの msgid 座標へ一度だけ整列 — フロー記録セッションのみ、他は NULL。**#7581 がブロックライフサイクルログ**（`eg_block_flow`/`eg_block_state`）**を二重クロックで追加** — ブロックテーブルは自分自身を番号付けし、各行は `flow_op_seq` でフロークロックを指す；reap はそのブロックの最終スナップショットを携えた `D` 行で、state 行は物理削除（#7773）；フロークローク W の定点 fork：フロー行 `op_seq <= W`・ブロック行 `flow_op_seq <= W` をコピーし、**両 state テーブルを W までリプレイして物化**（任意のポイント可 — 「最新ベース未満」ゲートは廃止）；egress-on の checkpoint はこの定点 fork に退役。**#7617 は ID を統合**：egress-on の stage-0 は状態なし（`MAX(op_seq)`/flow の `MAX(log_seq)` からの境界、l1 カーソルも resync もない）、R3 故障 latch は `sessions.r3_latched_at`（legacy l1 列との二重キャリアで読替/クリア）、egress-on セッションは年齢 GC から除外され手動 archive は拒否（アーカイブ形式が op log を載せるまで）。**番号付け（2026-11-25、[egress-plane.md](../egress-plane.md) §10）**：`log_seq` がカーネル引用番号そのもの（`mNNNNN` = m + log_seq、system 行 = 0）；arm 時の一括 backfill で op log が完全履歴になり、`refs` 書き込み経路は egress-on で退役、kstate overlay の refs 再構築が正当経路に。**構造不変条件（#7773 §6、毎回の書き込み後にアサート、両プレーン）**：flow 行数は減少しない・state 行数 == ライブビュー長さ・最大 value == 歴史上の最大単一行・行文字列はちょうど I/D/U（メッセージ）/ I/U/D（ブロック）— スイート `tests/egress-invariants-7773.test.ts`。全体：[PR #6785 ドキュメント §6](../pr-6785-unified-storage-and-flows.md#6-round-2) ・ブロック：[egress-block-flow.md](../egress-block-flow.md) ・一箇所：[egress-plane.md](../egress-plane.md)。

## 厳格な不変条件（これに触れる前に AGENTS.md を参照すること）

- メッセージ ID は決して再利用されない（カーネル契約）; `messages.msgId` は正規 ID である。
- 行の順序 = アイデンティティの担い手; フォールディング = 非アクティブマーク、物理削除ではない。
- アップグレードは純粋に追加的である; 破壊的な変更の前にロールバックドリルを行う。

## 主要なエントリ

`src/storage/schema.ts`（単一の DDL 真実の源） · `src/storage/store.ts`（行の読み書き） · `src/storage/ingest.ts`（バッチエントリ） · `src/persist.ts`（StateStore ラッパー） · `src/state-hydration.ts`（残存フィールドリスト）

## 関連

[message-identity](../message-identity.md) · [session-identity](../session-identity.md) · [egress-plane.md](../egress-plane.md) · [deprecations.md](../deprecations.md) · [#5643 進化提案 (PR #5873)](https://github.com/ranxianglei/billion-context/issues/5643)
