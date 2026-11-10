# アイデンティティチャネル配線（#5825）

クロスクライアント「安定会話 + メッセージ ID」配線のための 1 ページ：アイデンティティを誰が bili に運び、どこで消費され、すべての新規レーンが何をしなければならないか。設計法（オーナー裁定 2026-11-07）：**すべてのクライアントレーンは 1 つの統一消費シームに配線する——利用箇所は決して自分でクライアントストレージを読まない。** AGENTS.md KDD #18 が規範的記述；このページはそのマップ。姉妹ページ（*判定*側——ID が到着した後 bili が何を決めるか）：`docs/session-identity-resolution.md`。

## 1. シーム

リクエスト毎、1 か所（`src/server/handle.ts`、会話アイデンティティ解決の後、resolve の前）でアイデンティティレジストリがスナップショットされる：

```
stamped inbound ids (body fields / turn envelope)   ──▶  same consumer path ◀── harvested ids
                                                             (msgid-pin validation →
                                                              #5719 attribution rung →
                                                              pin/row pipeline on
                                                              anthropic wire)
```

- **スタンプレーン**（dsh など）：ホストが正規 ID（`acp_summary_*`）を発行し、ボディフィールドや `/__bili/plugin/turn` エンベロープにスタンプ；送出前にプロトコル剥離。
- **スタンプヘッダレーン**（opencode V2）：拡張の http-request フックが*このターン自身の*構造化メッセージを読む（競争なし）で、その送信リクエストヘッダーに `x-bili-msg-ids` を設定；証明できない ID を持つ任意の変種はリスト*全体*を汚染する。Handle はボディフィールド > ヘッダー > ハーベストの優先順で消費；両 prepare は送出前に内部フィールドを無条件剥離。
- **ハーベストレーン**（本配線）：ローカルストアに安定メッセージ毎 ID を持つクライアントからのループバックリクエストは自己完結アダプタを通じて一致させられる；判定不能なものは*ターン全体*を配線前パスに劣化させる——部分的マッピングも、静かな再キー付けも絶対にしない。

ハーベストゲート（リクエスト毎すべて成立必須）：(env `BILI_IDENTITY_HARVEST` が空でない（`all` またはカンマ区切りソースリスト）または rollout `identityChannelHarvest` ON —— いずれかの有効化子が十分、両者既定 OFF、無関係な `pluginLaneServerHistory` のオーバーライダー）× リクエストソースアドレスループバックのみ × アダプタ結合キー一致。許可された ID の行ピンニング（openai-parity ステップ以降は両ワイヤで追加で）は引き続き `pluginLaneServerHistory` でゲートされる；帰属階段証拠には不要。許可された ID は*両ワイヤ*でフルパイプラインに乗る：#5719 帰属階段、および——`pluginLaneServerHistory` が ON の間——ピン/ストレージ行リンク（`prepare-anthropic` + `prepare-openai`、ウォーターマーク高速パスターンは除外：ヒットビューは短いウィンドウであり、構造的に不一致になる）。

## 2. レーントーブル（#5825 クライアント毎調査から）

| クライアント | セッションキー | メッセージ ID | アダプタ | ステータス |
|---|---|---|---|---|
| claude-code | `x-claude-code-session-id`（+transcript ファイル名） | transcript `.jsonl` 行の `uuid`；sidechain + summary 行は除外 | `src/identity-claude.ts` | 配線済み（anthropic ワイヤ：行ピンニング含むフルパス） |
| codebuddy | `x-conversation-id`（= transcript ファイル名、再起動安定、計測 2.181.0） | JSONL 行の `id`+`parentId`；system/draft 行は除外 | `src/identity-codebuddy.ts` | 配線済み（openai ワイヤ：帰属階段）；認識は `conversationHeaderSource` 低信頼ティアに統合 |
| mcode / mavis | `x-mavis-session-id`（`mvs_…`、既に認識済み #1050） | runtime-state.sqlite `local_runtime_message_rows.msg_id` | `src/identity-mcode.ts` | 配線済み（sqlite 例示；ターン毎読み取りプローブ、open→query→close） |
| goose | `agent-session-id`（= sqlite sessions.id、再起動安定；BYOK/カスタムプロバイダパス含む；ユーザー上書き名はこのレーンのみ劣化） | sessions.db `messages.message_id`（`msg_<uuidv4>`、再利用なし）；ORDER BY created_timestamp,id；圧縮は再親付け ⇒ 圧縮後ターンはターン全体劣化、次のターンに自己修復 | `src/identity-goose.ts` | 配線済み |
| qwen-code | ユーザー customHeaders `${session_id}` 経由の `x-opencode-session`（公式 BYOK ドキュメントの例名 = bili が既に認識するもの 1 つ；他の選択名は認識されるまで劣化） | `<QWEN_HOME>\|~/.qwen/projects/<cwd>/chats/<sid>.jsonl` git-log 行の `uuid`；sidechain ファイル + 圧縮チェックポイント + rewind 記録はターン全体を安全に劣化 | `src/identity-qwen.ts` | 配線済み（結合はユーザーオプトイン——ステータス注記参照） |
| opencode V1 | `x-opencode-session-id` | `opencode-msgids` ハーベスト（既存） | 不変 | 稼働中 |
| opencode V2 | `x-bili-msg-ids`（自身のフックがこのターンの構造化メッセージから全モデルリクエストで設定） | 同じイベント読み取り——ゼロ捕捉競争；union 変種の ID オプション性 ⇒ *欠落 ID はスタンプ全体を落とす* | `src/agent/opencode-v2-msgids.ts`（+ handle 消費、両ワイヤ strip+pin） | 配線済み（スタンプヘッダレーン） |
| crush | 結合キーはセッション UUID とストアの XXH3 16進ダイジェスト（プロジェクトローカル、プロキシはクライアント cwd を列挙できない） | sqlite uuid PK が安定と証明済み | — | クローズメモ：アダプト前にクライアント側 xxh3 結合値または文書化された data-dir 規約が必要 |
| gemini-cli | 最も近いアイデンティティはインストールレベル（`installationId`、セッション毎ではなくマシン毎；テレメトリー切替依存） | transcript uuid は存在するがセッション毎安定ワイヤキーがない | — | セッション毎ワイヤキーが存在するまでクローズメモ |
| hermes-agent | ワイヤアイデンティティ信号が全くない（ブランディングヘッダーのみ）、強力な sqlite スキーマにもかかわらず | id AUTOINCREMENT + active/compacted 列 | — | クローズメモ：クライアント変更なしでは結合対象がない |
| iflow | ワイヤ可能セッションヘッダー + claude 風 JSONL を持っていた | ダブル ID 空間の曖昧性（ワイヤ getSessionId vs `session-<hash>` ファイル名） | — | クローズメモ：製品終了（repo README 閉鎖通知；npm 最終リリース）——表面の価値なし |
| antigravity / qoder / copilot | クライアント毎キー（antigravity はワイヤ上にない） | transcript レイアウトは部分的に証明済み（#5825 スレッド） | — | アダプト前にログイン済み計測ラン 1 回が必要 |
| zcode | `x-zcode-*` 帰属セット（今日は memory aux レーン用に認識） | 証明されたメッセージ毎ワイヤ半分はまだない | — | アダプト前にログイン済み計測ラン 1 回が必要 |
| grok-shell / kiro | 認識済み | モデルワイヤ上に使えるメッセージ毎エンティティなし（ソース証明） | n/a | セッション半分のみ——クローズノート付きでクローズ |
| aider / jcode / kimi | 安定のものなし | 使えるものなし | n/a | コンテンツハッシュフォールバックこそ最適解——クローズ |
| codex | セッション既知 | item.id はプロバイダネームスペース；自己発行 ID は本番で 2 度拒否（#242/#1474） | n/a | #5643 裁定待ちで保留 |
| trae / amp | — | — | n/a | ブロック：外部から成果物を取得できない |

## 3. 信頼境界

- ハーベストされた ID は**サーバー派生証拠**であり、許可されるとスタンプ ID と同等信頼（同じ正規バリデータ、同じ階段セマンティクス）——同じクライアント（リクエストを送ったもの自身）の*ローカル*ファイル/sqlite から来て、ループバック*のみ*だから。リモートソースのリクエストは決してハーベストできない。
- 各アダプタは自分のスナップショット内で自分のレイアウト前提を検証する；共有規律はコアにある（`expectedLen` 対の行数対称、両側がロールを公開する場所での境界ロールスポットチェック最大 4 位置、正規 msgid 検証、ソース毎 warn-once 劣化）。
- 消費者はクライアント非依存のまま：シームより下流でクライアント名を言及するものはない。

## 4. 変更チェックリスト

新規ハーベストレーン：`src/identity-<client>.ts` を追加（自己完結；node builtins のみ）→ `src/identity-sources.ts` に登録 → `tests/identity-harvest.test.ts` にフィクスチャテストを追加 → 上記 §2 に 1 行 + AGENTS.md ステータスを追加。禁止事項：レジストリ以外の場所でクライアントストレージを読むこと、ゲートをバイパスすること、判定不能ターンで 1 つのレーンが部分的マッピングを持ち越すことを許すこと。
