# billion-context 設定リファレンス

[English](configuration.md) | [中文](configuration.zh-CN.md) | [日本語](configuration.ja.md)

`billion-context` は、LLM API ストリームに [ACP](https://github.com/ranxianglei/acp-kernel)（Active Context Pruning）コンテキスト圧縮を注入する HTTP プロキシです。以下のすべてのオプションは、単一の JSON 設定ファイル（または同等の環境変数 / CLI フラグ）内に定義されます。

---

## 設定ファイルの場所

| スコープ | パス | 備考 |
|-------|------|-------|
| **設定ファイル (Linux)** | `~/.config/billion-context/billion-context.json` | XDG Base Directory — 正規の、ユーザーが編集可能な設定 |
| **設定ファイル (オーバーライド)** | `XDG_CONFIG_HOME` の値 | 設定ディレクトリ全体を再配置します |
| **設定ファイル (明示指定)** | `BILI_CONFIG_FILE` の値 | 任意の JSON ファイルを直接指します |
| **CLI フラグ** | `--config <FILE>` | `BILI_CONFIG_FILE` と同じ; ファイルパスに対して最優先 |
| **セッションデータ** | `~/.local/share/billion-context/sessions/` | 永続化された圧縮状態、時間とともに増加します |

初回実行時、`billion-context` は設定パスに空のテンプレート (`{ "providers": {} }`) をシードし、編集対象を用意します。既存のファイルを上書きすることはありません。

設定ファイルは純粋なオーバーライドレイヤーであり、すべてのフィールドは任意です。未設定の項目は組み込みのデフォルト値にフォールバックします。

---

## クイックスタート

```jsonc
// ~/.config/billion-context/billion-context.json
{
  // Server
  "port": 8787,
  "host": "127.0.0.1",

  // Route two providers
  "providers": {
    "https://api.anthropic.com": {
      "models": {
        "claude-sonnet-4-5": { "context": 200000, "output": 8192 }
      }
    },
    "https://generativelanguage.googleapis.com": {
      "models": {
        "gemini-2.5-pro": { "context": 1000000 }
      }
    }
  },

  // Global compression tuning (applies to every request)
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%"
  }
}
```

---

## パラメータリファレンス

ステータス凡例: **ACTIVE** = 現在使用中 | **DEPRECATED** = 受け入れられるが効果なし | **EXPERIMENTAL** = 変更される可能性あり
<!-- bili:gen param-ref -->
以下インデックスは `website/config-reference/*.yaml` から生成 — シードを編集してから `node tools/gen-config-docs.mjs generate` を実行；このブロックを手で編集しないこと。

**サーバー & コア**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `port` | number | 8787 | ACP_PORT, PORT | プロキシがリッスンするTCPポート（ユーザーゾーン；レーンスポーンされたプロキシは `BILI_ZONE_PORT` を使用）。 |
| `host` | string | 127.0.0.1 | ACP_HOST | バインドアドレス。127.0.0.1 = ループバック専用；:: = デュアルスタック；0.0.0.0 は外部に公開（認証なし — 信頼できるネットワークのみ）。 |
| `sessionHeader` | string | x-acp-session | ACP_SESSION_HEADER | 会話IDを保持するHTTPヘッダー；同じ値は圧縮状態を共有する。 |
| `log` | boolean | true | ACP_LOG | リクエストごとのログ記録マスタースイッチ。 |
| `logFile` | string | XDG state path (off disables the file, keeps stderr) | ACP_LOG_FILE | `bili.log` の明示的なパス；10 MB で自動ローテーション。 |
| `debug` | boolean | false | ACP_DEBUG | 詳細なリクエストごとのログ記録。 |
| `dumpSse` | string | unset (directory) | ACP_DUMP_SSE | デバッグ用に生SSEフレームをダンプするディレクトリ、ループ起源のレスポンスを含む。 |
| `passthrough` | boolean | false | ACP_PASSTHROUGH | グローバルな生リレースイッチ：圧縮、ツール注入、ナッジなしですべてのリクエストを転送する。 |

**アップストリーム & 課金**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `upstream` | string | https://api.anthropic.com | ACP_UPSTREAM | リクエストがどのプロバイダルートにも一致しない場合のフォールバック用アップストリームベースURL。 |
| `proxy` | string | unset (direct) | BILI_UPSTREAM_PROXY | プロキシ自身のエグレス（外部送信）用のグローバルアウトバウンドプロキシ。解決順序: ルート別 → BILI_UPSTREAM_PROXY → Web UI → この値 → HTTP(S)_PROXY → Windows システムプロキシ → 直接接続。空文字列は明示的な直接接続を意味し、SOCKS5 は拒否される。 |
| `upstreamProxy` | string | unset | — | Web-UI 手動プロキシ階層（ダッシュボードのプロキシエディタによって書き込まれる）。解決順序では BILI_UPSTREAM_PROXY より下位にある。 |
| `upstreamProxyMode` | "auto" \| "manual" \| "direct" | auto (unset behaves as direct) | BILI_UPSTREAM_PROXY_MODE | グローバルプロキシの取得方法: auto（環境変数/システム検出）、manual（Web-UI の値のみ）、direct（プロキシを一切使用しない）。 |
| `providers` | record url-prefix → route entry | {} | — | ルートテーブル: URLプレフィックスキーをプロバイダ別エントリ（モデル、compress、compat など）にマッピングする。Providers セクションを参照。 |
| `modelEndpointPatterns` | array of { match: string, wire: "anthropic" \| "openai" \| "responses" \| "google" \| "commandcode" } | [] | — | 宣言可能なカスタムワイヤモデルエンドポイント: ワイヤファミリにマッピングされる絶対URLプレフィックス。1つの設定ソースがプロキシのプロトコル分類器とクライアントサイドのフェッチクレームの両方に供給されるため、2つのゲートが乖離しなくなった（#1295）。 |
| `modelContextLimit` | number | 200000 | ACP_MODEL_CONTEXT_LIMIT | レガシーのグローバル DEFAULT ウィンドウ（ウィンドウラダーにおける最終手段のフォールバック: モデルの制限がティア証拠、プラグイン/ランチャーレポート、ルート別宣言、レジストリ検索、組み込みテーブルのいずれからも解決されない場合にのみ参照される。また、勝った場合の使用率の分母としても機能する）。compress.modelContextLimit を優先すること。 |
| `imageBilling` | "auto" \| "pixels" \| "bytes" | auto (resolves to pixels) | BILI_IMAGE_BILLING | グローバルなイメージトークン推定基準。リクエストごとにライブ読み取りされ、すべてのプロバイダ別設定を上回る。 |
| `imageTokenCap` | number | unset (uncapped) | BILI_IMAGE_TOKEN_CAP | 解決された課金モードの上に適用されるグローバルな1画像あたりのトークン上限。リクエストごとにライブ読み取りされる。 |
| `imageRescale` | boolean | true | BILI_IMAGE_RESCALE | エグレス画像のダウンスケールマスタースイッチ（#3295/#3400）: 大きなアウトバウンド画像は縮小して送信され、セッションストレージ内のオリジナルは変更されない。リクエストごとにライブ読み取りされる。 |
| `egressTransforms` | array | unset (none) | — | ユーザー登録可能なエグレスリクエストボディ書き換えパイプライン（#6003）: すべてのセッション処理の後、トランスポート（再署名 / v1Wrap / fetch）の前に、すべてのアウトバウンドモデルリクエストボディを書き換える ESM プラグイン。フェイルオープン、POST /__bili/config/reload によるホットリロード可能。 |
| `billing` | object | {} | — | モデルごとの課金価格（#4899）: billing.prices[model] = { input, output?, cacheRead?, cacheWrite? } は100万トークンあたりの USD 単位。パネルの USD 支出台帳と保存済みドル推定値において、models.dev スナップショットを上書きする。価格未設定のモデルはトークン数のみ表示される。 |

**挙動トグル**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `rollout` | object | {} | — | 機能ロールアウト（カナリア）ブロック：バージョンに組み込まれたロールアウト計画の機能ごとのオーバーライド；機能はインストール数のパーセンテージでロールアウトされ、安定したマシンごとの ID でバケット化されます。 |
| `rollout.installId` | string | auto-generated UUID persisted at ~/.local/state/billion-context/rollout-id.json | — | 自動生成された state-dir UUID の代わりにバケット化アイデンティティをピン留め（サポート/テスト：コホート内にバケットが収まる ID を選択または計算）。 |
| `rollout.features` | record feature name → { enabled?, percent?, salt?, base? } \| boolean \| number | {} | — | 実行中バージョンが rollout 下で持つ機能名をキーとする機能ごとのオーバーライド。enabled (boolean) はパーセンテージを無視して上書き；percent (0–100) はコホートを再スケーリング；salt は再ランダム化；base はネストのスコープを再定義。ショートハンド："x": true/false でオン/オフを強制、"x": 20 で percent を設定。型が誤ったフィールド（例：enabled が文字列）は無視され、起動時の警告で名前が示されます — コホートのサイレントな拡大は決して行われません。 |
| `rollout.features.enabled` | boolean | unset (bucket math decides) | BILI_ROLLOUT_<FEATURE> | パーセンテージに関係なく、ゲート付き機能を強制的にオン/オフにする。環境変数 `BILI_ROLLOUT_<FEATURE>`（大文字スネークケースの機能名; 0/false = オフ、それ以外の値 = オン）が、このフィールドを含むすべての設定を上書きする。 |
| `rollout.features.percent` | number | the version's baked-in plan | — | 機能を確認できるインストールの割合（0–100、小数可）。単調増加性を持つ：パーセンテージを上げても、すでに有効化されたインストールが失効することはない。バケットはインストールごとにプレフィックス安定である。 |
| `rollout.features.salt` | string | the feature name | — | バケット分割用のハッシュソルト。変更するとコホート全体が再ランダム化される（シャッフルする唯一の方法；パーセンテージを上げるだけではシャッフルされない）。 |
| `rollout.features.base` | string | unset (roll out over everyone) | — | ネストされたロールアウト：指定された機能の有効化コホート内でのみこの機能を評価し、パーセンテージがその母集団に対する相対値となる（Aのユーザーに対してBをロールアウト；チェーンは許可、サイクルはクローズドに失敗する）。 |
| `rollout.features.identityChannelHarvest` | boolean \| number | 0 (off) | BILI_ROLLOUT_IDENTITY_CHANNEL_HARVEST | IDチャネル収穫コホートゲート (#5825)：インストールごとの環境スイッチなしで、ループバック専用のトランスクリプト/sqlite収穫（`src/identity-harvest.ts`: claude-code / codebuddy / mcode / goose / qwen レーン）を許可する。インストールごとのスイッチ（`BILI_IDENTITY_HARVEST`）もこのキーも設定されていない場合、クライアントストレージは一切読み取られない。オーナー裁定 2026-11-07：このコホートキーは `rollout.features.pluginLaneServerHistory`（承認済みIDの行固定を管理）とは意図的に分離されている — いずれかのイネーブラーが収穫を有効化できる。デフォルト 0%；小規模コホートでの degrade warn-once レートの観察後に引き上げる。`identity-channels.md` を参照。 |
| `rollout.features.pluginLaneServerHistory` | boolean \| number | 0 (off) | BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY | プラグインレーンのサーバー所有履歴 (#4491)：有効化されたインストールにおいて、(a) プラグインレーンのリクエストは `messages` と並行して内部 `biliMsgIds` 配列を持ち、メッセージIDをクライアント提供のIDに固定できる（上流転送前に常に除去；不正な配列は警告付きで無視、ID汚染形状は増分レーンでハードフェイル）；(b) ループバック専用の `POST /__bili/plugin/render` エンドポイントは、統合トランスクリプトからレンダリングされた送信プレフィックスを提供する（折り畳み領域はサマリアンカーに縮小；デシンクは非2xxにデグレードし、シムはローカル履歴にフォールバック）；(c) 増分レーンのプローブは `serverHistory` をアドバタイズする。デフォルト 0% — ロールアウトされるまで挙動は変わらない。 |
| `rollout.features.pluginFullResendWatermark` | boolean \| number | 5 (experimental grey) | BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK | フルリセンドウォーターマークファストパス (#5403/#5418)：前回のレスポンスに `x-bili-pf-seq` ス tamp を持っていたプラグインレーンのチャットコンプリートターンでは、エコーされたカウントにより再送信プレフィックスをアサートする（構造スキャン、フルパースなし）；ヒット時にパイプラインはスタッシュされた正規プレフィックスコアと新しいテールウィンドウのみを消費する（バイト同一の送信プロベナンス；疑義がある場合はターンごとに未変更のフルパースパスにフォールバックし再スタンプ、5回のクレジットミスでレーンを1時間保持）。クライアントがスタンプを `x-bili-pf-count` としてエコーバックすることを要求（dsh/pi/opencode/omp は対応；未適応レーンはヒットしない）。実験的グレースケールロールアウト — インストールの約5%でデフォルトON（オーナー裁定 2026-11-02：GA前に小規模コホート；Web UIで全インストールに一度限りの導入通知、クイック設定に3状態スイッチ）。`true` で強制、`false`（またはパーセンテージ）/ 環境変数 = 0 でオフ。`technical-notes.md` の「Full-resend watermark fastpath」を参照。 |
| `maskHosts` | boolean | true | BILI_LOG_MASK_HOSTS | ログ内の非公開ターゲットホストを <private-host> としてマスクする。認証情報ヘッダーは常にマスクされる。 |
| `security.adminRelay` | boolean | false | — | エンベディングホスト（現在は dsh web）が、リモートブラウザからパネルを開けるように（#3373）、その自身のエントリーオリジンを通じて /__bili/ 管理サーフェス全体をリレーすることを許可する。フェイルクローズ、ファイルのみ。リレーされたホップはローカル非ブラウザクライアントとしてプロキシに到達する（ループバックソース + ループバック Host、Origin なし）ため、管理ゲートは変更されない。これを有効にすると、ホスト Web エントリーに到達できる者に設定編集と認証情報の書き込みが露出する — まずそのエントリー（認証 / リバースプロキシ）を保護すること。 |
| `subagentSplit` | boolean | true | BILI_SUBAGENT_SPLIT | Claude Code サブエージェントは、メインセッションのキューに並ぶ代わりに、独自のセッション名前空間（<session>\|sub:<agent-id>）を取得します。Anthropic-wire 専用 — Responses wire ではこのスイッチは no-op です（`subagentSplit` / BOTH-mechanisms スコープ注記を参照）。 |
| `personaSplit` | boolean | true | BILI_PERSONA_SPLIT | 指示テキストが変更され、かつ受信履歴が追跡中のチェーンを継続していない場合、指示フィンガープリントでキー付けされた Responses-wire レーンを分割します（Claude Code の /v1/responses 経由; Codex ルートスレッド / 旧ビルド）。デフォルトで有効。環境変数 BILI_PERSONA_SPLIT=0 または personaSplit: false で無効化可能（環境変数が優先）。 |
| `forkAdoption` | boolean | false | BILI_FORK_ADOPTION | 匿名フォークは、フォークされたリクエストにソースコンテンツが完全に存在する親の圧縮ブロックを継承します。 |
| `autoModeForge.enabled` | boolean | true | BILI_AUTO_MODE_FORGE | Claude Code の自動モードのセーフティ分類器呼び出しを、上流へ転送する代わりに、偽造された許可判定でローカルに回答します（#2740）：そのレーンでは送信ゼロ、課金ゼロ。すべての偽造判定は監査ログに記録され、セッションには通知バッジが付与されます。false / 環境変数 0 で、実際の判定料金を支払うユーザー向けに純粋なパススルーに戻ります。 |
| `affinitySimhash` | boolean | true | BILI_AFFINITY_SIMHASH | 匿名クライアント向けの Simhash チェーン整合性採用（#2265）：クライアント側の普遍的な装飾的書き換え（例：Trae がすべてのアシスタントメッセージにモデルタグを再スタンプする）が発生した場合、ゼロから新規発行して再折りたたむ代わりに、既存のセッションとその圧縮状態を再アタッチします。 |
| `resumeInheritance` | boolean | true | BILI_RESUME_INHERITANCE | 新しいセッション ID で再開する識別済みクライアントは、親の ref 割り当てと完全に存在する圧縮ブロックを継承します。 |
| `chainContentDetection` | boolean | false | BILI_CHAIN_CONTENT | bili→bili チェーンのボディコンテンツ検出（オフ：ボディスキャンは CCR/モデルエコーテキストで誤検出する可能性がある）；デフォルトでは x-bili-hop のみでチェーン認識を駆動します。 |
| `chainEgressStamp` | boolean | false | BILI_CHAIN_STAMP | 送信時にモデル可視の <bili-chain/> チェックポイントキャリアを発行します（オフ：モデルはこれを幻覚入力として扱い、トークンを消費します）。 |
| `stableSystemAnchor` | boolean | false | BILI_STABLE_SYSTEM_ANCHOR | ベストエフォートのワイヤーレイヤープレフィックスキャッシュアンカー：クライアントが変更した場合でも、最初に確認されたヘッドシステムバイトを再送信します（プレーンプロキシレーンのみ）。 |
| `compat` | { roles?, dropFields?, streamErrorShape?, noCacheControl?, keepResponseId? } | {} (disabled) | — | グローバルワイヤー互換性ブロック：ロールリマップ、厳格スキーマフィールドの削除、ストリームエラー形状、cache-control 処理。 |
| `compat.roles` | record role → role | {} | — | メッセージロールを上流が受け入れる名前にマッピングします（例：developer→system）；完全一致ロールのみ、プロバイダーごとのエントリがキーごとに優先されます。 |
| `compat.dropFields` | string[] (dot paths) | [] | — | 未知のフィールドで 400 を返す厳格スキーマゲートウェイ向けに、転送されるすべてのボディからドットパスフィールドを削除します；グローバル + プロバイダーごとのリストは加算的に統合されます。 |
| `compat.streamErrorShape` | "protocol" \| "completion" | protocol | BILI_STREAM_ERROR_SHAPE | 200 がコミットされた後、上流ストリーム失敗がどのように提示されるか：プロトコルネイティブのエラーフレーム（デフォルト）またはレガシーの合成完了形状。 |
| `compat.noCacheControl` | boolean | false | BILI_NO_CACHE_CONTROL | Anthropic レーンの cache_control ブレークポイントを完全にスタンプしないようにします（独自のブレークポイントポリシーを持つ上流/リレー用のエスケープハッチ）。 |
| `compat.keepResponseId` | boolean | false | ACP_KEEP_RESPONSE_ID | カーネル再構築された Responses リクエストで previous_response_id を保持します（デフォルトでは削除するため、再構築されたボディは上流が発行したことのない ID を参照しません）。 |
| `dsh` | object | {} | BILI_ALLOW_DSH_COMPACTION | セクションは認識されるが、従来のエスケープハッチは削除された（#3666、#2028 を代替）：`allowDshCompaction` キーおよび `BILI_ALLOW_DSH_COMPACTION` 環境変数はもはや存在しない — dsh ネイティブコンパクションは、すべてのレーンにおいてワイヤガードによって無条件に拒否される。残存する `dsh.allowDshCompaction` の値は、一度限りの非推奨警告とともに無視される；代わりにホスト側の抑制を適用すること（#3354/#2474）。ライブキー — `dsh.authoredCompaction`、`dsh.contextTab`、`dsh.contextTabLabel` — は以下のエントリに文書化されている。 |
| `dsh.authoredCompaction` | boolean | true (on, #3901 flip) | BILI_DSH_AUTHORED_COMPACTION | bili は dsh コンパクションの summarize 呼び出しを、拒否する代わりに折り畳みスナップショットでローカルに回答する（#3723/#3733）。0.1.203 のドッグフッド期間が維持されたため、デフォルトで ON。`false`（または環境変数 `BILI_DSH_AUTHORED_COMPACTION=0`）を設定すると、#1729 の拒否パスが復元される。 |
| `dsh.contextTab` | boolean | true | BILI_DSH_CONTEXT_TAB | DSH トップバーの「上下文」/「Context」会話タブを登録する（#3862/#4237）：`false` にすると、そのタブのみが削除される — コンプレッション、設定セクション、その他のすべてのサーフェスは引き続き動作する。非表示にしてもコンプレッションは無効にならない；台帳は設定セクション（会话 サブページ）、プラグインバンドル設定フェイス、Web UI、および `/acp` コマンド経由で引き続きアクセス可能。次のページ読み込み / dsh リスタート時に有効になる（スロット登録はページ読み込み時に発生）；デフォルト `true` = 現在の動作は変更なし。 |
| `dsh.contextTabLabel` | string | unset (built-in 「上下文」/「Context」) | — | DSH トップバーの Context タブのカスタム表示名（#4237）、例：別のプラグイン（dsh-context）が「上下文」の名前を所有している場合の "压缩账本"。トリムされた空でない文字列が組み込みラベルに優先される；空白または未設定の場合は組み込みにフォールバック。ファイル専用ティア（表示設定、#2030 に従い環境変数なし）。デフォルト未設定 = 組み込みラベルは変更なし。 |
| `resign` | scheme → { enabled?, passthrough?, credentialRef? } | {} (armed; built-in scheme sdk-hmac-sha256) | BILI_RESIGN, BILI_RESIGN_PASSTHROUGH, BILI_CODEARTS_REF, BILI_RESIGN_BENEFIT | Authorization スキームでキーイングされた再署名アーム：署名済みモデルリクエストは、すべてのエグレスボディが再署名されてトンネリングされる；署名解除できないリクエストは、パススルーがそのスキームを逐語転送にオプトインしていない限り、ローカルで 403 として拒否される。 |
| `promptCache.routing` | "auto" \| "enabled" \| "disabled" | disabled | ACP_PROMPT_CACHE_ROUTING | bili 自身の `prompt_cache_key` 出力の姿勢（両方のワイヤ）；クライアントが供給したキーは常に逐語的に転送される。 |
| `cacheKeepalive.enabled` | boolean | false | BILI_CACHE_KEEPALIVE | Anthropic ワイヤにおけるアイドル時のプロンプトキャッシュキープアライブのマスタースイッチ（#3376）：セッションがアイドルになると、bili は TTL 由来の周期で `max_tokens=1` を伴う最後の転送ボディを再生し、アップストリームのプレフィックスキャッシュをウォームに保つ；ヒットは `usage.cache_read_input_tokens` 経由で検証される；ミス/429/エラー連続/期間上限で停止。プロバイダルートごとおよびモデルごとにも設定可能。 |
| `cacheKeepalive.ttlFactor` | number | 0.9 | BILI_CACHE_KEEPALIVE_TTL_FACTOR | 検出/推定されたキャッシュ TTL ティアに適用される周期係数（ピン間隔 = ティア x 係数；0.9 は 5 分ティアで約 4.5 分ごとに 1 ピン、1 時間ティアで 54 分ごとに 1 ピン）。(0, 1] の範囲でなければならない。 |
| `cacheKeepalive.maxDurationMs` | number | 86400000 | BILI_CACHE_KEEPALIVE_MAX_DURATION_MS | セッションごとのキープアライブ生存期間上限、セッションの最後の実際のリクエストから測定（デフォルト 24 h）；これを過ぎると、ヒットが続いていてもキープアライブは解除される。 |
| `cacheKeepalive.maxConcurrentPings` | number | 4 | BILI_CACHE_KEEPALIVE_MAX_PINGS | 同時にアームされたセッションの上限；超過した場合、最も長くアイドル状態のアーム済みセッションが最初に追い出される。 |
| `cacheKeepalive.assumeTtl` | "5m" \| "1h" | null (detect from body breakpoints) | BILI_CACHE_KEEPALIVE_ASSUME_TTL | ボディブレークポイント検出をスキップし、このティアから直接周期を導出 - bili の下流で `cache_control` TTL を注入または書き換えるリレー向け、転送ボディにブレークポイントがないか、ティアが誤っている場合。 |
| `cacheKeepalive.armWithoutBreakpoints` | boolean | false | BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS | 転送ボディに `cache_control` ブレークポイントが全くない場合でもキープアライブをアーム（デフォルトオフ - ブレークポイントがない場合、リフレッシュすべき明示的なブレークポイント付きコンテンツがない；リレーがブレークポイントを自分で管理している場合は `assumeTtl`/`intervalMs` と組み合わせること）。 |
| `cacheKeepalive.intervalMs` | number | null (derive from TTL tier) | BILI_CACHE_KEEPALIVE_INTERVAL_MS | ミリ秒単位の絶対ピン間隔；`ttlFactor`、`assumeTtl`、および検出されたティアに優先。アップストリームの TTL ポリシーに従わない固定周期向け。 |
| `native.attachExternal` | boolean | false | BILI_NATIVE_ATTACH_EXTERNAL | ランチャーなしのネイティブプラグインが、自分自身のデーモンを生成する代わりに、外部（レーン付き、未アーム）のデーモンにアタッチできるようにする。 |
| `native.attachLanePriority` | string[] | [] (own lane → user zone → spawn) | — | 自レーンインスタンスが存在しない場合、レーンがライド可能な FOREIGN レーン名の順序付きリスト（#2905）。自レーンは常に最初に優先される；ユーザーゾーン（手動 `bili start`、8787 グローバル）は常に最後；リストにないレーンはアタッチ不可のまま。ファイル専用、環境変数なし。 |
| `native.attachPolicy` | "own-lane" \| "global-fallback" | own-lane | BILI_NATIVE_ATTACH_POLICY | ネイティブフックのアタッチにおけるレーンアフィニティ、およびクロスレーンライドが発生するかどうかのゲート（#2877）。own-lane（デフォルト）: LANEd フックは同じレーンのデーモンにのみライドし、利用可能なものがなければフォールバックとしてレーンなし/手動起動された bili start デーモンや他のレーンのデーモンを使用するのではなく、自前でスポンします（この収束により、すべてのエージェントが1つのデーモンのバージョンに固定され、セッションの二重書き込みが発生していた問題が解決されました）。アームされたレーンなしデーモン（管理共有プロキシ、#1225）は、どちらのポリシー下でも共有可能のままです。global-fallback は #2877 以前の動作を復元します：まず同じレーン、次に互換性のあるレーンなし/ユーザーゾーンデーモン、そして（attachLanePriority が設定されている場合）リストされた外部レーン。 |
| `native.attachUrl` | string | unset (discover per lane) | BILI_MCP_PROXY | ネイティブフックのアタッチにおける明示的なターゲットオリジン（任意の URL）。設定されると、フックは自動検出の代わりに、その正確なオリジンにのみアタッチし、ライブでない場合は自前でスポンします。それでもなおコード互換性があり、ライフサイクルゲートを通過する必要があります。BILI_MCP_PROXY 環境変数（CLI の --origin によっても設定される）は、このファイルの値よりも優先されます。空または空白は未設定を意味します。 |
| `claude.nativePort` | number | unset (lane sticky zone port) | BILI_CLAUDE_NATIVE_PORT | claude ネイティブレーンのフックスポンによるプロキシの正確なポートピン（strict-port: 占有者は明確に拒否されます）。 |
| `pi.subagents` | object \| boolean | {} (acp_delegate enabled with package defaults) | PI_ACP_DELEGATE_FORCE_ENABLE, PI_ACP_DELEGATE_MAX_DEPTH, PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES, PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES, PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES, PI_ACP_DELEGATE_MAX_CONCURRENT | 組み込み pi レーンサブエージェント（acp_delegate）サーフェス、#2230 config-home。billion-context.json の pi.subagents セクションがデリゲート設定を所有します。4 つの acp.json キー（delegate/delegatePrompt/displayUsage/debug）は、セクションが存在しない場合のみ読み取られる非推奨のフォールバックです。prompt は delegatePrompt を置き換えます。debug はサブエージェントサブシステムにスコープされます。ブール値の省略形 subagents: false はサーフェス全体を無効にします。完全なフィールドテーブル：configuration.md の pi セクション。 |
| `pi.inline` | boolean | true (unset env+file runs inline) | BILI_PI_INLINE | Pi インラインレーン（#3278; #5428 以降デフォルトで有効、#4687 のオプトインルールを置き換え）: pi 拡張機能の圧縮はインプロセスで実行されます — スポンされたプロキシなし、エフェメラルポートなし；モデルトラフィックと /__bili//__acp ツールサーフェスは擬似オリジンを通じてインプロセスエンジンによって提供され、codex Responses WebSocket レーンはループバック専用 WS ブリッジによって、Web UI はエンジンと同時に起動されるループバック専用 Web リスナーによって提供されます。現在、env+file が未設定の場合にはインラインで実行されます；ANNOUNCED アタッチターゲット（ランチャー設定の BILLION_CONTEXT_PROXY/ATTACH）はデフォルトよりも優先されるため、`bili pi` はランチャープロキシを維持します。BILI_PI_INLINE=0/false/no/off またはこのキーを false に設定することでオプトアウトできます — 従来のアタッチ/スポン姿勢を復元します。解決順序は env > file > default；明示的なインライン選択は常に ANNOUNCED アタッチターゲットよりも優先されます。人間向けサーフェス：`bili -i/--inline pi`（≡ ワンコマンドレーン）と `bili -s/--server pi`（プロキシ姿勢をピン留め、継承されたインライン env よりも優先）。 |
| `pi.commands` | string[] \| boolean | ["acp", "acp-cache"] |  | 登録される bili pi-plugin スラッシュコマンド："acp", "acp-cache", "acp-rule", "acp-fleet"。デフォルトでは、ステータス（/acp）とキャッシュ調整（/acp-cache）のエントリポイントを維持しつつ、より稀に使用される /acp-rule と /acp-fleet をスラッシュ補完リストから除外します；true は 4 つすべてを登録し、[] または false は何も登録しません。不明な名前は一度警告が表示され、無視されます。セッション開始時に読み取られるため、設定の編集は次のセッションに適用されます（プロキシの再起動は不要）。純粋な UI サーフェス：コマンドの無効化は、基盤となるツール（acp_cache / acp_rule はモデルに対して利用可能のまま）を削除したり、プロキシに影響を与えたりしません。 |
| `opencode.inline` | boolean | false | BILI_OPENCODE_INLINE | OpenCode インラインレーン（#3278 ポート；オプトイン — #4687 におけるオーナーの決定に従い、デフォルトはスポンされたプロキシのまま）: opencode プラグインの圧縮はインプロセスで実行されます — スポンされたプロキシなし、エフェメラルポートなし、MITM 証明書なし；モデルトラフィックと /__bili/ ツールサーフェスは擬似オリジンを通じてインプロセスエンジンによって提供されます（Bun ホストで検証済み）。有効にするには true（または BILI_OPENCODE_INLINE=1）を設定します。解決順序は env > file；明示的なインライン選択は常に ANNOUNCED アタッチターゲットよりも優先され、選択が欠如している場合は従来どおりアタッチ/スポンにフォールバックします。`bili opencode-inline` はワンコマンドレーンです。 |

**MITM レーン**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `providersPath` | string | unset | ACP_PROVIDERS | 外部 providers.json へのパス（レガシー/共有ルートファイル）。インラインプロバイダおよび設定ファイル内の場所の両方よりも優先される。 |
| `mitm.enabled` | boolean | true | BILI_MITM | アップストリームをハードコードしているログインクライアント向けの HTTPS 傍受スイッチ；ドメインは初回検出時にホワイトリストに登録されます。 |
| `mitm.domains` | string[] | [] | BILI_MITM_DOMAINS | 明示的な MITM ホワイトリストドメイン（初回検出時の自動ホワイトリスト化と合算）。 |
| `mitm.handshakeTimeoutMs` | number | 10000 | BILI_MITM_HANDSHAKE_TIMEOUT_MS | 傍受された接続の TLS ハンドシェイクタイムアウト。 |

**プロセス & 永続化**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `network` | object | {} (all defaults) | — | 上流呼び出しのタイムアウト、ウォッチドッグ、リプレイポリシー。 |
| `network.upstreamTimeoutMs` | number | 720000 | BILI_UPSTREAM_TIMEOUT_MS | 単一の上流呼び出しに対する絶対上限（12分は、遅い深層思考モデルをカバーする）。 |
| `network.upstreamFirstByteMs` | number | = upstreamTimeoutMs (resolved; 720000 when unset) | BILI_UPSTREAM_FIRST_BYTE_MS | フェーズ1の予算：リクエスト送信 → 最初のレスポンスバイト（undiciは最初のボディデータ付近でfetchを解決する）。未設定の場合、解決済みの上流タイムアウト（upstreamTimeoutMs）に従う — BILI_UPSTREAM_TIMEOUT_MS を12分以上に引き上げるデプロイメントを含む（#5917 レビュー：定数 720000 のフォールバックはそれらを静かに再制限してしまう）— したがって動作は変更されない；より厳格なデプロイメントはオプトインする（#5904：リクエストを受け入れるが以前は応答しなかったスタックした上流は、クライアントが中断するまで静かにハングしていた）。最初のバイト後、チャンク間の沈黙は引き続き完全な upstreamTimeoutMs によって管理される（#1706/#1714 の保証）。この値が upstreamTimeoutMs 未満に設定されると、最初のバイトのタイムアウトは独自の失敗クラス upstream-headers-timeout となる — レスポンスバイトがゼロであるため、bili はリクエスト全体を一度で失敗させるのではなく、既存のリトライ予算（BILI_REPLAY_RETRY_MAX、デフォルト 3）の下でプロキシ内でリプレイする；ストリーム中（ボディ）のアイドルタイムアウトは upstream-timeout のままであり、リトライされない。未設定の場合、動作は以前とバイト単位で同一である（#5807/#5831）。リリースゲートは 120000 を設定する。 |
| `network.requestWatchdogMs` | number | 2× upstreamTimeoutMs | BILI_REQUEST_WATCHDOG_MS | 呼び出しごとのタイマーが設定されていなくても、スタックした上流ソケットを強制中断する絶対的なウォッチドッグ。 |
| `network.keepAliveTimeoutMs` | number | 5000 | BILI_KEEP_ALIVE_TIMEOUT_MS | プールされた上流ソケットのアイドルキープアライブタイムアウト。 |
| `network.clientErrorBackstopMs` | number | 30000 | BILI_CLIENT_ERROR_BACKSTOP_MS | コミットされたレスポンスの読み取りを停止したクライアント接続を中断するバックストップ。 |
| `network.exposureLogIntervalMs` | number | 3600000 (0 disables the log) | BILI_EXPOSURE_LOG_INTERVAL_MS | バインドアドレス公開の警告がログに繰り返し表示される間隔；0 で完全に無効化。 |
| `network.streamKeepAliveMs` | number | 15000 (0 disables) | BILI_STREAM_KEEPALIVE_MS | モデルチャンク間の下流ストリームキープアライブピン間隔；0 でピンを無効化。 |
| `network.preflightHoldMs` | number | 30000 | BILI_PREFLIGHT_HOLD_MS | 失敗したプリフライトが、リクエストが未調整のまま許可されるまで保持される時間。 |
| `network.preflightDeadEndCooldownMs` | number | 300000 | BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS | 行き止まりのプリフライト後、同じセッションの調整を再試行するまでのクールダウン。 |
| `network.replayRetryMax` | number | 3 (1 disables replays) | BILI_REPLAY_RETRY_MAX | エラーを表面化させる前に、同一リクエストの最大トランスポート失敗リプレイ回数。 |
| `network.replayRetryBaseMs` | number | 1500 (0 disables the delay) | BILI_REPLAY_RETRY_BASE_MS | リプレイ間のベースバックオフ遅延（指数関数的）。 |
| `network.throttle429Enabled` | boolean | true | BILI_THROTTLE_429 | エグレス側の 429 ガバナナ（#4204）：繰り返される上流 429 は転送されるのではなくローカルで応答される。アカウント制限および未認識/不正なレスポンスは origin+credential を保持する；KeyRing の正確な keyring_model_temporarily_unavailable コードと一致するリクエストモデルのみが origin+credential+model を保持し、他のモデルを適格とする。モデルの不一致または欠落はアカウント全体に適用される；false は従来の常に転送する動作を復元する。 |
| `network.throttle429MaxConsecutive` | number | 5 | BILI_THROTTLE_429_MAX_CONSECUTIVE | ホールドがターミナル（既知のすべての SDK リトライセットの外側のローカル 424）に変わるまでの連続上流 429 の回数；バックオフウィンドウごとに1回のプローブが、アカウントホールドをクリアする非 429 レスポンス、またはそのモデルホールドをクリアする一致するモデルの非 429 レスポンスがあるまでチェックを続ける。 |
| `network.throttle429BaseDelayMs` | number | 2000 | BILI_THROTTLE_429_BASE_DELAY_MS | 429 ホールドのベースバックオフ（連続する 429 ごとに倍増し、[0.5×, 1×] にジャッターされ、throttle429MaxDelayMs で上限が設定される；上流の Retry-After が大きい場合は優先される）。 |
| `network.throttle429MaxDelayMs` | number | 30000 | BILI_THROTTLE_429_MAX_DELAY_MS | 429 のバックオフおよびターミナルフェーズのプローブ間隔の上限。 |
| `network.throttle429Scope` | string | credential | BILI_THROTTLE_429_SCOPE | マーカーなしの上流 429 に対するホールドの粒度 (#5199)。値の一致は完全一致 (`credential` または `model`、大文字小文字を区別) であり、タイプミスがある場合は 1 回の警告ログとともに `credential` にフォールバックする。`credential` (デフォルト) は #5696 の保守的なセマンティクスを維持し、認識されたモデルマーカー (`keyring_model_temporarily_unavailable`、または bili リレーの `bili_throttle_hold` scope=model) を伴わない 429 は、そのクレデンシャルの背後にあるすべてのモデルがバックオフを待機するように、オリジン+クレデンシャル全体をホールドする。`model` は、1 つのクレデンシャルの背後に独立した制限を持つ多数のモデルをフロントするゲートウェイ (LiteLLM/one-api/opencode.ai スタイルのリレーで、1 つのモデルの RPM 枯渇がその兄弟モデルをフリーズすべきではない場合) に対して、送信のリクエストモデルをキーとしてホールドを行う。モデルを識別できないリクエストは引き続きクレデンシャル全体を対象とし、認識されたマーカーは両モードで独自のセマンティクスを維持する。注意: `model` の場合、ホールドキーはワイヤーが運ぶリクエストモデル文字列の完全一致 (`glm-5.2` ≠ `GLM-5.2` ≠ `glm-5.2-128k`) であり、モデル名を書き換えるか 1 つのモデルを複数のエイリアスで提供するゲートウェイは、そのモデルごとのクォータが請求されるのと同様に、スペルごとに個別のホールドを維持する。 |
| `network.maxShrinkPerCompress` | number | unset | BILI_MAX_SHRINK_PER_COMPRESS | 1 回の圧縮で履歴を縮小できる量の上限 (崩壊防止ガード)。 |
| `network.proxyKeepAliveMaxMs` | number | 55000 (0 = one-shot connections) | BILI_PROXY_KEEPALIVE_MAX_MS | アウトバウンドエグレスプロキシを介した接続の最大生存時間。これを超えると再接続を強制する (古い NAT マッピングを回避するため)。 |
| `network.postResponseLingerMs` | number | 5000 | BILI_POST_RESPONSE_LINGER_MS | レスポンス完了後のプロキシ起因のクローズに対するグレースフルクローズの予算: ソケットはピアの FIN/TLS close_notify を待って保持され、期限時に破棄される (reason=linger-backstop)。 |
| `network.allowPrivateHttpProviders` | boolean | false | BILI_ALLOW_PRIVATE_HTTP_PROVIDERS | オプトイン (#2984): プライベートネットワーク (RFC1918, 127/8, リンクローカル, ULA, *.local/.lan/.internal) 上のプレーン HTTP プロバイダーを、エージェントレジストリのインテークおよびサマリーエンドポイントのガードに許可する。デフォルトでは無効 — プレーンテキストはループバックのみ許可; 公開 IP/ドメインおよび CGNAT (100.64/10) は常に拒否される。1/true で有効化。 |
| `network.receiveBodyBytes` | number | 5368709120 | BILI_RECEIVE_BODY_BYTES | 受信ステージで 413 を返す前に、リクエストごとにメモリに読み込む最大ワイヤーバイト数。ハードコードされた 100 MiB から 5 GiB に引き上げられ (#3128 オーナー決定)、マルチギガバイトの単一リクエストがソケットリセットされることなく受け入れられるようになった。また、デコードされたリクエストが共有される 2 つの大型デコードアドミッションスロットの 1 つを消費する閾値でもある。WebSocket レーンは固定の 100 MiB のサーフェスを維持する。 |
| `network.decodedBodyBytes` | number | 10737418240 | BILI_DECODED_BODY_BYTES | コンテンツエンコーディング展開 (gzip/deflate/br/zstd) 後の最大デコードバイト数。デコード中に増分チェックされる (デコードステージ 413)。デフォルトは受信予算の 2 倍で、従来の decode=2x-wire の関係を反映し、デコンプレッションボムから守る。 |
| `network.outboundBodyBytes` | number | 5368709120 | BILI_OUTBOUND_BODY_BYTES | 上流に転送される再構築リクエストの最大バイト数 (転送ステージ 413)。最終ボディ文字列の UTF-8 バイト数としてカウントされる。fetch 前にチェックされるため、予算超過の再構築は上流のウォッチドッグ割り当てに到達しない。 |
| `network.wsOutboundBytes` | number | 10485760 | BILI_WS_OUTBOUND_BYTES | WebSocket レーン専用のソフトバイト予算 (#3701): 最終シリアライズされた Responses WS フレームがこれを超過した場合、まず OUTBOUND COPY から古い画像が除去される (プレースホルダーノートとしてアーカイブ — 元画像はセッションストレージに残り、ツールアームされたレーンでは read_original_image / decompress で復元可能 — 注入ツールを拒否する codex スタイルのレーンはサイズのみ注釈を保持)、その後残ったものは jimp maxDim ラダーを通じて有界にダウンスケールされる。それでもフレームが収まらず、イベント前に上流が 1009 でクローズした場合、同じリクエスト内で厳密に小さい再送信が 1 回試行される。0 に設定すると除去を無効化 (従来のそのまま送信する動作)。HTTP レーンには影響しない — ハード拒否上限は network.outboundBodyBytes のまま。 |
| `network.httpOutboundBytes` | number | 10485760 | BILI_HTTP_OUTBOUND_BYTES | プレーン/プロキシ/pi ネイティブ HTTP リレーレーン専用のソフトバイト予算 (#3909): 最終シリアライズされたリクエストがこれを超過した場合、まず OUTBOUND COPY から古い画像が除去される (プレースホルダーノートとしてアーカイブ — 元画像はセッションストレージに残り、ツールアームされたレーンでは read_original_image / decompress で復元可能 — 注入ツールを拒否する codex スタイルのレーンはサイズのみ注釈を保持)、その後残ったものは jimp maxDim ラダーを通じて有界にダウンスケールされる。画像密集セッションが空けられるギャップを閉じる: トークンスペースの折りたたみはトークンで決定するが、上流はバイト/ピクセルデコード CPU (Cloudflare Worker 503) で拒否するため、約 48 MiB のリクエストは同じピクセルを再送信するたびに永遠に 503 になる。マネージドトランスポートがインストールされていない場合 (spawned リレー) のみ適用される; WS レーンは network.wsOutboundBytes を使用し、マネージド HTTP トランスポート (inline-engine / dsh-inline) はここでは決して除去されない (#3701 Finding 1)。0 に設定すると無効化 (従来のそのまま送信する動作); ハード拒否上限は network.outboundBodyBytes のまま。 |
| `network.ingestBodyBytes` | number | 33554432 | BILI_INGEST_BODY_BYTES | デコード後 (#5794 item 2) の JSON.parse + 正規化スイープのためのコストバンド (デコードバイト数)。これを超過するテキスト主体のボディは、スイープ前に実行可能な 413 (ステージ ingest) で拒否される。なぜなら、32 MiB を超えるパース可能なテキストボディはすでに約 800 万トークンであり、すべての実際のモデルウィンドウを超えており、それをパースするためにイベントループの時間を数秒消費する (51.2 MiB / 29,619 メッセージのインシデント: 1 ラウンドあたり 5.5–7.2 秒、ローカル CPU の 54.6%、FATAL 747 秒) ことは成功に終わらないためである。画像を含むボディはすべてのレーンで免除される: base64 ピクセルは設計上トークンメーターから除外される (画像は別途請求され、生バイト数では決して失格にならない — #496/#1800/#857) ため、バンド超過の画像量は、アドミッションスロット、受信上限、および各レーン独自の shed / 送信前バイト予算 (#3909 約 48 MiB の画像密集セッション、#3701 WS スクリーンショット; Responses レーンは完全に免除) によって管理される。アドミッション SLOTS (network.receiveBodyBytes 閾値) とは異なる: スロットは大型デコードの並行性を制限するが、この上限は単一のボディを制限する。0 に設定すると無効化 (従来のすべてパースする動作)。 |
| `network.maxMessages` | number | 0 | BILI_MAX_MESSAGES | 上流ごとの messages[] 配列長のハード上限 (#5000 item 2) — COUNT 次元: バイト/トークン推定では表現できないワイヤー制約 (#5000 セッションの 26,903 メッセージ / 55.2 MiB はすべてのサイズゲートを通過したが、カウントエラーで上流で死んだ)。意図的に上流ごと: 普遍的な値が存在しないため、デフォルトは 0 = 無効; 上流の既知の制限に設定し、カウント超過のボディには保証された上流 400 の代わりに実行可能な 413 (セッションの再起動または巻き戻し) を返す。カウントのみ — 決して折りたたまない。プリフライト (トークントリガーの前) および no-model レーンのエグレスフュージで強制される。 |
| `network.caFile` | string | unset | BILI_CA_FILE | bili の独自のアップストリームフェッチが信頼する追加ルート CA を含む PEM ファイルへのパス (#3776)。Node の組み込みルートおよび NODE_EXTRA_CA_CERTS エントリとマージされる — 決して置き換えない。HTTPS/暗号化接続スキャンを行うセキュリティソフトウェア (Kaspersky、エンタープライズ DLP) またはアップストリームを再署名する企業 MITM プロキシに対して: そのルート CA を PEM にエクスポートし、これを指すように設定する。未設定 = デフォルトの信頼、バイト単位で同一の動作。 |
| `guardrails` | object | {} (all defaults) | — | ガードレール: pi/omp プラグインバンドル用のツール出力ガードレール (#3066) およびプロキシ側のテキストランストリームガード (#3406)。 |
| `guardrails.bashTimeout` | number | 60 | BILI_GUARDRAIL_BASH_TIMEOUT | モデルが bash ツールのタイムアウトを省略した場合に注入される秒数（#3066 のオーナー意図、#3366 で再確認：監督のない bash 呼び出しが pi セッションを丸一日ハングさせる可能性があるため、ホストスキーマにはデフォルト値が提供されていない）。N を設定して調整し、0 に設定すると注入を無効にする（pi ネイティブのデフォルトなし）。 |
| `guardrails.maxOutputBytes` | number | 50000 | BILI_GUARDRAIL_MAX_OUTPUT_BYTES | pi/omp プラグインにおけるツール結果ごとのテキスト出力バイト数上限（0 で上限を無効化）。上限超過の出力は先頭から切り詰められ、ホストが保存した完全な出力を指す通知が付与される。 |
| `guardrails.repetition` | boolean \| object | true | BILI_GUARDRAIL_REPETITION | pi/omp プラグイン向けの同一呼び出しループブレイカー：短時間に連続して発行された同一呼び出しが 3 回目に達すると警告を発する（引数の比較はキー順序に依存しない。実際に 5 秒以上実行された以前の同一呼び出しは長時間ポーリングとみなされ、実行が再開される）。5 回目に最終的な拒否を 1 回発行する（その呼び出しは拒否されるがターンは存続する）ことで、正当な待機/ポーリングがより長い待機に切り替えられるようにし、その拒否後に同一呼び出しが繰り返された場合のみターンを中断する（#5225）。オブジェクト形式では、`enabled`（デフォルト true、ゲート）、`warn`（デフォルト 3、警告閾値）、`abort`（デフォルト 5、最終拒否閾値）、および `recovery`（デフォルト false、オプトインのグレースフルターミネーションモード：呼び出し 6〜(abort+4) はスタックレポート付きで拒否されるがターンは存続し、同一呼び出しが abort+5 連続に達した場合のみターンが強制終了される（#5505））も追加で受け付ける。false / 環境変数 0 で無効化。オブジェクトのサブフィールドはファイル専用（環境変数経由では公開されない）。 |
| `guardrails.repetition.enabled` | boolean | true | — (file-only) | オブジェクト形式で使用する場合の同一呼び出しループブレイカーをゲートする。true（デフォルト）で有効化、false で無効化。よりシンプルなオプトアウトには `repetition: false`（ブール形式）を使用する。 |
| `guardrails.repetition.warn` | number | 3 | — (file-only) | 最初の警告閾値。この回数以降の同一呼び出しには、結果に WARNING 通知が追加される（#3066）。`abort` より小さい値でなければならない。 |
| `guardrails.repetition.abort` | number | 5 | — (file-only) | 最終拒否閾値。この回数を超えた次の同一呼び出しは、実行されずにブロックされ拒否され、FINAL WARNING が付与される（#5225）。`warn` より大きい値でなければならない。 |
| `guardrails.repetition.recovery` | boolean | false | — (file-only) | オプトインのグレースフルターミネーションモード（#5505）。true の場合、最終拒否（abort）後の呼び出しはスタックレポート付きで拒否されるがターンは存続する（ソフトストップ）。ターンが強制終了されるのは、同一呼び出しが abort+5（ハードバックストップ、デフォルト 10）に達した場合のみ。false（デフォルト）= 元の動作：呼び出し 6 で ctx.abort() が実行される。 |
| `guardrails.textRunThreshold` | number | 200 | BILI_GUARDRAIL_TEXT_RUN_THRESHOLD | レスポンスストリーム上のデコード済みモデルテキストに対する単一コードポイント反復ブレイカー（#3260；#3331 レビュー後に #3406 の項目 1 でキルスイッチが追加）。N 連続の同一コードポイントでトリガーされる - 正当な散文/コードはデフォルトの 200 を大きく下回るが、シンボルループモデルはそうではない。N を設定して調整し、0（または負）で無効化：正当な長い同一文字出力（コードコメントの区切り、ASCII ルール）はストリーム途中で切断されなくなる。thinking/reasoning チャネルもこのレーン内に存在する。 |
| `persist` | object | {} (all defaults) | — | XDG ステートディレクトリ下へのセッション永続化。 |
| `persist.enabled` | boolean | true | BILI_PERSIST | セッションレコードをディスクに書き込むためのマスタースイッチ（0/false でオフ）。 |
| `persist.zstd` | boolean | false | BILI_PERSIST_ZSTD | 永続化されたセッションファイルを Zstd 圧縮する（1/true で有効化）。 |
| `persist.debounceMs` | number | 500 | BILI_PERSIST_DEBOUNCE_MS | セッションファイルの書き込みデバウンスウィンドウ。 |
| `persist.maxDelayMs` | number | 5000 | BILI_PERSIST_MAX_DELAY_MS | 継続的なアクティビティ下で保留中のセッションファイル書き込みが待機できる最大時間 — デバウンスウィンドウはすべての変更で再起動されるため、この予算は摩耗に敏感なドライブ上の定常状態での書き換え速度を制限する（#6058）。 |
| `persist.tailTokens` | number | 16384 (0 disables message persistence) | BILI_PERSIST_TAIL_TOKENS | エクスポートの忠実性のために生テキストとして保持される最近のメッセージのトークンサイズ末尾。 |
| `persist.epermAlertThreshold` | number | 5 | BILI_PERSIST_EPERM_ALERT_THRESHOLD | ログにアラートを出すまでの連続 EPERM 書き込み失敗回数。 |
| `persist.epermAlertRepeatMs` | number | 0 (no repeats) | BILI_PERSIST_EPERM_ALERT_REPEAT_MS | EPERM アラートの繰り返し間隔。0 の場合は 1 回のみログ出力する。 |
| `storage` | object | {} (all defaults) | — | 統合 SQLite ストレージサイドカーの設定 (#2671)。 |
| `storage.unified` | legacy\|shadow\|full | unset (full) | BILI_STORAGE_UNIFIED | 階層型ストレージ移行スイッチ (#2671): shadow = ダイジェスト照合付き統合 SQLite ダブルライトのドライラン; full = ドロップイン読み取りパス (オーガニックインポート付きの統合優先読み込み、レガシーフォールバック)。現在、どこでも未設定の場合は FULL がデフォルト (#3818 の反転 - shadow ドライランは #2815 以降クリーンに照合されたため、インデックスが読み取りパスとなる; JSON エンベロープは引き続き書き込まれ、レガシーは 1 行のエスケープハッチとして残る)。ファイル階層は厳密に legacy/shadow/full; 環境変数階層は 1/true (=shadow) と unified (=full) も受け入れ、ファイルより優先される。レーン起動ごとに 1 回のみ解決される - ホット編集には再起動が必要。暗号化 (BILI_ENCRYPTION_KEY) はサイドカーをハードブロックする。 |
| `storage.backend` | sqlite\|mysql | unset (sqlite) | BILI_STORAGE_BACKEND | ストレージバックエンドの選択 (#3388 / #3931): 統合ストアは操作レベルの非同期 StorageBackend 契約を消費する。sqlite がデフォルト (Promise ラップされたアダプター背後の既存の UnifiedStore)。mysql は完全に配線済み (ステップ 2+3): openBackend("mysql", dsn) は MySQL 8.0 に対して実際の MysqlBackend を開く - 完全な契約サーフェス (CAS リファレンスカウント付きのインジェスト、読み取り、session_ext、リープジャーナル、アーカイブ/リストア/GC、チェックポイント、会話)、mysql2 は通常の依存関係としてバンドルされ、遅延ロードされる (mysql を選択しない起動では決してロードされない)。プロキシのホットパスは非同期シャドウファサードを通じて配線されている: セーブはシリアルバックエンドキューにエンキューされる (ウォーターマークデルタ、孤立/リープジャーナル、ダイジェストサンプリング - sqlite はゼロ await の同期高速パスを不変のまま維持)、同期読み取りは JSON エンベロープに乗る (サイドカーは ready() 経由で非同期にアタッチされる; viewFor/importRecord の同期ファサードは意図的にミスする)、レプリカ/ext/GC/エクスポート/フォークは非同期ツインを話す (#4911: フォークレーンはそれらを通じて lastLiveSeq + 行クローンに await する; フォールドアンカーバックフィル / スナップショットレンダリングのための同期ウィンドウ読み取りは意図的にエンベロープ提供される)。writerOff は sqlite のみ (エンベロープは mysql の同期読み取りパスである)。不明な名前は通知付きで sqlite にフォールバックする。レーン起動ごとに 1 回のみ解決される。 |
| `storage.mysql.dsn` | string | unset | BILI_MYSQL_DSN | storage.backend="mysql" 用の MySQL DSN (#3388 ステップ 2, #3931): mysql://user:pass@host:3306/db。StorageBackend 契約パスによって消費される (ホットパスを含む - 非同期シャドウキュー)。環境変数 BILI_MYSQL_DSN がファイルキーより優先される。空/未設定 = mysql バックエンドが開けない - 文書化されたエラーは両方のノブと動作するデフォルトを名指しする。 |
| `storage.sqliteAutoDownload` | boolean | true | BILI_SQLITE_AUTO_DOWNLOAD | 1 回限りの SQLite エンジンの自己ダウンロードのゲート (#2833): プロセス内でエンジンが利用可能でない場合 (組み込みの node:sqlite なし、ホストインストールの better-sqlite3 なし) かつこのプラットフォームで統合サイドカーが望まれる場合、bili は npm レジストリからピン留めされた better-sqlite3 プリビルトタールボールを 1 回ダウンロードし (~11 MB、sha512 検証済み)、キャッシュディレクトリに保存し、その後のすべての起動で再利用する。エンジン解決順序: 組み込み node:sqlite (Node >= 22.5) -> ホスト提供の better-sqlite3 -> キャッシュされた自己ダウンロード -> 自己ダウンロード (このスイッチでゲート) -> なし (レガシーのみ、#2825 のデグレード契約)。このスイッチはネットワークフェッチのみをゲートする - キャッシュされたコピーは false でも使用される; 非サポートプラットフォームでは決してダウンロードしない。タールボールのダウンロードは組み込みミラーリストを辿る (#3338): 設定されたレジストリ (BILI_UPDATE_REGISTRY / update.registry) が最初に試され、次に https://registry.npmjs.org、次に https://registry.npmmirror.com - sha512 検証済みのタールボールを返す最初のミラーが勝つ; エンジンなしの Node < 22.5 はデグレード理由に明示的な Node アップグレードヒントが付く (#3385)。エンジン成果物はランタイムごとにピン留めされる。なぜなら、バインディングはそのパッケージが宣言する範囲外ではロードできないため: N-API >= 10 を持つ Node >= 22 は better-sqlite3 v13 を使用 (独自のプリビルドを保持する 1 つのタールボール)、一方 v13 のメジャーフロアは通るが N-API 9 のみ搭載する Node 20 と Node 22.0-22.12 バンドは v12.9.0 を使用 (JS のみのタールボールとその ABI キー付きプリビルド、バイナリミラーから取得され nativeBinding を通じてバインドされる)。これにより、低バージョンの Node でも統合レーンに留まり、レガシーへのデグレードを避ける。ピン留めされた成果物が提供できないランタイム (すべてのフロア未満、またはプリビルドがターゲットとしない ABI) は、ロード前に拒否される。ダウンロードもキャッシュされたコピーも登録されない。そのようなバインディングのロードは優雅に失敗するのではなくプロセスをクラッシュさせるため (#3341, #3894)。ダウンロード失敗は、キャッシュディレクトリ配下にマーカーファイルとして永続化される 6 時間のリトライクールダウンをアームする (billion-context/sqlite/.bootstrap-failed.json); ストレージ診断ブロブはマーカーの絶対期限時間とパスを表示する - そのファイルを削除して bili を再起動すると、ウィンドウ全体を待たずに即座のリトライを強制できる (#3788)。 |
| `storage.jsonWriter` | on\|off | on | BILI_STORAGE_JSON_WRITER | フェーズ 3 エンベロープスイッチ (#2960): off は storage.unified が full の間、レガシー JSON セッションエンベロープの書き込みを停止する - SQLite インデックスが唯一の永続コピーとなる (読み取りはすでに統合優先; 起動時にインデックスの和集合を列挙するため、インデックスのみのセッションは正常にロードされる)。有効な full モードでのみ尊重される: shadow/legacy (または暗号化が有効な場合) では、JSON ファイルが唯一の真実のソースであるため、1 回限りの警告付きでリクエストは無視される。環境変数階層 0/false/off = off、1/true/on = on が厳密なファイル表記より優先される。フェイルセーフ: サイドカーが実行中に自身を無効化した場合、次のセーブでエンベロープ書き込みが再開される。ロールバック: ノブを未設定にする - 書き込みが再開され、インデックスのみのセッションは起動和集合経由で引き続きロードされ、レプリカ/リストアはポータブルな JSON エンベロープを再物質化する。バイナリのダウングレード (または SQLite エンジンの喪失) は、>=v0.1.197 バイナリが再び実行されるまで、インデックスのみのセッションを v0.1.196 以前のバージョンから不可視にする - データは index.db に無傷のまま残るが、古いコードによって読み取られないだけである。セッションごとの CCR コンテンツストアサイドカーも書き込みが停止する - full モードでは、すべての読み取りで最初にインデックスの ccr ミラーが参照されるため、ミラーが永続コピーとなる。jsonWriter=off レーンは、そのセッションディレクトリの唯一のライターでなければならない: off レーンは統合優先で読み取り、決してファイルにフォールバックしないため、同じディレクトリに対して legacy/shadow で実行されるピアインスタンスは静かに分岐する (その JSON コピーは更新を受け取らなくなり、off レーンはピアの書き込みを決して見ない)。 |
| `storage.walJournalSizeLimitBytes` | number | 8388608 | BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES | index.db-wal の WAL 回収上限 (#3250)、バイト単位: 完了したチェックポイントごとに WAL ファイルがこのサイズまで切り詰められ、長寿命プロセスにおけるディスク使用量とクラッシュ復旧リプレイを制限する。セッションごとのデータクォータではない - データは書き込まれた時点で index.db に着地し、WAL はチェックポイント間のフレームをステージングするだけなので、セッション数/サイズはこれをスケーリングしない; 大きなバーストは、次の完了チェックポイントが切り詰めるまで一時的に超過しうる。高い = 切り詰め IO が稀になるが、定常時のディスク使用量が増え、クラッシュリプレイのテールが長くなる。環境変数階層 (正の整数) がファイル階層より優先される; ゴミまたは非正の環境変数値は、起動を失敗させるのではなくファイル/デフォルト階層にフォールスルーする。レーン起動時にストアが開かれる時点で適用される - ホット編集には再起動が必要。有効な値は統合有効ログ行とストレージ診断ブロブに表示される。 |
| `storage.archiveAfterDays` | integer | 365 | BILI_STORAGE_ARCHIVE_AFTER_DAYS | 日単位の GC 年齢スイープウィンドウ (#3463, #3901): これより長くアイドル状態のセッションはアーカイブされる - 単一のアーカイブログ (セッションディレクトリ配下の archive/archive.jsonl — セッションごとのファイルスプレーなし) に 1 行の JSON が追記され、トombストーン行がラベルとアイデンティティを保持し、コンテンツ/メディア参照が解放され、リストアは 1 つの POST のみで可能。0 は年齢スイープを無効にする; POST /__bili/storage/gc は常に実行され、既存の index.db を縮小するには ?vacuum=full を取る (新規書き込みには常に auto_vacuum=INCREMENTAL が有効)。同じ操作に CLI レイヤーがある (#3928): bili storage gc [--days N] [--vacuum full\|incremental] [--dry-run]、および bili sessions ls/rm/archive/restore <id> (README の 'Storage maintenance CLI' セクション)。環境変数がファイル階層より優先される。 |
| `sessions` | object | {} (all defaults) | — | セッションテーブルサイズ上限とオプトインによるゴミ収集。 |
| `sessions.max` | number | 256 | BILI_MAX_SESSIONS | メモリ内セッションテーブル上限 (アイドルセッションの LRU 退避)。 |
| `sessions.warmMax` | number | 0 | BILI_SESSION_WARM_MAX | 有界な起動 (#2803/#3050): リスニング前に起動時に水合される最大最近保存セッション数; 古い状態はオンデマンドで再ロードされる。デフォルト 0 (急激なウォームセットなし — 最初のタッチが 1 回のオンデマンドロードを支払う; 急激な動作を復元するには 8 を設定)。sessions.max で上限が設定される。 |
| `sessions.warmMaxBytes` | number | 67108864 | BILI_SESSION_WARM_MAX_BYTES | 起動ウォームセットのデコード済みバイト予算 (#2803)。ディスク上の圧縮バイトではなくデコード済みサイズをカウントするため、zstd アーカイブが RAM 境界をすり抜けることはない。予算を超える単一のファイルは決してウォームされない。 |
| `sessions.residentMaxBytes` | number | 4294967296 | BILI_SESSION_RESIDENT_MAX_BYTES | 推定リザident セッションバイトのソフトターゲット (#2803; #5779 で 512 MiB から 4 GiB に引き上げ — 単一のセッションは通常 512 MiB を超え、より小さい予算に対して永遠にピンポンしていた)。アクティブ/進行中の状態はそれより上にピン留めされる; ターゲット超過時、アイドル状態はリクエスト完了時にディスクへ排出される。メモリが少ないマシンではこれを下げる。 |
| `sessions.hardMaxBytes` | number | (same as `sessions.residentMaxBytes`) | BILI_SESSION_RESIDENT_HARD_MAX_BYTES | セッションごとの推定リザident バイトのハード上限 (#4788, 決定 #4792 D1-A)。プールソフト上限とは異なり — それは他のコールドセッションのみを退避でき、単独アクティブセッションには決して触れない — これは 1 つのセッションを制限する: リクエスト終了境界で上限超過時、そのドロップ可能なフィールド (フォールドブロックのオリジナル、メタデータ台帳、有界ビューを超える生テール) はプール免除セッションであっても強制的にディスクへ戻され、次のターンは狭いディスク読み取りを通じて必要なものを透明に再読み取りする。最後の保存が確実に着地したことが証明される限り、安全なドロップはすべてのリクエスト境界で実行される; 上限はセッションごとのコールアウト (警告、60 秒にスロットリング) を追加する。`0` は上限チェックを無効にする。 |
| `sessions.contentStorePin` | boolean | false | BILI_SESSION_CONTENT_STORE_PIN | #4788 フェーズ2の常駐ドロップのエスケープハッチ: 各セッションのコンテンツストアをメモリに固定する（折りたたみは行われない）。デフォルトはオフ: 検証済みの保存が完了するたびに、アイドル状態のセッションのコンテンツストアはリクエスト間でドロップされ、統合インデックスミラーまたはサイドカーファイルからオンデマンドで再読み込みされる。検証済みのコピーがないストアを持つセッション（例: 新しいフォーク子プロセス）は自動的に常駐する。RAMを犠牲にしてゼロの再読み込みレイテンシが必要な場合にこれを設定する。 |
| `sessions.gc.enabled` | boolean | false | BILI_SESSION_GC | 古い永続化セッションのオプトインによるガベージコレクション（このフラグなしでユーザーデータを静かに削除することはない）。 |
| `sessions.gc.maxAgeDays` | number | 7 | BILI_SESSION_GC_MAX_AGE_DAYS | GCの年齢しきい値（日）。 |
| `sessions.gc.maxTokens` | number | 1000000 | BILI_SESSION_GC_MAX_TOKENS | セッションレコードごとのGCトークンサイズしきい値。 |
| `sessions.gc.intervalMs` | number | 3600000 | BILI_SESSION_GC_INTERVAL_MS | GCスイープ間隔。 |
| `plugin.snapshotCapBytes` | number | 104857600 (0 disables snapshots) | BILI_PUBLIC_SNAPSHOT_CAP_BYTES | ネイティブプラグインに配信されるフォークAPIパブリックスナップショットのサイズ上限。 |
| `snapshot.shadow` | boolean | true (on) | — | スナップショットレンダリングのシャドウ観測可能性（#3756のフォローアップ）: レンダリングレーンがまだロールアウトゲートされている間、すべてのアームされたターンがスナップショットビューを計算し、レガシーアウトバウンドとの差分を分類し、セッションごとのカウンターを記録する（Webパネル行 + /__bili/status の snapshotShadow 集計 + snapshot-shadow 診断トピック）。デフォルトはオン - これはロールアウト切り替えをゲートするエラー率を持つフリートワイドのドライランである。環境変数 BILI_SNAPSHOT_SHADOW が優先される。追加のターンごとの計算を望まない場合は false/0/off でオフにする。 |

**更新 & アドバイズリー**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `autoUpdate` | boolean | true | ACP_AUTO_UPDATE | 自動 npm バージョンチェック（約 3 分ごと）；ACP_AUTO_UPDATE=0 または --no-auto-update で無効化。 |
| `autoRestartOnUpdate` | boolean | false | ACP_AUTO_RESTART_ON_UPDATE | 新しいバージョンがインストールされた後、デーモンを自動的に再起動する。 |
| `updateTag` | string | latest | ACP_UPDATE_TAG | セルフアップデート用の npm dist-tag チャンネル：latest（デフォルト）、dev、または pr。 |
| `update` | object | {} (all defaults) | — | セルフアップデートのチャンネル設定。 |
| `update.registry` | string | "npmjs" (registry.npmjs.org) | BILI_UPDATE_REGISTRY | セルフアップデート用のカスタム npm レジストリベース URL（プライベートミラー）。 |
| `update.checkIntervalMs` | number | 180000 | BILI_UPDATE_CHECK_INTERVAL_MS | npm レジストリのバージョンチェックの間隔。 |
| `update.staggerMinDelayMs` | number \| string | 900000 (built-in 15 min) | BILI_UPDATE_STAGGER_MIN_MS | #3619 スタグダードロールアウト: このマシンのベースアップグレード遅延ウィンドウの下限; ms 数値または期間文字列 (15m / 2d / 1d12h); 0 で遅延を無効化 (従来の即時実行)。リモートポリシーのデフォルトウィンドウとバージョン別の上書きがこれに重ねて適用される。 |
| `update.staggerMaxDelayMs` | number \| string | 172800000 (built-in 48 h) | BILI_UPDATE_STAGGER_MAX_MS | #3619 スタグダードロールアウト: このマシンのベースアップグレード遅延ウィンドウの上限; ms 数値または期間文字列 (48h / 2d); min とともに 0 に設定すると従来の即時アップグレードに戻る。 |
| `update.policyUrl` | string | official repo raw URL | BILI_UPDATE_POLICY_URL | リモート自動更新ポリシーファイルの URL 上書き (テスト用シーム — 本番環境では公式リポジトリに固定される)。 |
| `advisoryCheck` | boolean | true | BILI_ADVISORY_CHECK | 重大な欠陥に関するアドバイザリーウォッチャー; 実行中のバージョンが影響を受ける場合、推奨される修正を強制インストールする。 |
| `advisoryUrl` | string | unset (built-in feed) | BILI_ADVISORY_URL | アドバイザリーフィードの URL 上書き。 |
| `remoteAnnouncementsUrl` | string | unset (official feed: GitHub master announcements/remote.json) | BILI_ANNOUNCEMENTS_URL | リモートアナウンスメントフィードの URL 上書き (#5548): JSON ドキュメント {v: 1, entries: [...]} — ローカルアナウンスメントファイルと同じレコードスキーマ。他のウォッチャーと同様に約 3 分ごとに取得され、キャッシュされたスナップショットは再起動や障害後も維持される。ファイアウォールインストールではこれをリレーミラーに向ける。不正なプッシュは拒否され、最後に正常だったコピーが表示され続ける。`<config dir>/announcements/*.json` 内のローカルファイルは、同じ ID のリモート/組み込み通知を常にシャドウする。 |
| `releaseNotesCheck` | boolean | true | BILI_RELEASE_NOTES_CHECK | Web パネル用のリリースノートフィード (取得とキャッシュのみ; 何もインストールしない)。 |
| `releaseNotesUrl` | string | unset (built-in feed) | BILI_RELEASE_NOTES_URL | リリースノートフィードの URL 上書き。 |

**診断 & チューニング**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `diagnostics` | object | {} (all defaults) | — | ローカルトラブルシューティング用ノブ（ダンプ、レンダリング/インジェクションのトグル、count-tokens のパススルー）。 |
| `diagnostics.dumpBody` | boolean | false | ACP_DUMP_BODY | トラブルシューティングのために、完全なリクエスト/レスポンスボディをログにダンプします。ダンプは PLAINTEXT であり、認証情報が含まれる可能性があります — 共有前にスクラブしてください（#4482）。 |
| `diagnostics.dumpReq` | boolean | true | ACP_DUMP_REQ | 呼び出しごとに送信されるアップストリームリクエストのメタデータをログに記録します。dumpBody がオンの場合、PLAINTEXT ボディのダンプも制御します（共有前にスクラブしてください、#4482）。 |
| `diagnostics.rawDumpDir` | string | <state dir>/raw | ACP_RAW_DUMP_DIR | 生ワイヤダンプのディレクトリ。 |
| `diagnostics.dump4xx` | boolean | false | BILI_DUMP_4XX | 事後検証のために、アップストリームの 4xx レスポンスをディスクに永続化します。ボディは PLAINTEXT であり、認証情報が含まれる可能性があります — 共有前にスクラブしてください（#4482）。 |
| `diagnostics.dump4xxMaxBytes` | number | 2097152 (floor 1024) | BILI_DUMP_4XX_MAX_BYTES | 単一の 4xx ダンプファイルのサイズ上限。 |
| `diagnostics.maxTotalBytes` | number | unset (off) | BILI_DUMP_MAX_TOTAL_BYTES | デバッグダンプディレクトリ（dumps/、raw/、SSE ダンプディレクトリ）の総サイズ上限。超過時は最も古いファイルから削除されます（下限 1 MiB）。デフォルトではダンプにローテーションがなく、アクティブなキャプチャ下では 1 日に数十 GB まで増加する可能性があります（#2412）。 |
| `diagnostics.maxAgeDays` | number | unset (off) | BILI_DUMP_MAX_AGE_DAYS | デバッグダンプディレクトリの日数ベースの年齢上限。これより古いファイルは削除されます（下限 1 h）。デフォルトではオフです。 |
| `diagnostics.logRetentionHours` | number | 48 (floor 1) | BILI_LOG_RETENTION_HOURS | PRIVATE 実行ログ（`bili.log`）を保持する時間（時間単位）で、カバーする範囲を指定します。ロガーはアクティブファイルを 10 MiB でシールし、1 つの `bili.log.old` ではなく、不変で一意の名前を持つジェネレーションに変換するため、保持されるすべてのジェネレーションが列挙可能であり、ウィンドウは偶然ではなく実在のものとなります。これは TARGET であり、約束ではありません：`diagnostics.logBudgetBytes` がハードバウンドであり、常に優先されます — より短いウィンドウは報告されますが、完全にカバーされていると黙って主張されることはありません。報告されるカバレッジは、最も古い保持行から現在までの測定されたスパンです。ジェネレーションファイルには系譜のエビデンスがないため、`continuity` は常に `unknown` となり、未断絶のウィンドウを主張するステータスはありません（順序が乱れたタイムスタンプも、履歴の欠落として扱われません）。下限 1 h。正でない値または数値でない値は 48 h のデフォルトにフォールバックし、SET された環境変数がスイッチを所有するため、不正な `BILI_LOG_RETENTION_HOURS` はこのキーではなくそのデフォルトにフォールバックします。 |
| `diagnostics.logBudgetBytes` | number | 268435456 (256 MiB, floor 1 MiB) | BILI_LOG_BUDGET_BYTES | アクティブログおよびすべてのシール済みジェネレーション全体でのハードな総バイト予算。超過時は最も古いジェネレーションから削除されます — シール済みタイムスタンプ順に最も古いものから（レガシーの `.old` は独自の mtime を採用）ため、移行されたレガシー成果物は新しいタイムスタンプ付きジェネレーションを優先してスキップされるのではなく、実際の年代順の位置で回収されます。デフォルトのウィンドウがこれの何倍にも及ぶ多忙なマシンにおいて、ディスクコストとプライバシーリスクを制限します。`logRetentionHours` に必要なバイト数が予算を超える場合、BUDGET が優先され、不足分が表面化します（開始時の `[warn]`、および `GET /__bili/logs` の `retention` オブジェクト）。ACTIVE ファイルは決して削除されないため、単一のアクティブファイルが予算を単独で超過する場合、切り詰められるのではなく予算超過として報告されます。下限 1 MiB。正でない値または数値でない値は 256 MiB のデフォルトにフォールバックし、設定された `BILI_LOG_BUDGET_BYTES` は時間キーと同様にスイッチを所有します。ファイルは所有者のみアクセス可能：最初のバイトから 0600、アーカイブディレクトリは 0700（win32 には POSIX モードビットがなく、state-dir の ACL が支配します）。 |
| `diagnostics.renderNone` | boolean | false | ACP_RENDER_NONE | すべての ACP タグレンダリングを無効化します（生ワイヤ研究モード）。 |
| `diagnostics.invariantJudge` | boolean | true | BILI_INVARIANT_JUDGE | I1/I2 送信不変性ジャッジを L1 アドバイザリーとして武装したままにします（#3938）：すべてのリクエストの送信バイトがクライアントの受信履歴と照合されます。違反は warn でログに記録され、クリーンな判定は debug で記録され、トラフィックはブロックされません。無効にするには false を設定するか BILI_INVARIANT_JUDGE=0 を設定してください。 |
| `diagnostics.noInjectTool` | boolean | false | ACP_NO_INJECT_TOOL | リクエストへの acp_compress ツール定義のインジェクションを停止します。 |
| `diagnostics.noCompressPrompt` | boolean | false | ACP_NO_COMPRESS_PROMPT | システムプロンプトへの圧縮教義の追加を停止します。 |
| `diagnostics.countTokensPassthrough` | boolean | false | ACP_COUNT_TOKENS_PASSTHROUGH | ローカルで応答する代わりに、/v1/messages/count_tokens をアップストリームにフォワードします。 |
| `diagnostics.compressProtocol` | "tools" \| "marker" | "tools" | ACP_COMPRESS_PROTOCOL | 圧縮用の ACP 注入サーフェス: ネイティブツール (デフォルト) またはレガシープロンプトマーカー。 |
| `fakeCompletion` | object | {} (all defaults) | — | 最終チャンクが切り詰められて到着した際に再リクエストを行うリトライループ。 |
| `fakeCompletion.retries` | number | 0 (opt-in) | BILI_FAKE_COMPLETION_RETRIES | 切り詰められた最終完了を再リクエストできる回数; 0 でループを無効化。 |
| `fakeCompletion.bufCapBytes` | number | 16777216 | BILI_FAKE_BUF_CAP | リトライループの累積ストリームに対するバッファサイズ上限。 |
| `codexCompact` | "intercept" \| "pass" | "intercept" | BILI_CODEX_COMPACT | bili 内で Codex のコンパクト化要求を処理する (intercept, デフォルト) または上流へ転送する (pass): 明示的な形式 (compaction_trigger + /responses/compact) と、通常のターンとして通過するインライン自動コンパクト化 (SUMMARIZATION_PROMPT テンプレート (#3008) によって検出) — ユーザーが上書きした compact_prompt は検出から外れ、そのまま通過する; bili が観察のみ (pass/gate) したコンパクト化は事後にリベースされる (#2372)。 |
| `ccrRetrievalTtlMs` | number | 600000 (0 disables retrieval) | BILI_CCR_RETRIEVAL_TTL_MS | acp_retrieve 経由でオリジナルを取得できなくなるまでの CCR 検索ポインタの生存期間。 |
| `decompressTmpCap` | number | 50 | BILI_DECOMPRESS_TMP_CAP | セッション内で保持される一時的な展開済みコンテンツのサイズ上限 (ブロック数)。 |

**圧縮（グローバルレベル）**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `compress.modelContextLimit` | number \| "N%" | native window (model-declared) | — | 有効コンテキストウィンドウ（トークン数または N%）：使用率の分母であり、事前チェックのハードウォール。最優先のウィンドウソース。 |
| `compress.maxContextLimit` | number \| "N%" | "75%" | — | 強制圧縮のナッジ閾値：履歴がこのウィンドウの割合を超えると、ナッジが即座に発火し、成長ゲートをバイパスする。ハードキャップではない。 |
| `compress.emergencyThresholdPercent` | number \| % | "95%" | — | 履歴がこのウィンドウの割合を超えた場合の、過大ツール出力の緊急切り詰め（maxContextLimit 以上である必要がある）。 |
| `compress.outputHeadroomMaxPct` | number \| % | 0.25 | — | max_tokens 経由で出力に確保されるウィンドウの割合の上限。 |
| `compress.nudgeGrowthTokens` | number | 50000 (kernel flat cadence) | — | 成長ゲート：折りたたみ可能な範囲がベースライン成長をこのトークン数だけ上回った場合のみ、ナッジが発火する（設計上フラットであり、ウィンドウサイズに依存しない）。 |
| `compress.tierNudgeTokens` | object {t1?, t2?, t3?} | derived (T1 = nudgeGrowthTokens, T2/T3 = ×1.5) | — | ティアごとのトークン質量トリガー閾値。未設定のティアは導出デフォルトにフォールバックするため、欠落/空 = レガシー統合動作 (#2376)。 |
| `compress.minPressureBenefitTokens` | number (≥ 0) | max(5000, limit × 1%) | — | 圧力バンドのナッジが発火するために必要な最小の回収可能トークン数。インフレ計器ルートでは、高頻度の小規模な churn の代わりに、大きなイベントに折りたたみをバッチ処理するようにこれを引き上げる (#3211)。明示的な 0 = レガシーの任意の保留中。 |
| `compress.requireUsageSampleForPressure` | boolean | true | — | ファントム圧力ガード：このラウンドの計器がローカル推定値（請求サンプルなし — 中断されたターン、TTL 期限切れ）の場合、圧力バンドはインフレした読み取り値に基づいて EMERGENCY を発火させるのではなく、実際のサンプルを最大 compress.maxEstimateHoldRounds ラウンド（デフォルト 2）まで待機し、その後レガシーの推定駆動決定にフォールバックすることで、レポートしないアップストリームが永遠に飢餓状態にしないようにする。false = 常にレガシー。 |
| `compress.maxEstimateHoldRounds` | number | 2 | — | ファントム圧力ガードのバックストップ (#5865 裁定)：圧力バンドが推定値に基づいて発火する前に、推定グレードのラウンドを何ラウンド連続で待機できるか。使用量をレポートしないアップストリーム（匿名ゼロベースラインフォーク、サイレントバックエンド — ローカル推定値が唯一の圧力シグナルとなる場所）でも、自動圧縮が実行されるように上限が設定されている。0 = 待機なし。requireUsageSampleForPressure がオンである間のみ参照される。 |
| `compress.nudgeModelDecided` | boolean | off (unset) | — | モデル決定によるナッジタイミング (#2228)：アームされたティア 1 のナッジは、まずセッションのキャッシュ済みプレフィックス経由の短いサイドコールで、モデルに「今すぐ圧縮することが現在のタスクに有益か」を尋ねる。厳密な JSON の "yes" は、プログラムで最終化されたスパンを持つ明示的なディレクティブを注入する。"no"、不正な回答、またはタイムアウトの場合、このラウンドでは何も注入しない。EMERGENCY アームとティア 2 以上の蒸留は常にレガシーの助言を維持する。明示的に有効化されない限りオフ。 |
| `compress.nudgeDecisionMaxTokens` | number | 200 | — | nudgeModelDecided が使用するモデル決定サイドコールの出力予算（トークン数）。0 より大きい必要がある。 |
| `compress.requireNudge` | boolean | off (unset) | — | 無促のモデル主導圧縮の禁止 (#5683/#5943)：NUDGE CREDIT がライブでない限り、compress 呼び出しは拒否される — 最後にモデルに実際に到達した圧縮ナッジ（助言、決定ディレクティブ、緊急注入はすべて発行；"gated"/"vetoed"/"skipped" は発行しない）によって発行された 20 モデルラウンドのウィンドウ。各新しい注入で更新され、ナッジされないモデルラウンドごとに 1 ずつ減衰する（非モデルリクエスト形状はそれをオープンに保つ）。成功した折りたたみはクレジットを消費しないため、ナッジの推奨クリーンアップを複数ラウンドにわたって完了することは依然として合法である。拒否は、折りたたむ代わりにモデルにエラーレシートを送る。bili 自身のオーバーフローバックストップ折りたたみは免除される。自分で折りたたむモデル（例: qwen 27b）向け；プロバイダー/モデルごとにスコープを限定できる。明示的に有効化されない限りオフ。 |
| `compress.requireRecommendation` | boolean | off (unset) | — | 範囲外のモデル主導圧縮の禁止 (#5683)：提出されたすべての範囲は、bili が現在折りたたみを推奨している範囲内に留まらなければならない — ナッジテキストと acp_status が示すのと同じライブ折りたたみ可能セット（存在する場合、このリクエストの準備時オファー、それ以外の場合はライブ再計算）。判定はカバレッジによる：推奨スパンの細分化は合格し、アクティブなブロックにすでに折りたたまれたメッセージ（既存のサマリーを更新する再折りたたみ）は免除される。他のライブメッセージを含む範囲は、問題のあるスパンを特定するエラーレシートとともに全体として拒否される。明示的に有効化されない限りオフ。 |
| `compress.streamSummary` | boolean | false (unset) | — | 事前チェックの要約を、最初の試行からストリーミング（SSE）コールとして実行することを強制する。エラー駆動の自己学習は、ストリーミングを強制するアップストリームを独自に処理する（非ストリーミング要約での 400 はワンショット SSE プローブをトリガーする、#2494）が、ゲートウェイタイムアウト（例: Cloudflare HTTP 524）では決してアームしない：bili とオリジンの間にそのようなゲートウェイがある場合にこれを設定するか、単に 1 回のプローブ往復をスキップするために設定する。 |
| `compress.preserveRecentMessages` | number | 3 | — | 最新のメッセージは、折りたたみからソフト保護される。 |
| `compress.preserveRecentTokens` | number | kernel ≈5000 | — | 最新のトークンはフォールドからソフト保護される。 |
| `compress.minCompressRangeChars` | number (deprecated alias: minCompressRange) | kernel ≈5000 | — | フォールド可能な最小範囲（文字数）。これより短い範囲はフォールドされない。 |
| `compress.maxSummaryLength` | number | kernel 20000 | — | 1つの生成サマリーに対する文字数のハード上限。これを超える返信は全体として拒否される（切り詰めもリトライもされない）。外部サマライザーにはこの正確な上限が事前に通知される（#3635）。0 = 無制限。 |
| `compress.minSummaryLength` | number | kernel 50 | — | 生成サマリーの文字数下限：単一範囲はこれに単独で達する必要がある。複数範囲のバッチは、その結合サマリーがこれに達した場合に合格する（#5894）。0 = 無効。外部サマライザーはサマリーごとの下限に引き続き従う（#3635）。 |
| `compress.reconcile` | "off" \| "warn" \| "repair" | "repair" | BILI_FOLD_RECONCILE | クライアントがターン間で履歴を巻き戻しまたは書き換えた場合、フォールド状態を調整する。 |
| `compress.promptPack` | string (builtin: "default", "lean") | builtin "default" | — | 圧縮プロンプトパック。解決順序はプロジェクトパック → ユーザーパック → ビルトイン。`acknowledgePromptsRisk` によるゲートはされない。 |
| `compress.tiers` | boolean | true | — | T1→T3 の階層型蒸留により、フォールドコストを世代間で分散する。 |
| `compress.protectedTools` | string[] | none | — | 全履歴に対するハード除外：リストされたツールの結果は決してフォールドされない。パスパターン（`skill/<name>`）は名前でスキルを選択する（#1947）。 |
| `compress.protectedLatestTools` | string[] | none | — | 最新の結果が古いものを上書きする累積スナップショット型ツールの最新インスタンスのみを保護する（例：todo リスト）。パスパターンはスキルごとに最新インスタンスを保持する（`skill/*`, #1947）。 |
| `compress.neverPreserveRecentTools` | string[] ([] valid) | ["decompress", "search_context", "read", "bash"] (kernel) | — | 最近保護ゾーンから除外（即時圧縮可能）。空の配列は何も除外しない（最大保護）。 |
| `compress.preserveRecentTools` | string[] | n/a (subtraction form) | — | 減算形式：最近ゾーンツールからこのリストを引いたものが完全保護される。ここでの空の配列は誤記として拒否される。 |
| `compress.visibilityMarkers` | boolean | true | — | `compress`/`decompress`/`search_context`/`acp_status` の結果後に可視性マーカーを追加。オフにすると模倣ナレーションが停止する。 |
| `compress.messageTimestamps` | boolean | true | BILI_MESSAGE_TIMESTAMPS | 圧縮メッセージレコードに不変の壁時計タイムスタンプを付与：ワイヤー上の ACP タグに `time=`、`compress` 受領証に `[start – end]` カバレッジスパン、サマリーに `Occurred` 行。デフォルトで ON：各メッセージに1つの不変な初回表示スタンプが決定論的にレンダリングされるため、再レンダリングされた履歴はバイト安定性を保つ（有効化時の再起動によるプレフィックス書き換えを超えるプロンプトキャッシュコストなし）。`false` に設定すると、#4313 以前のバイトを正確に再現する。 |
| `compress.rules` | boolean | false | — | 注入された `acp_rule` ツールを通じて配信される永続モデルリマインダー。フォールドからハード保護される。`pi/omp` は `/acp-rule` コマンドを公開する。プロキシモード専用 — プラグインモードでは無効であり、ホストがツールサーフェスを所有する。 |
| `compress.injectTool` | boolean | true | ACP_COMPRESS_TOOL | クライアント向けに `acp_compress` ツールを登録（グローバルレベルのみ）。 |
| `compress.injectNudge` | boolean | true | ACP_COMPRESS_NUDGE | ウィンドウが埋まるにつれて成長の通知を送信する（グローバルレベルのみ）。 |
| `compress.reasoning` | { drop?, threshold? } | drop true · threshold 2048 | — | 2048文字を超える完了ラウンドの推論実行を破棄する（デフォルトで drop: true）；厳格な推論を要求するアップストリームでは drop: false が必要。 |
| `compress.absorb` | object | opt-in (disabled) | — | ツール結果を短い要約に即時蒸留するオプトイン機能；元データはコンテンツストアに保存される。デフォルトでは画像を含む結果のみが対象となる。 |
| `compress.blockOps` | object | off | — | 圧縮ブロック管理用のブロックライフサイクルツール（acp_retire / acp_restore / acp_rewrite）のオプトイン；デフォルト無効により、#5765 以前のワイヤーとバイト単位で同一を維持する。 |
| `compress.ccr` | object | enabled in proxy mode since v2 | — | コンテンツキャッシュと取得：大きな出力はセッションの隣接にロスカレスで保存され、先頭抜粋とポインタに置き換えられ、acp_retrieve 経由で取得される；上限や退避は行われない。 |
| `compress.search` | object | off | — | search_context の検索動作設定；現在、planAware リランキングを保持している。 |
| `compress.search.planAware` | boolean | false | — | オンにすると、search_context の候補が現在のプラン状態に対してリランキングされる；オフにすると、バイト単位で同一の語彙結果が維持される。 |
| `compress.prompts` | Partial<Prompts> | unset (kernel doctrine) | — | カーネル教義テキストを上書きする；品質に重要であるため、acknowledgePromptsRisk によってゲートされている。 |
| `compress.reasoningGuard` | object | off | — | gpt-5.x/6.x における推論格子の切り詰めに対する自動修復（最大3ラウンドの継続通知）。 |
| `compress.outputSteering` | object { enabled?, verbosityLevel?, effortRouting? } | enabled false · verbosityLevel 2 | — | システムプロンプトの末尾に簡潔性の指示を追加する；機械的な継続要求をクランプする。 |
| `compress.priceProfile` | { w?, r?, q? } | unset (registry, kernel fallback {1, 0.1, 4}) | — | w/r/q 比率を入力価格（書き込み/キャッシュ読み取り/出力）に対して正規化する；レポート専用であり、トリガーやワイヤーには影響を与えない。 |
| `compress.externalSummary` | object | opt-in (disabled) | — | プロバイダテーブルから参照される個別設定モデルに圧縮サマリーを送信する；3つの圧縮レベルすべてでチェーン全体の置換セマンティクスを持つ。 |
| `compress.acknowledgePromptsRisk` | boolean | false | — | カスタムプロンプトが有効になる前に true である必要がある。 |
| `compress.absorb.enabled` | boolean | false | — | 吸収蒸留ブロックを有効にする。 |
| `compress.absorb.minToolTokens` | number | 1000 | — | 吸収の対象となるツール結果の最小推定トークンサイズ。 |
| `compress.absorb.contextThresholdPct` | number \| % | unset | — | コンテキスト使用量がウィンドウのこの割合を超えた場合のみ吸収する。 |
| `compress.absorb.excludeTools` | string[] | [] | — | 吸収から除外されるツール名。 |
| `compress.absorb.toolName` | string | "absorb" | — | 吸収ツールの登録名。 |
| `compress.absorb.mediaOnly` | boolean | true | — | メディア（画像）を伴うツール結果に吸収を制限する。画像バイトはテキストにカウントされないため、minToolTokens の対象外となる。false に設定すると、従来の大規模結果の全文吸収が有効になる。 |
| `compress.blockOps.enabled` | boolean | false | — | 3 つのブロックライフサイクルツール（インジェクション + プロンプト + マニフェスト）を有効にする。Off = ツールなし、プロンプトセクションなし、リクエストごとのコストゼロ。 |
| `compress.ccr.enabled` | boolean | true (proxy mode) | — | コンテンツキャッシュおよび取得ブロックを有効にする。 |
| `compress.ccr.minToolTokens` | number | ≈4000 | — | CCR ストレージの対象となるツール結果の最小推定トークンサイズ。 |
| `compress.ccr.excludeTools` | string[] | [] | — | CCR ストレージから除外されるツール名。 |
| `compress.ccr.toolName` | string | "acp_retrieve" | — | 取得ツールの登録名。 |
| `compress.ccr.maxHeadChars` | number | 96 | — | ストレージポインタにインラインで残される最大ヘッド抜粋の長さ。 |
| `compress.prompts.compressPhilosophy` | string | unset (kernel text) | — | 圧縮哲学教義パラグラフの上書き。 |
| `compress.prompts.howToCompressRules` | string | unset (kernel text) | — | 圧縮手順ルールの上書き。 |
| `compress.prompts.tier2DistillRules` | string | unset (kernel text) | — | ティア 2 蒸留ルールの上書き。 |
| `compress.prompts.tier3CondenseRules` | string | unset (kernel text) | — | ティア 3 凝縮ルールの上書き。 |
| `compress.reasoningGuard.enabled` | boolean | false | — | 推論格子の自動修復を有効にする。 |
| `compress.reasoningGuard.maxContinue` | number | 3 | — | 切り詰めごとの最大 continue-nudge ラウンド数。 |
| `compress.reasoningGuard.maxTierN` | number | (built-in) | — | 修復済みラティス階層インデックスの上限。 |
| `compress.reasoningGuard.markerText` | string | "Continue thinking..." | — | 切り詰められた推論ラティスを示すマーカーテキスト。 |
| `compress.reasoningGuard.base` | number | (built-in) | — | 修復ラティスのベースオフセットパラメータ。 |
| `compress.reasoningGuard.offset` | number | (built-in) | — | 修復ラティスのオフセットステップパラメータ。 |
| `compress.reasoningGuard.debugLog` | boolean | false | — | 修復ループの詳細ログ出力。 |
| `compress.outputSteering.enabled` | boolean | false | — | システムプロンプト末尾に追加される簡潔性ディレクティブを有効にする。 |
| `compress.outputSteering.verbosityLevel` | number (0–4) | 2 | — | ディレクティブの目標冗長度レベル。 |
| `compress.outputSteering.effortRouting` | boolean | (built-in) | — | ディレクティブとともに努力ヒントをルーティングする。 |
| `compress.priceProfile.w` | number | unset (registry) | — | 入力価格に対する書き込み価格比。 |
| `compress.priceProfile.r` | number | unset (registry) | — | 入力価格に対するキャッシュ読み取り価格比。 |
| `compress.priceProfile.q` | number | unset (registry) | — | 入力価格に対する出力価格比。 |
| `compress.reasoning.drop` | boolean | true | — | 閾値を超える長さの完了ラウンド推論実行を破棄する。 |
| `compress.reasoning.threshold` | number | 2048 | — | 完了推論実行を破棄する文字数閾値。 |
| `compress.minCompressRange` | number | same as minCompressRangeChars | — | minCompressRangeChars の非推奨エイリアス（受け入れられ、それにマッピングされる）。 _(非推奨)_ |

**プロバイダールートフィールド**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `models` | record name → { context?, output?, compress?, benefit? } | {} | — | モデルごとの宣言: コンテキストウィンドウ、出力上限、モデルごとの圧縮オーバーライド; トラフィックフィルタではない。 |
| `models.context` | number | unset (model registry) | — | このモデル名に対して宣言されたコンテキストウィンドウトークン数。 |
| `models.output` | number | unset | — | このモデル名に対して宣言された出力トークン上限。 |
| `models.compress` | object | unset | — | このモデルのレベル3圧縮オーバーライド（グローバル→プロバイダー→モデルのマージの中で最も深い）。 |
| `models.benefit` | boolean | false | — | エコノミクス台帳において、このモデルの無料クォータ課金をマークする。 |
| `proxy` | string ("" = explicit direct) | unset | — | ルートごとのアウトバウンドプロキシURL。 |
| `compressProtocol` | "tools" (default) \| "marker" | "tools" | — | このレーンが使用するACPインジェクションサーフェス。 |
| `protocol` | "anthropic" \| "openai" \| "responses" \| "google" | inferred from the URL marker | — | このレーンのワイヤプロトコルを宣言する; クライアント側の /bili/<protocol>/ URLマーカーは宣言よりも優先される。 |
| `compress` | object (level 2) | unset | — | 任意の compress フィールドをここで上書きできます — global→provider→model マージのレベル 2 です。 |
| `compat` | { roles?, dropFields? } | {} | — | ルート単位のワイヤー互換性上書き；provider エントリはキーごとに global ブロックを優先します；dropFields は加算的に union されます。 |
| `direct` | boolean | false | — | クライアント側の除外：このアップストリームへのトラフィックは決して bili に指向されません。 |
| `passthrough` | boolean | false | — | セッション状態なしのルートスコープのバイト単位リレー — 不正防止アップストリーム向け。 |
| `imageBilling` | "auto" \| "pixels" \| "bytes" | auto (→ pixels) | — | このルートのイメージトークンカウント基準；bytes はバイトリレーに対する明示的なオプトインです。 |
| `imageTokenCap` | number | unset (uncapped) | — | このルートのイメージごとのトークンコスト上限。 |
| `resign` | scheme → { enabled?, passthrough?, credentialRef? } | {} (global map applies) | — | グローバル resign マップのルート単位のオーバーライド（レベル 2、最も深いものが優先）。 |
| `bind` | string (named entries only) | unset | — | 名前付き（非 URL）エントリをバインドされた URL レーンにエイリアスとしてディープマージ；bind なしでは名前付きエントリはルーティング無効のままです。 |
| `apiKeyEnv` | string (env var name) | unset | — | レーン認証情報オーバーライド (#2336)：このレーンにおいて、クライアントの認証情報をこの環境変数の値に置き換えます。apiKeyEnv/credentialRef のいずれか一方のみ；[Lane credentials](#lane-credentials-apikeyenv--credentialref) を参照。 |
| `credentialRef` | string (store name) | unset | — | プライベートなサマリー認証情報ストア経由のレーン認証情報オーバーライド（secret:NAME セマンティクス）。 |
| `calibration` | { disabled?: boolean, max?: number } | unset (learned k̂ applies) | — | ルート単位の k̂ 較正ポリシー (#3211)：使用量レポートが膨張するルートに対するオプトアウトまたはクランプ；[Route-level k̂ calibration policy](#route-level-k-calibration-policy) を参照。 |
| `compactionOptIn` | boolean | false | BILI_NON_HTTP_PROVIDERS | 名前付きエントリのみ：非 http(s)-baseUrl のプロバイダーを compaction 所有権にオプトイン（pi/omp レーン）；環境変数 BILI_NON_HTTP_PROVIDERS と union します。 |

**環境変数のみ（設定ファイルキーなし）**

| キー | 型 | デフォルト | 環境変数 | 説明 |
|-----|------|---------|-----|-------------|
| `BILI_DSH_AUTHORED_COMPACTION` | boolean | true (on, #3901 flip) | — | bili が dsh のコンパクト化要約呼び出しを拒否する (#3733) 代わりに、折り畳みスナップショットでローカルに ANSWER する: アイデンティティヘッダー + カーネルレンダリングされたブロック要約、ゼロエグレス; リプレイは #2432 リベースによって認識される。 |
| `BILI_DSH_CONTEXT_TAB` | boolean | true | — | dsh.contextTab (#4237) の環境変数ティア: 0/false で DSH トップバーの「上下文」/「Context」タブを削除 (その他はすべて動作維持); その他の値はファイルティアを上書きして強制オン; 未設定 = ファイルティアが適用 (デフォルト true)。次のページ読み込み / dsh 再起動時に有効化。 |
| `BILI_DSH_MAX_TESTED_VERSION` | string | 0.2.0-rc.2 (CI e2e anchor) | — | dsh ネイティブレーンのブートノート (#4545) 背後にある最新テスト済み @deepseek-ai/dsh ビルド: 実行中のクライアントビルドは、注入バンドルより上位の最も近い node_modules/@deepseek-ai/dsh/package.json から解決される; この上限より厳密に新しい場合、サポートが実装されるまでロールバックを推奨するブート時のノート (永続ログ記録 + バナー) が 1 回発行される。片方向のみ — 上限以下または等しいビルドは沈黙する (既知の旧ビルド破損モードには独自のオーバーレイラッチ検出器がある)。警告のみ — トラフィックをゲートまたはブロックしない。ビルドが検証されるにつれて上限を引き上げる; 空文字列はこのレーンでのチェックをオフにする。解決不能/解析不能なバージョンは沈黙に向けてオープンに失敗する。 |
| `BILI_IDENTITY_HARVEST` | string | off | — | 安定したメッセージ ID レーン (#5825) 向けクライアントローカルトランスクリプト/sqlite のロールアウトゲート付きループバックハーベスト。未設定/空 = OFF (完全に不活性)。`all` またはソース ID のカンマ区切りリスト (`claude,codebuddy,mcode`) は、アイデンティティがループバックであるリクエストの一致するソースを有効化する; すべての一致には `pluginLaneServerHistory` ロールアウトが ON であることも必要。判定不能なものは、ターン全体で配線前のパスにデグレード — 部分的なマッピングは決して行われない。設計上の開発/検証スイッチ (レーンはすでにクライアントごとに安全であるため)、調整ノブではない。 |
| `BILI_STORAGE_BACKEND` | sqlite\|mysql | sqlite | — | storage.backend (#3931) の環境変数ティア: sqlite (デフォルト) または mysql (完全配線済み, #3388 ステップ 2+3 - 非同期シャドウキュー経由でインジェストを保存、同期読み取りは JSON エンベロープに乗る、レプリカ/拡張/GC/フォークは非同期ツイン経由 (#4911); エクスポートも)。ファイルティアに優先する。 |
| `BILI_MYSQL_DSN` | string | unset | — | storage.backend="mysql" (#3388, #3931) 用の MySQL DSN (mysql://user:pass@host:3306/db)。ファイルキー storage.mysql.dsn に優先する。空 = mysql バックエンドが開けない; 文書化されたエラーは両方のノブを名指しする。プールは遅延で開かれる; closeQuietlyAsync はインジェストキューをドレインして閉じる。 |
| `BILI_STORAGE_ARCHIVE_AFTER_DAYS` | integer | 365 | — | GC 年齢スウィープウィンドウ (日) (#3463): これより長くアイドル状態のセッションはアーカイブされる (単一のアーカイブログ (archive/archive.jsonl) に 1 行の JSON が追記 + トombstone 行 + コンテンツ/メディア参照の解放)。0 で年齢スウィープを無効化; 手動エントリ POST /__bili/storage/gc は常に実行される。設定ファイルキー storage.archiveAfterDays が永続形式である。 |
| `BILI_STORAGE_QUICK_CHECK` | string | on | — | オープン時のストレージ整合性セルフチェック (#4175): すべての index.db オープン時にマイグレーション前に PRAGMA quick_check を実行; このブートのスキャンによって破損が証明された場合、何も自動的に移動、コピー、再構築されない (自動回復は #4609/#4626 時代に撤回: BILI_STORAGE_JSON_WRITER=off ではインデックスが唯一の永続コピーであり、自動的な移動または再構築では完全なデータ回復を保証できないため) かつ bili はそれでも起動する — JSON エンベロープからサーブし、手動修正 (バックアップしてから index.db/-wal/-shm を手動で退避し、再起動 — 新しいインデックスは JSON エンベロープから再構築される) を名指しする大きくて実行可能なアラームを発する。成功した PASS はキャッシュされ、後の起動で再スキャンをスキップする; FAIL 判定は決して永続化されない (2026-10-30 オーナーポリシー): ランタイム/バックグラウンドの発見はアラームのみ (大きなログ + ランタイムステータス、プロセスはサーブを継続 — JSON エンベロープは回復ソースのまま) であり、すべてのブートは現在のファイルセットの新しいスキャンから再決定するため、古いバージョンが残した古い FAIL が将来のブートをブロックすることは決してない。自動リネーム/修復もレガシー専用フォールバックもない: レガシー専用で続行すると、JSON エンベロープが死んだインデックスから永遠に分岐する (決して調整不能)。一時的なオープン失敗 (SQLite エンジンなし / CANTOPEN / 読み取り専用 / バックエンド DSN) は、実行可能なエラーで bili が大きく起動を拒否する — 環境問題に対するサイレントレガシーフォールバックもない (2026-10-30 オーナーポリシー; ライブな第二ライターがこの拒否リストを 2026-10-31 に残した — 1 つのローカルディスク index.db を共有することはサポートされるトポロジーであり、情報提供のみ、決してブロックしない); 真に JSON のみでサーブしたいデプロイは明示的に設定する (BILI_STORAGE_UNIFIED=legacy または未設定)。チェックのコストが重要なブート時感度の高い巨大デプロイでのみ 0 を設定する。 |
| `BILI_SNAPSHOT_SHADOW` | boolean | true (on) | — | スナップショットレンダリングのシャドウ観測可能性（#3756 のフォローアップ）: アームされたターンごとに送信スナップショットビューを計算するが使用せず、レガシー送信との差分を分類し、セッションごとのカウンターを Web パネルおよびスナップショットシャドウ診断トピックに表示する。0/false/off で無効化、1/true/on で有効化、それ以外の場合は設定ファイルの snapshot.shadow ブール値が適用される（デフォルトは on）。レンダリングレーン自体はロールアウトゲート（BILI_ROLLOUT_SNAPSHOT_RENDER）で制御されるため、シャドウレーンは送信バイト列を変更しない - これは後日のロールアウトを切り替えるためのドライラン証拠である。 |
| `BILI_CONFIG_FILE` | string | unset (XDG config path) | — | 設定ファイルのパスを上書きする（パスの再配置）。 |
| `BILI_SESSIONS_DIR` | string | unset (XDG state path) | — | セッションレコードの保存先（パスの再配置）。 |
| `BILI_ENCRYPTION_KEY` | string | unset | — | 暗号化された永続化ペイロード用の鍵材料（シークレット）。 |
| `BILI_TUNNEL_ALLOWED_HOSTS` | string[] (csv) | unset | — | MITM トンネルレーン用のホスト許可リスト。 |
| `BILI_RECLAIM_FETCH_PATCH` | boolean-ish | on | — | シャットダウン時にグローバル fetch パッチを回収するためのトグル。 |
| `BILI_CONFLICT_SCAN` | boolean-ish | off | — | インストールレーンの競合スキャナープローブを有効にする。 |
| `BILI_CHAIN_MAX_FUTURE_SKEW_MS` | number | (built-in) | — | 未来にずれたチェーンチェックポイントタイムスタンプの許容範囲。 |
| `BILI_CHAIN_RECENT_WINDOW_MS` | number | (built-in) | — | チェーンチェックポイント検証用の最近ウィンドウサイズ。 |
| `BILI_ZONE_PORT` | number | 18787 base (derived per lane) | — | レーン生成プロキシゾーン用のベースポート（ポートの再配置）。 |
| `BILI_ZCODE_ROUTE` | string | unset | — | zcode レーン用のルート選択。 |
| `BILI_ZCODE_PORT` | number | unset | — | zcode レーン用のポート固定。 |
| `BILI_ZCODE_SIGNING_FIXED` | boolean-ish | off | — | zcode 認証情報レーン用の固定署名モード。 |
| `BILI_CLAUDE_UPSTREAM` | string | unset | — | claude レーン用のアップストリーム固定。 |
| `BILI_CODEX_STATE_MODE` | string | auto | — | codex 状態の処理: auto（モダン codex では CODEX_SQLITE_HOME 経由の共有 DB、それ以外はレガシーオーバーレイコピー）、shared、または legacy。shared モードでは最大 16 個の並行セッションを処理し、それぞれに 1 つのセッション別オーバーレイスロットを使用する。legacy は同時に 1 つの排他オーバーレイを保持する。 |
| `BILI_ATTACH_HEALTH_DEADLINE_MS` | number | (built-in) | — | 外部デーモンに参加する際のヘルスチェック接続の期限。 |
| `BILI_SPAWN_WAIT_MS` | number | (built-in) | — | 新規に生成されたプロキシ子プロセスについて、ランチャーが待機を延長するまでの初期ヘルスウェイトウィンドウ（ms）。 |
| `BILI_SLOW_START_GRACE_MS` | number | (built-in) | — | まだ生存しているがバインドが遅い子プロセス（低速ストレージ、AVスキャン、共有ストレージのロック競合など）に対する追加の猶予時間（ms）。生成の総予算はこれら2つの合計である。 |
| `BILI_ATTACH_EVIDENCE_GRACE_MS` | number | (built-in) | — | アタッチ所有権の証拠に対する猶予期間。 |
| `BILI_SILENT_DIRECT_MAX_MB` | number | (built-in) | — | サイレントダイレクトの過大ガード上限（MiB）。 |
| `BILI_PROVIDER_REWRITES` | string | unset | — | ルーティング前に適用されるプロバイダーURL書き換えルール。 |
| `BILI_MCP_PROXY` | string | unset | — | 生成チャネル：プラグインホスト型ツールのMCPプロキシターゲット。 |
| `BILI_PARENT_PID` | number | unset | — | 生成チャネル：ライフサイクル監視用の親プロセスID。 |
| `BILI_STRICT_PORT` | number | unset | — | 生成チャネル：正確なポート要件（スキャッターはホッピングせず、明確に拒否される）。 |
| `BILI_UPGRADE_REPLACEMENT` | boolean-ish | unset | — | 生成チャネル：自己再起動による置換をマークする — 解放されたポートを正確に所有するか、ホッピングせずに終了しなければならない（#3044）。 |
| `BILI_OPENCODE_ACP_SPEC` | string | unset | — | 生成チャネル：opencodeネイティブレーン用のACP仕様マーカー。 |
| `BILI_LAUNCHER_MODEL_WINDOWS` | string | unset | — | ランチャーチャネル：生成されたクライアントに渡されるモデルウィンドウのオーバーライド。 |
| `BILI_LAUNCHER_LANE` | string | unset | — | ランチャーチャネル：生成元のbiliプロセスのレーンID。 |
| `BILI_LAUNCHER_PLUGIN` | string | unset | — | ランチャーチャネル：プラグインモードのハンドオフマーカー。 |
| `BILI_LAUNCHER_DIRECT` | boolean-ish | off | — | ランチャーチャネル：この起動において注入されたプロキシをバイパスする。 |
| `BILI_INHERITED_HTTP_PROXY` | string | unset | — | Launcher channel: spawn 境界をまたいで継承された http_proxy の値が保持されます。 |
| `BILI_INHERITED_HTTPS_PROXY` | string | unset | — | Launcher channel: spawn 境界をまたいで継承された https_proxy の値が保持されます。 |
| `BILI_INHERITED_ALL_PROXY` | string | unset | — | Launcher channel: spawn 境界をまたいで継承された all_proxy の値が保持されます。 |
| `BILI_INHERITED_NO_PROXY` | string | unset | — | Launcher channel: spawn 境界をまたいで継承された no_proxy の値が保持されます。 |
| `BILI_NATIVE_CLAUDE` | boolean-ish | off | — | Host posture: claude ネイティブプラグインプロセスであることを示します。 |
| `BILI_NATIVE_DSH` | boolean-ish | off | — | Host posture: dsh ネイティブプラグインプロセスであることを示します。 |
| `BILI_NATIVE_KIMI` | boolean-ish | off | — | Host posture: kimi ネイティブプラグインプロセスであることを示します。 |
| `BILI_NATIVE_OMP` | boolean-ish | off | — | Host posture: omp ネイティブプラグインプロセスであることを示します。 |
| `BILI_NATIVE_OPENCODE` | boolean-ish | off | — | Host posture: opencode ネイティブプラグインプロセスであることを示します。 |
| `BILI_NATIVE_PI` | boolean-ish | off | — | Host posture: pi ネイティブプラグインプロセスであることを示します。 |
| `BILI_PI_INLINE` | boolean-ish | inline when unset (DEFAULT-ON since #5428; explicit 0/false/no/off opts out) | — | Host posture: pi インラインレーン (#3278) — pi 拡張機能は、独自のプロキシを spawn するのではなく、擬似オリジン経由でプロセス内で圧縮を行います。プリセットの BILLION_CONTEXT_PROXY アタッチターゲットよりも優先されます。#5428 以降、デフォルトで有効 (#4687 のオプトインルールを置き換え): 環境変数とファイルが未設定の場合はインラインで実行されます。アタッチターゲットが明示されている場合でも DEFAULT より優先されるため、`bili pi` はランチャープロキシを維持します。明示的なオプトアウト = 0/false/no/off (または `"pi": {"inline": false}`) — 従来のアタッチ/spawn ポスチャを復元します。人間向けインターフェース: `bili -i/--inline pi` でインラインを強制、`bili -s/--server pi` でプロキシポスチャを固定 (継承されたインライン環境変数よりも優先)。Truthy = 0/false/no/off 以外の空でない任意の値 (on/yes/TRUE はすべて有効化)。Codex Responses WS トラフィックは、エンジンと共に起動されるループバック専用ブリッジ経由でルーティングされます。このブリッジが失敗した場合、WS レーンは DIRECT にデグレードし (警告が表示されます)、HTTP 圧縮はプロセス内で維持されます。 |
| `BILI_OPENCODE_INLINE` | boolean-ish | off (opt-in) | — | Host posture: opencode インラインレーン (#3278 ポート) — opencode プラグインは、独自のプロキシを spawn するのではなく、擬似オリジン経由でプロセス内で圧縮を行います。プリセットの BILLION_CONTEXT_PROXY アタッチターゲットよりも優先されます。オプトイン: opencode レーンは、この環境変数または "opencode": {"inline": true} が明示的に有効化されない限り、レガシーのデフォルト (spawn されたプロキシ) を維持します (#4687 におけるオーナーの決定)。Truthy = 0/false/no/off 以外の空でない任意の値 (on/yes/TRUE はすべて有効化)。Bun ホスト上で検証済み (エンジンは node:sqlite なしで起動およびディスパッチ可能)。 |
| `BILI_INLINE_DEBUG` | boolean-ish | off | — | インラインレーン (#3278) のみ: ミュート後もエンジンのログ行を stderr に保持します (インラインエンジンは pi プロセス内で実行され、stderr は対話型 TUI です。すべての [persist]/[storage]/[inline] 行が入力ボックスをスクロールさせてしまうため、デフォルトでは bili.log にのみ保持されます)。 |
| `BILI_NATIVE_ZCODE` | boolean-ish | off | — | Host posture: zcode ネイティブプラグインプロセスであることを示します。 |
| `BILI_PI_BIN` | string | pi (PATH lookup) | — | Host posture: pi クライアントバイナリの明示的なバイナリパス。 |
| `BILI_DSH_BIN` | string | dsh (PATH lookup) | — | ホストの姿勢: dsh クライアントバイナリの明示的なバイナリパス。 |
| `BILI_MODEL_INFO_RETRY_MS` | number | (built-in) | — | テストフック: モデル情報の参照におけるリトライ間隔。 |
| `BILI_DSH_RETRY_INTERVAL_MS` | number | (built-in) | — | テストフック: dsh レーン操作におけるリトライ間隔。 |
| `BILI_DSH_RECOVERY_INTERVAL_MS` | number | (built-in) | — | テストフック: dsh レーンのリカバリスウィープ間隔。 |
| `ACP_DUMP_DIR` | string | unset | — | ワイヤダンプ出力のベースディレクトリのオーバーライド（パスの再配置）。 |
| `BILI_STREAM_STALL_MS` | number | (built-in) | — | コミット済みアップストリームストリームのストール検出タイムアウト（中断前の無バイト沈黙）。 |
| `BILI_CLIENT_BIN` | string | unset (PATH lookup) | — | 起動するクライアントの明示的なバイナリオーバーライド（PATH で解決）。 |
| `BILI_CONVERSATION_ID` | string | unset (per-spawn UUID written by bili) | — | セッション ID を渡さないホストを持つ MCP 子プロセスに渡す、スポン時に生成される会話 UUID（ヘッドレス自己登録）。 |
| `BILI_LAUNCHER_MODEL_MAX_OUTPUTS` | string (JSON id→maxOutput map) | unset | — | ランチャーチャネル: 出力ヘッドルームの予約のためにスポンされたプロキシに渡す、モデルごとの最大出力マップ。 |
| `BILI_LAUNCH_TOKEN` | string | unset (generated per launch) | — | ランチャーとそのスポンされたプロキシ間のレーン内部エンドポイントを認証するランチャートークン（シークレット）。 |
| `BILI_MCP_DEFAULT_ORIGIN` | string | http://127.0.0.1:8787 | — | MCP エントリポイント用のフォールバックプロキシオリジン候補。 |
| `BILI_MCP_NO_ORPHAN_ADOPT` | boolean-ish | off (=1 disables orphan adoption) | — | 複数のホストセッションが 1 つのプロキシを共有する場合、再開セッションの孤児採用を無効にする。 |
| `BILI_MITM_HOSTS` | string[] (csv) | unset | — | ランチャーチャネル: スポンされたプロキシに渡す MITM ホワイトリストホスト（設定ファイルの双子 BILI_MITM_DOMAINS とは別物）。 |
| `BILI_PLUGIN_AGENT` | boolean-ish | off | — | スポンチャネル: プラグインエージェントプロセスを示す。 |
| `BILI_IMAGE_RESCALE_MAX_DIM` | integer | 1600 | — | エグレス画像のダウンスケールパスのトリガー閾値（px）（#3400）; 数値でない場合または 128 未満の場合は無視される（デフォルトが適用される）。設計上、環境変数のみ。 |
| `BILI_PLUGIN_BYPASS` | string | auto (unset = the inbound header decides) | — | x-bili-plugin-bypass パススルー判定のオペレーターオーバーライド（#6220）、リクエストごとに読み取り（再起動不要）。3 状態：未設定（または auto）= 現状 — 受信ヘッダーがリクエストごとに判定（legacy opencode-acp セッションはバイパス、その他はフルパイプライン）；1/on/true = 強制バイパス — すべての受信リクエストをそのまま転送（ツール注入なし、nudge なし、セッションバインドなし）；0/off/false = 常にバイパスしない — 受信 x-bili-plugin-bypass ヘッダーをすべて無視し、legacy opencode-acp セッションもフルパイプラインを通過。識別できない値は auto（= 現状）として扱われます。#6220 の owner 承認デザインにより環境変数のみ（ヘッダーはホストがスタンプするワイヤー契約であり、オーバーライドはプロセス単位のオペレーター姿勢であり、ルート単位の設定フィールドではない）。 |

<!-- /bili:gen -->

---

## サーバー設定

プロキシのリスニング方法とグローバルな動作を制御するトップレベルのキー。

### `port`

- **型:** `number`
- **デフォルト:** `8787`
- **ステータス:** ACTIVE
- **説明:** プロキシがリスニングする TCP ポート。1 から 65535 までの整数でなければなりません。`ACP_PORT`（または `PORT`）環境変数、または `--port` CLI フラグによって上書きされます。無効な値は起動を中断します。これは**ユーザーゾーン**（`bili start`、デフォルト `8787`）であり、このポートはユーザーが管理します。レーン生成プロキシ（ネイティブフック、ランチャーレーン）は、別の自己管理ゾーン（`BILI_ZONE_PORT`、デフォルト `18787`）に存在し、このポートには決してアクセスしません（#1660）。

### `host`

- **型:** `string`
- **デフォルト:** `127.0.0.1`
- **ステータス:** ACTIVE
- **説明:** プロキシがバインドするネットワークインターフェース。`127.0.0.1`（デフォルト）はローカルホストでのみリスニングします — ローカルサイドカーには安全です。IPv4 + IPv6 デュアルスタックには `::` を使用します。プロキシを他のマシンに公開するには `0.0.0.0`（または LAN IP）を使用します — 通常はコンテナ内や信頼できる LAN 内で使用します: リモートエージェントはモデルの `baseURL` を `http://<this-host>:<port>/bili/…` に設定し、MITM モードの `CONNECT` はホワイトリストに登録されたモデルホストのリモートクライアントのみを受け入れます（ブラインドトンネルはループバックのみに制限され、`/__bili/` 管理エンドポイントは以下の埋め込みホストリレーが有効化されない限りループバックのみに制限されます）。認証はありません — 周囲のネットワークが信頼できることを確認してください。`ACP_HOST` / `--host` によって上書きされます。

### `upstream`

- **型:** `string` (ベース URL)
- **デフォルト:** `https://api.anthropic.com`
- **ステータス:** ACTIVE
- **説明:** パスのみのモデルリクエスト用のフォールバックベース URL: ホストなしで `/v1/messages` に POST するクライアントは `${upstream}/v1/messages` に転送されます。末尾のスラッシュは削除されます。`ACP_UPSTREAM` によって上書きされます。また、`GET /__bili/health` でも `upstream` として報告されます。

### `sessionHeader`

- **型:** `string`
- **デフォルト:** `x-acp-session`
- **ステータス:** ACTIVE
- **説明:** クライアントが会話の識別に送信できる HTTP リクエストヘッダーの名前。同じ値を持つリクエストは、呼び出し間で圧縮状態を共有します。`ACP_SESSION_HEADER` によって上書きされます。

### `log`

- **型:** `boolean`
- **デフォルト:** `true`
- **ステータス:** ACTIVE
- **説明:** リクエストごとのログ出力を有効にします。`false`（または `ACP_LOG=0`）に設定すると、標準のリクエストログを無音にします。

### `logFile`

- **型:** `string`
- **デフォルト:** XDG ステートパス (`~/.local/state/billion-context/bili.log`)
- **ステータス:** ACTIVE
- **説明:** プロキシのティールログ（ファイル + stderr）の場所。`"off"` に設定すると、ファイルログ出力を完全に無効にします（stderr のみ）。10 MB で `bili.log.old` に自動ローテーションします。設定されている場合、`ACP_LOG_FILE` によって上書きされます（空の値はオフではなくデフォルトパスに解決されます）。

**ログの場所とクリーンアップ。** ログファイルは 2 つあります:

1. `~/.local/state/billion-context/bili.log` — 共有インスタンスログ（このマシン上のすべてのプロキシがここに追記します; 各行に `[v=<version>]` と `[sess=<id>]` タグが付与されます）。10 MB でローテーションし、`.old` 世代を 1 つ保持します。
2. `%TEMP%/bili-proxy-<port>.log` (`os.tmpdir()/bili-proxy-<port>.log`) — ランチャー生成プロキシ（`bili dsh`、pi/claude/codex オーバーレイなど）のみに作成されます。これらのプロキシは、起動プロセスによって stdout/stderr がこのファイルにリダイレクトされて実行されます。#2864 以降、生成された子プロセスは上記のファイルレグがライブになると stderr レグをミュートするため、このファイルにはロガー前のクラッシュ出力のみが含まれます（通常はほぼ 0 バイトです）。オープン時に上限が設定され、5 MB に達すると、次の生成時に `.old` にローテーション（1 世代保持）されてから再オープンされます。それ以外は OS の一時ディレクトリのクリーンアップポリシーが適用されます — スクラッチスペースとして扱い、古いファイルを自由に削除してください; 永続的な記録（それは `bili.log` です）を保持することはありません。

### `debug`

- **型:** `boolean`
- **デフォルト:** `false`
- **ステータス:** ACTIVE
- **説明:** 詳細なログ出力 — `ACP_DEBUG=1` を設定するのと同じです。ルーティングや圧縮動作の診断に有用です。

### `passthrough`

- **型:** `boolean`
- **デフォルト:** `false`
- **ステータス:** ACTIVE
- **説明:** すべてのリクエストを、圧縮、ツール注入、ナッジング**なし**でアップストリームに転送します。`ACP_PASSTHROUGH=1` と同等です。非圧縮ベースラインとの A/B 比較に便利です。

### `compactionOptIn`

- **型:** `boolean`
- **デフォルト:** `false`
- **ステータス:** ACTIVE
- **説明:** `#1392` — **非 http(s) baseUrl プロバイダー**（例: pi-claude-bridge のリテラル `"claude-bridge"`）を、bili のコンパクション所有権の考慮対象にオプトインします。エントリの KEY はプロバイダー ID です — 非 URL のキーはそれ自体ではルーティングに対して不活性です（実際のレーンにするには [`bind`](#named-provider-entries-bind) を与えてください）、そして pi/omp プラグインが非 http baseUrl を即座に拒否しようとする際に参照する、ランチャーがエクスポートする `BILI_NON_HTTP_PROVIDERS` ホワイトリストにのみ供給されます（#1383）。オプトインは候補セットを広げるだけです: コンパクションは、積極的な搬送証拠（プラグインがセッションにスタンプを押した、または `/__bili/plugin/status` がプロキシがそれを保持していることを確認した）がある場合のみキャンセルされます。環境変数同等: `BILI_NON_HTTP_PROVIDERS=a,b`（ファイルとの和集合、重複排除）。`bili pi` / `bili omp` ランチャー、または直接インストールされたプラグインの下でのみ意味があります。

  ```jsonc
  {
    "providers": {
      "claude-bridge": { "compactionOptIn": true }
    }
  }
  ```
### `compat`

- **Type:** `{ roles?: Record<string, string>; dropFields?: string[]; streamErrorShape?: "protocol" | "completion"; noCacheControl?: boolean; keepResponseId?: boolean }`
- **Default:** `{}` (無効)
- **Status:** ACTIVE
- **Description:** グローバルなワイヤー互換ロールマップ。`roles` はメッセージのロールを、アップストリームが受け入れるロール名にマッピングします。例: `{"compat":{"roles":{"developer":"system"}}}` は、`developer` ロールを拒否するアップストリーム（#552、新しい codex クライアント）に対して、最終転送ボディ内で `developer` → `system` に書き換えます。`openai` の chat-completions と `responses` リクエストに適用されます。完全一致するロールのみ対象であり、ボディ内の他の部分は変更されません。再送信される compress-retry ボディにも同じ書き換えが適用されます。プロバイダーごとの `compat.roles` エントリ（[Providers](#providers) 参照）はキーごとに優先されます。デフォルトの `{}` では、ボディはバイト単位で変更なしに転送されます。
- **Learn-on-failure:** compat が設定されていない場合、アップストリームからの `400 Invalid role: …` は自動修正されます — bili は問題のあるロールを `system` に書き換え、1回リトライし、そのマッピングを**セッションスコープ**（セッション内のメモリ上；設定ファイルには書き込まれない）で記憶します。そのセッション内の後続のリクエストでは、400 の往復がスキップされます。修正が発火した際に出力される情報ログには、恒久的なプロバイダーごとのスニペットが含まれます。
- **dropFields:** 最終転送ボディから削除するフィールドのドットパスリスト — クライアントが常に送信するがアップストリームが受け付けないフィールドを拒否する厳格スキーマのアップストリーム向け（#1757）。パスはプレーンオブジェクトのセグメントのみ使用可能（`reasoning.summary`）；ワイルドカードと配列インデックスはサポートされていません；存在しないパスや非オブジェクトの中間要素はサイレントにスキップされます；文字列値は決して検査・変更されません — 構造キーのみ対象であり、ツール引数やメッセージコンテンツはバイト単位で正確に保たれます。`roles` と異なり、すべてのワイヤープロトコル（任意の JSON リクエストボディ）に適用されます。グローバルとプロバイダーごとのリストは**加算的に**（和集合）マージされます — プロバイダーエントリはパスを追加できますが、グローバルのものを撤回することはできません。最終送信ボディのロールマッピング / 出力ステアリングの後（プロンプトキャッシュスタンプの前）に適用され、compress-retry ループが再送信するすべてのボディおよび逐語パススルー転送にも適用されます。一致するフィールドのないボディはバイト単位で変更なしに転送されます；1つ以上のフィールドが実際に削除された場合、削除されたパスを記録する情報行がログ出力されます。オプトインのみ — v1 では learn-on-failure はありません: `"compat":{"dropFields":["reasoning.summary"]}`。
- **streamErrorShape:** アップストリームストリーム失敗が、200 レスポンスがすでにコミットされた後に anthropic/openai ワイヤー上でどのように提示されるか（`"protocol"`（デフォルト）または `"completion"`）。`protocol` はプロトコルネイティブの失敗チャネルに乗ります — anthropic/responses は `event: error` フレームを受け取り、openai はトップレベルの `error` フレームに続けて `[DONE]` を受け取ります — これによりクライアントは「このターンが失敗した」と「このターンが完了した」を区別し、独自のリトライロジックを維持できます（#1455: 従来の合成された `end_turn`/`finish_reason` は、死んだターンを通常の完了として装い、クライアントのリトライ予算をサイレントに消費していました）。`completion` は、インバンドエラーイベントを表面化できない SDK を持つホストのために、そのレガシー形状（合成された正常な完了内の失敗テキスト）を復元します。設定ファイル: `"compat":{"streamErrorShape":"completion"}`；環境変数 `BILI_STREAM_ERROR_SHAPE` が優先されます。google ワイヤーのみ影響を受けません（すでにネイティブエラーフレームを使用）；responses ワイヤーでは、このノブはサーバーサイドの終了を合成されたアイテムライフサイクル完了から `event: error` フレームに変更します（ループ内での終了はすでに `response.failed` 経由でネイティブでした）。
- **noCacheControl:** (`#2030`) `true` にすると、bili の Anthropic レーンでの `cache_control` ブレークポイントスタンプが無効になります — フィールドを拒否するアップストリームや、独自のブレークポイントポリシーを持つリレーのためのエスケープハッチです。環境変数 `BILI_NO_CACHE_CONTROL` が優先されます；完全なメカニクスはその[環境変数エントリ](#environment-variables)を参照してください。
- **keepResponseId:** (`#2030`) `true` にすると、カーネル再構築された Responses リクエストで `previous_response_id` を保持し、ストリップしません（デフォルトではストリップするため、再構築されたボディは、書き換えられた入力に対してアップストリームが発行しなかったレスポンス ID を参照することはありません）。環境変数 `ACP_KEEP_RESPONSE_ID=1` が優先されます。

### `proxy`

- **Type:** `string`
- **Default:** *(なし — アップストリームプロキシなし)*
- **Status:** ACTIVE
- **Description:** モデルプロバイダーへのプロキシ**自身**のアウトバウンド接続に使用されるアップストリーム HTTP プロキシ（`http://host:port`）— HTTP プロキシ経由でのみプロバイダーに到達できるホスト向け（例: GFW の背後にある `api.openai.com`；bili をローカルの v2rayA/clash HTTP ポートに向ける）。

  **解決順序（最初の一致が優先）:** URL ごとの `providers.<url>.proxy` → `BILI_UPSTREAM_PROXY` 環境変数 → Web UI の手動プロキシ → このトップレベルの `proxy` → `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 環境変数 → Windows システムプロキシ → 直接接続。自動モードは、環境/システムフォールバックに対して `NO_PROXY` と Windows プロキシバイパスリストを尊重します。bili 自身のローカルポートを指す値は、ループを防ぐために無視または拒否されます。Windows では、一般的な Clash/Mihomo の静的システムプロキシが自動的に検出されます；Web UI は有効なソースと、インターネット設定で検出された PAC URL を表示します。

  空文字列は「明示的に直接接続」を意味します — チェーン内の下位のものをオーバーライドして無効にします（トップレベル: すべてのプロバイダーに対して環境/システムプロキシフォールバックを無効化；プロバイダーごと: そのプロバイダーのみ）。

  両方のアウトバウンドパスがカバーされます: `/bili/` パスモード（fetch）および MITM CONNECT トンネル（プロキシから実際のアップストリームへの接続は HTTP CONNECT プロキシを経由します）。自動更新プログラムの自身のエグレス（npm レジストリチェック + ターボールダウンロード）は、そのホストに対して同じ判断を使用するため、npm がプロキシ経由でのみ到達可能な場所で `bili update` と自動更新が機能します（#609）。

  SOCKS5 はサポートされていません: `socks5`/`socks5h` スキームを持つ明示的な `BILI_UPSTREAM_PROXY` / 設定 `proxy` は、実行可能なエラーとともに起動に失敗しますが、そのようなスキームを使用する環境/システムプロキシは、1回限りのログ警告とともに無視されます（トラフィックは直接接続にフォールスルーします）。Clash/mihomo の場合、`http://` 経由で同じ混合ポートを使用してください（例: `http://127.0.0.1:7890`）。

  ```jsonc
  {
    // Global default: ALL providers route through this proxy
    "proxy": "http://127.0.0.1:20172",
    "providers": {
      "https://api.openai.com/v1": {
        // Per-URL overrides global (use a different proxy for this host)
        "proxy": "http://127.0.0.1:20173"
      },
      "https://open.bigmodel.cn/api/anthropic": {
        // Empty string = explicitly DIRECT, overriding the global proxy
        "proxy": ""
      }
    }
  }
  ```

### `upstreamProxy`

- **Type:** `string` (プロキシ URL)
- **Default:** *(なし)*
- **Status:** ACTIVE
- **Description:** Web UI の手動プロキシコントロールの設定ファイル上のキャリア — UI はこのキーを書き込みます（再起動後も残ります；`BILI_UPSTREAM_PROXY` はラダー上でその上位の環境層です）。明示的な `upstreamProxyMode` なしで設定された場合、有効なモードは `"manual"` となり、この値が使用されます。[`proxy`](#proxy) の解決順序において、`BILI_UPSTREAM_PROXY` とトップレベルの `proxy` の間に位置します。空文字列は未設定として扱われます。

### `upstreamProxyMode`

- **Type:** `"auto" | "manual" | "direct"` (それ以外は `"direct"` として解析)
- **Default:** *(未設定 — `upstreamProxy` が設定されている場合は `"manual"` に解決、それ以外は `"direct"`)*
- **Status:** ACTIVE
- **Description:** プロキシ自身のアウトバウンド接続の選択モード（完全なラダーについては [`proxy`](#proxy) の解決順序を参照）: `"manual"` は Web UI の手動プロキシ（`upstreamProxy`）を使用し、空の場合はトップレベルの `proxy` にフォールバックします；`"auto"` と `"direct"` はトップレベルの `proxy` を使用します；明示的に設定された `"direct"` は、補助エグレス（MITM ブラインドトンネル）のプロキシフォールバックからもオプトアウトします。モードに関係なく、`BILI_UPSTREAM_PROXY` は常に明示的なプロキシとして優先されます。`BILI_UPSTREAM_PROXY_MODE` によってオーバーライドされます。

### `imageBilling`

- **Type:** `"auto" | "pixels" | "bytes"`
- **Default:** `"auto"`
- **Status:** ACTIVE
- **Description:** インライン（base64）画像がプリフライトサイズゲートと出力クランプによってどのように課金されるか（#488/#496/#767/#1843）。`"pixels"` は、ボディをデコードせずに画像ヘッダー（PNG/JPEG/WebP/GIF/BMP）を解析し、ピクセルタイル課金を適用します（OpenAI 高詳細モデル: 512px タイル、短辺は 768px までスケーリングアップ、長辺は 2048px でキャップ → 画像ごとに 765–2805 トークン；解析できない形式はフラットな 16384 にフォールバック）。`"bytes"` は、各画像を `base64 長さ / 4` トークンで課金します — 保守的で、バイト課金リレーに対しては正しく、しかし #1843 以降は明示的なオプトインです: 不明なホストでは、従来のデフォルトがこの ±15× の推定値をすべてのウィンドウ決定に混入させ、実際の使用量がウィンドウに収まる画像中心のセッションを永続的にブロックしていました（#1800 インシデント: 6 枚のスクリーンショットが 278,161 と推定され、課金は 18,870）。リモート（`https://`）画像は、どちらのモードでも常にフラットな 4096 で課金されます。`"auto"`（デフォルト）は、すべてのホストに対して `pixels` に解決します。プロバイダーごとの `providers.<url>.imageBilling` がこのグローバルより優先され、`BILI_IMAGE_BILLING` 環境変数が両方より優先されます（ライブ読み取り、再起動不要）。

### `imageTokenCap`

- **Type:** 正の整数（画像ごとのトークン）
- **Default:** *(未設定 — キャップなし)*
- **Status:** ACTIVE
- **Description:** プリフライトサイズゲート、出力クランプ、画像圧縮統計で使用される画像ごとのトークン推定値の包括的な上限（#488/#496/#1843）。解決された課金モードの上に適用されます — ルートの実際のエンコーダーがピクセル事前分布よりもはるかに低い課金を行う場合に有用です。優先順位: `BILI_IMAGE_TOKEN_CAP` 環境変数（ライブ読み取り、再起動不要） > プロバイダーごとの `providers.<url>.imageTokenCap` > このグローバル。数値でないか正でない値は破棄されます（寛容な解析、`imageBilling` と同じ）。

### `imageRescale`

- **Type:** boolean
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** エグレス画像ダウンスケールパスのマスタースイッチ（#3295 で従来の到着時パスが削除され；#3400 で簡略化された形で再追加）。すべてのアウトバウンドリクエストにおいて、カーネル折りたたみの後、プロトコルエンコードの前に、最長辺が `BILI_IMAGE_RESCALE_MAX_DIM`（デフォルト 1600）を超えるか、base64 ボディが 100 KB を超える画像は、OUTBOUND コピーのみで fit-inside に再エンコードされます（決してアップスケールせず、元の形式を保持）— セッションストレージは元のバイトをバイト単位で正確に保持します。バイトの 20% 未満しか節約できない再エンコードは破棄されます（keep-smaller）ため、小さい/低利益の画像は変更なしに通過します。PNG/JPEG/BMP のみ処理されます（純 JS エンコーダー、ネイティブ依存ゼロ）；他の形式は通過します。各縮小画像の隣には、現在サイズと元サイズを報告する安定した注釈が付与されます；bili ツールを登録するレーン（プロキシ注入レーンとプラグインマニフェスト経由のプラグインレーン）では、`acp_read_original_image("<ref>")` も名前付けされます。これはローカルセッションストレージから元のバイトを返します — 注入ツールを拒否する codex スタイルのレーンは、サイズのみ注釈を受け取り、ツールは受け取りません。`acp_read_original_image` の結果は構造的に再縮小から免除されます（#3266 の推測-拒否-再送信疾患に対するループガード）。出力は決定論的です: 同じ入力バイトは常に同じ縮小バイトと同じ注釈テキストを生成するため、1つの履歴の繰り返し再送信はバイト安定を維持し、アップストリームプレフィックスキャッシュは乱されません。一意の画像ごとに 1 行のログ（コンテンツハッシュキャッシュ；キャッシュヒットはサイレント）。優先順位: `BILI_IMAGE_RESCALE` 環境変数（`"0"`/`"false"` で無効化；ライブ読み取り、再起動不要） > このキー > デフォルトのオン。
### `egressTransforms`

- **Type:** `array` — `{ id?, module, enabled?, priority?, match? }` エントリのリスト (#6003)
- **Default:** 未設定（トランスフォームが登録されておらず、パイプラインは完全な no-op となる）
- **Status:** ACTIVE
- **Description:** ユーザー登録可能な egress リクエストボディ書き換えパイプライン。各エントリは ESM プラグインモジュール（デフォルトエクスポート `{ transform(ctx) }`）を読み込み、その書き換えはすべての送信済みモデルリクエストボディに対して実行される。実行タイミングは、リレーレーン（メイン送信およびすべてのリカバリー再送信）と compress-loop レーンにおいて、すべてのセッション処理（shed / compress-loop 書き換え）の後、トランスポート（re-sign / v1Wrap / fetch）の前である。これにより、re-sign の不変条件が常に保たれる：署名は最終的に送信されるバイト列をカバーする。ファイルのみ（環境変数なし）；相対パスの `module` は設定ファイルが存在するディレクトリに対して解決される。
  - **Entry fields:** `id` — ログラベル；モジュール自身の `id` にフォールバックし、次にファイル名にフォールバックする。`module` — 必須；絶対パスまたは設定ディレクトリからの相対パス。`enabled` — デフォルト `true`；`false` の場合、そのエントリはスキップされる。`priority` — 数値、小さいほど先に実行；未設定の場合は設定済みのすべてのエントリより後に実行され、同値の場合は登録順で決まる。`match` — `{ urlPrefix?, provider? }`、AND 条件のスコープフィルタ；未指定の場合はすべてのアップストリーム。モジュールはデフォルトエクスポート上で `id`/`priority`/`match`/`timeoutMs` を宣言することも可能；フィールドごとに設定値が優先される。
  - **Plugin contract:** `transform(ctx)` は非同期；`ctx = { sessionId, upstreamUrl, method, url, headers (mutable copy), body, protocol, model, stage }`、ここで `stage` は `"initial"`（メイン送信）、`"retry"`（リカバリー再送信）、または `"loop"`（compress loop）である。ボディを変更しない場合は `undefined` を返し、または `{ body?, headers?, reason? }` を返す；`body` は `string` または `Buffer` でなければならない。返された `headers` は成功時のみライブヘッダーセットにマージされる；ボディバイト列が変更された場合、古くなった `content-length` は常に破棄される。
  - **Fail-open:** 例外を投げるプラグイン、タイムアウト（モジュールの `timeoutMs`、デフォルト 1000 ms）を超えるプラグイン、または不正なボディタイプを返すプラグインはログに記録されスキップされ、パイプラインは以前のボディで続行される — 1つの不良プラグインがリクエストを壊すことは決してない。読み込めないモジュールや形状が不正なモジュールも同様にスキップされる。
  - **Hot reload:** `POST /__bili/config/reload` はエントリを再読み込みしモジュールキャッシュをリセットするため、追加/削除/順序変更されたエントリや編集されたプラグインコードは、再起動なしに次のリクエストで有効になる。1つのジェネレーション内では、読み込まれたモジュールは固定される（実行中のセッションは実行中にトランスフォーム動作を切り替えない）；モジュールは mtime でバスターされるため、編集されたファイルはリロード時に再評価される。
  - **Observability:** 実際に実行された各プラグインは、1行のデバッグログ `[<sid>] [egress:<id>] stage=<stage> in=<N>B out=<M>B (<reason>)` を出力する。
  - **Known boundary:** リカバリー再送信は、すでにトランスフォームされた送信ボディからそのバリアントを導出し、パイプラインを再実行するため、非冪等な文字列トランスフォームが2回適用される可能性がある；JSON ボディを解析する構造的ラダー（image shedding、thinking-strip）は、プラグインがボディを不透明にした場合、適切に劣化し（クラッシュするのではなく中断する）。fake-completion ヒントのリトライは、独自の wrap→re-sign 順序を使用し、意図的にこのパイプラインを介さない。

  ```jsonc
  {
    "egressTransforms": [
      { "id": "tunnel", "module": "./plugins/tunnel.mjs", "priority": 10 },
      { "id": "audit", "module": "/abs/path/audit.mjs", "match": { "provider": "https://api.anthropic.com" } }
    ]
  }
  ```

### `resign`

- **Type:** `object` — スキームキー付き：`Record<scheme, { enabled?, passthrough?, credentialRef? }>`、ここで各キーはワイヤー上で検出された小文字の署名スキームトークン（組み込み：`"sdk-hmac-sha256"`；カスタム：HMAC `Authorization` トークン（例：`"aws4-hmac-sha256"`）またはボディ署名ヘッダー名（例：`"x-ofm-signature"`））
- **Default:** 組み込みの `"sdk-hmac-sha256"` キーはそのまま解決される — `enabled: true`、`passthrough: false`、`credentialRef` *(未設定 — アカウントプールの検出)*；ファイルで言及されていないスキームはこれらのデフォルトを維持する — これは組み込みでないスキームの場合、bili がそのスキームの re-signer をリリースするまで（バイナリ契約、#2090）続くローカル 403 拒否を意味する；Description を参照
- **Status:** ACTIVE
- **Description:** #1884 re-sign アーム（ボディカバー署名；現在は Huawei CodeArts APIG の `SDK-HMAC-SHA256`）の設定ファイルサーフェス。検出は SHAPE ベースであり、名前ホワイトリストではない (#2090)：HMAC 構成を名乗る任意の `Authorization` スキームトークン、または `-signature` / `-content-sha256` で終わる任意のリクエストヘッダーは、リクエストをボディ署名付きとしてマークする — すべてのゲートウェイは独自のヘッダーセットを発明する（dsh free-model プラグインは `x-ofm-signature` を同梱する）ため、クローズドルストは新しい形状を漏らし続け、他のプラグインの UI で「無効な認証情報」として表面化するサイレントなアップストリーム 401 を引き起こしていた。次に何が起きるかは、bili がそのスキームを re-sign できるかどうかによって異なる：
  - **解決可能な認証情報を持つ組み込みスキーム**（dsh codearts アカウントプール）：ゼロ設定の re-sign アーム — dsh では、credentials サービスを通じて `$DSH_HOME/jet-hub/state.json` から有効な `codearts` アカウントを検出し、生成するすべての egress ボディを re-sign するため、署名付きアップストリームでの圧縮がそのまま動作する。組み込みキーのデフォルトはまさにその動作であり、そのためスキームによるキー付けがこのフィールドを Huawei 形状のものにしない理由である。
  - **検出されたその他のすべてのスキーム**（SigV4、ゲートウェイ発明のヘッダー）：bili にはどこにも認証情報ソースがなく、re-signer 実装もないため、bili は**それを拒否する — 常に**（オーナーのバイナリ契約裁定、#2090：署名付きリクエストは RE-SIGNED+COMPRESSED されるか REFUSED され、署名なしでパススルーされることはない）。403 はスキームを名乗り、まだ設定ではリンクを動作させることができないことを明確に述べる；各拒否はステートディレクトリ（`~/.local/state/billion-context/`）の `resign-pending.json` に記憶され、bili がそのスキームの re-signer をリリースするまで、すべての後続の起動時に `[resign] … UNRESOLVED` バナーとして再生される（dsh agent レーンはプラグインロード時にも警告する）。これらのスキームに対する `passthrough` 設定は無効（INERT）である — リマインダーはブランチがアンデプロイされた場合（`enabled: false` / `BILI_RESIGN=0`、re-sign 前の書き換え処理を復元し、アップストリームは再び 401 になる可能性が高い）にのみ自動的にクリアされる。v0.1.186 (#2260) 以降、そのようなデッドキーは設定ロード時の `[acp-config]` 警告によって、デッドキーセットごとに一度だけ名指しされるため、403 ボディが唯一のシグナルではなくなった。

  このブロックは失敗/オーバーライドパス用である — すべてのフィールドについて、環境変数がファイルを優先する：
  - `enabled: boolean` — そのスキームのキルスイッチ；`false` はアームをエンドツーエンドでアンロードする（修正前の動作：署名付きボディは通常の書き換えパスを通過し、アップストリームで 401 で失敗する）。環境変数 `BILI_RESIGN=0` が優先される。
  - `passthrough: boolean` — re-sign できない場合の、そのスキームのリクエストの逐語転送。組み込みスキームのみに適用される（その拒否にはユーザー側の修正がある — 認証情報を提供すること — ため、そこでの非圧縮転送へのオプトインは実際の決定である；#1884）。その他のすべてのスキームに対して、このフィールドは無効（INERT）である：#2090 のバイナリ契約裁定により、署名付きリクエストは re-signed+compressed されるか拒否されるため、拒否をパススルーに変える値は存在しない。キーをピン留めすると署名がピン留めされる：1つのスキームを設定しても、別のスキームが開かれることはない。環境変数 `BILI_RESIGN_PASSTHROUGH=1` が優先される（組み込みの効果のみ）。
  - `credentialRef: string` — アカウントプールの検出の代わりに、re-signing に使用される dsh credentials サービスの参照をピン留めする。環境変数 `BILI_CODEARTS_REF` が優先される。

  既知スキームレジストリと可観測性：bili は `sdk-hmac-sha256`（組み込み、#1884）、`aws4-hmac-sha256`、`hmac-sha256`、および `x-ofm-signature` (#2090) に対してラベル + 出所を同梱する。登録はコミットメントであり、能力ではない：バイナリ契約の下では、すべての登録済みスキームは最終的に bili で re-signer を得なければならない — それまで、そのスキームは大きく拒否される（Web UI はそれを「re-signer サポート待ち」とマークする）；誰もまだ登録していないスキームは、サイレントに書き換えられるのではなく、形状検出によって捕捉され、同様に拒否される。保留中の拒否、スキームごとのライブ状態、未解決セットは、Web UI（`/__bili/` → Configuration → Signed upstreams (resign)）で閲覧可能、またはループバック専用の `GET /__bili/resign` から読み取れる。

  組み込み（CodeArts）の前提条件と一時的な緩和策：`sdk-hmac-sha256` re-sign アームは、bili 自身の dsh ネイティブレーンによって注入される — それは `$DSH_HOME/jet-hub/state.json`（Windows ではデフォルトで `%USERPROFILE%\.dsh\jet-hub\state.json`）を走査し、`enabled: false` になっていない `provider: "codearts"` を持つアカウントを見つけ、ホストの credentials サービス（ネイティブプラグインに公開されていなければならない）を通じて各アカウントの `credentialRef` を解決し、`{access_key_id, secret_access_key}` を返す最初のものを使用する。それらのいずれかがホストバージョンで欠落している場合（例：credentials サービスをもう注入しない DSH ビルド、または変更されたステートファイルレイアウト）、認証情報自体が有効であっても、すべての署名付きリクエストは `bili_resign_unavailable` で拒否される — それはホスト側のギャップであり、bili の誤設定ではない；正確な最小 DSH バージョンはここでピン留めされるのではなく、ホストとともに追跡される。ホストをアップグレードするまで、`BILI_RESIGN_PASSTHROUGH=1` は codearts リンクをバイト単位で無傷に復元する（組み込みスキームのみ、圧縮なし）。拒否メッセージは、設定ローダーが読むのと同じ関数によって計算された正確な解決済み設定パスを出力するため、エラーに名前が記載されたファイルを編集することは常に正しい。

  モデルレベルのノブは意図的にここにはフィールドとして存在しない — 以下の3レベルの注記を参照。

  ```jsonc
  {
    "resign": {
      "sdk-hmac-sha256": { "passthrough": false }
    },
    "providers": {
      "https://codearts.example.com": {
        "resign": {
          "sdk-hmac-sha256": { "passthrough": true }
        },
        "models": {
          "glm-5.3-flash": { "benefit": true },
          "deepseek-v4.1":  { "benefit": false }
        }
      }
    }
  }
  ```

- **Strict three levels (route-first):** #1884 のノブはリポジトリの標準カスケードに従う — 環境変数 > レベル 3 (`providers.<url>.models.<name>.benefit`) > レベル 2 (`providers.<url>.resign["<scheme>"]`) > レベル 1（グローバル `resign["<scheme>"]`）> 組み込みデフォルト — ルーティング後に解決され、[`imageBilling`](#imagebilling) と同じファミリーである：

  ```jsonc
  {
    "resign": {
      "sdk-hmac-sha256": { "passthrough": false }
    },
    "providers": {
      "https://codearts.example.com": {
        "resign": {
          "sdk-hmac-sha256": { "passthrough": true }
        },
        "models": {
          "glm-5.3-flash": { "benefit": true },
          "deepseek-v4.1":  { "benefit": false }
        }
      }
    }
  }
  ```

  - `models.<name>.benefit: boolean`（レベル 3）— このプロバイダー上のこのモデルが CodeArts の無料クォータに対して課金されるかどうか（その re-signed リクエストは署名付きの `maas_type: benefit` ヘッダーを運ぶ）。`true`/`false` は明示的である — `false` はデフォルトセットのモデルをオプトアウトさせる；未設定の場合は組み込みフォールバック `glm-5.3-flash, deepseek-v4.1-flash`（dsh codearts プラグインの `CODEARTS_BENEFIT_FALLBACK` ミラー）にフォールバックする。環境変数 `BILI_RESIGN_BENEFIT`（カンマ区切り）がツリー全体を優先する。
  - `providers.<url>.resign["<scheme>"]`（レベル 2）— 同じスキームキーの下で、グローバルブロックに対してフィールドごとにオーバーライドする `{ enabled?, passthrough?, credentialRef? }`。
  - ホスト側のインターセプト（dsh ネイティブレーン）はルーティングが存在する前に実行され、常にグローバルブロックを使用する — それはワイヤー上の必要性トリガー（署名付きボディはトンネルするか拒否されるか）であり、ポリシーではない。スキーム検索自体は大文字小文字を区別しない（ワイヤートークンは `SDK-HMAC-SHA256 Access=…` のように到着し、キーは小文字である）。
### `billing`

- **Type:** `object` — `{ prices: Record<string, { input: number, output?: number, cacheRead?: number, cacheWrite?: number }> }`, 価格は **100万** トークンあたりの USD 単位
- **Default:** `{}` (models.dev レジストリのスナップショットは、既知のすべてのモデルに価格を設定している)
- **Status:** ACTIVE (#4899)
- **Description:** Web パネルの金額表示用のモデル別請求価格。確定した使用量レポートごとに、セッション (`session.stats.costUsd`: input / cache-read / cache-write / output) に対して実行中の USD 台帳が請求される。パネルの「Saved」列は、フォールドによる節約額をドルに換算して追加表示する。モデル ID 単位の解決順序: まず `billing.prices`、次にバンドルされた models.dev スナップショット、最後に未設定 (トークンのみ — 架空のドルは生成せず、偽の `$0` も表示しない)。
  - キーはモデル ID であり、レジストリが使用するのと同じあいまいなロジックで一致する: `"anthropic/claude-sonnet-4-5"`、単体の `"claude-sonnet-4-5"`、大文字小文字の揺れはすべてヒットする。
  - `input` (100万 input トークンあたりの USD) は必須 — これが欠けた行は正直に何も請求しない; `output` / `cacheRead` / `cacheWrite` は任意であり、欠けている場合は input レートで請求される (支出推定は割引やプレミアムを勝手に発明しない — 意図的にカーネルの経済比率 r=0.1w / q=4w を使用しない)。
  - 価格はリクエストごとにスタンプされる (最新のモデルが優先される) ため、セッション中のモデル切り替えは即座に価格を再設定する; 過去の台帳エントリは請求された時点の価格を保持する (メーターセマンティクス)。
  - 無効な形状 (未知のフィールド、負またはゼロの `input`、数値でない値) はロード時にブロック全体を拒否する — タイポした価格が静かに無効になることは決してあってはならない。
  - Web エディタ (`/__bili/` → Configuration → Billing prices) は、セッションで使用されたすべてのモデルをリスト表示し、レジストリのデフォルト値を事前入力し、このブロックに保存する; 空のテーブルを保存すると削除される。

  ```jsonc
  {
    "billing": {
      "prices": {
        "anthropic/claude-sonnet-4-5": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 },
        "openai/gpt-5": { "input": 1.25 }
      }
    }
  }
  ```

### `modelContextLimit`

- **Type:** `number`
- **Default:** `200000`
- **Status:** ACTIVE
- **Description:** プロセス全体の絶対的なコンテキスト上限 (トークン数) — 最終手段のウィンドウソース: モデルに対して他のソース (ティア証拠ヘッダー、プラグイン/ランチャーのレポート、ルート別 `models.<m>.context` 宣言、レジストリ検索、組み込みテーブル) が上限を解決できない場合のみ参照される。これらは制限や上書きはしない — 例えば、ネイティブウィンドウが 1M に解決されるモデルは、この値を完全に無視する (#5908)。環境変数 `ACP_MODEL_CONTEXT_LIMIT` またはこのファイルのキーで設定する (環境変数が優先される)。[Compression Tuning](#compression-tuning) 配下の `compress.modelContextLimit` マージキーとは異なり、後者はプロバイダー別/モデル別の 3 段階カスケードに参加し、すべての解決済みソースを上書きする。

### `providersPath`

- **Type:** `string`
- **Default:** *(なし — プロバイダーはこのファイル内のインライン `providers` ブロックから取得される)*
- **Status:** ACTIVE
- **Description:** 外部 `providers.json` へのパス (インライン [`providers`](#providers) テーブルのレガシー/共有ファイル形式)。`ACP_PROVIDERS` によって上書きされる。

### `promptCache`

- **Type:** `{ routing?: "auto" | "enabled" | "disabled" }`
- **Default:** `{ routing: "disabled" }` (#5079 以降) (認識されないものは `"disabled"` として解析される; #5079 以前はデフォルトが `"auto"` だった)
- **Status:** ACTIVE
- **Description:** bili 自身の `prompt_cache_key` 送信に関する単一のスイッチ — 2 つのワイヤーを同時に管理する: チャットワイヤーのプラグインレーン本体スタンプと、Responses ワイヤーのキー注入。クライアントから提供された `prompt_cache_key` は、bili が決定するものではない: すべてのモードでそのまま転送される (egress A/B probe-and-remember は、特定の origin+model が拒否することが証明されている場合にのみそれを保留する)。プラグインレーンにおいて、バインドされた会話 ID と等しい本体キーは、bili 自身の機構がエコーバックしているもの (例: dsh の `PI_CACHE_RETENTION=long` スタック) であり、bili 自身の送信としてカウントされる。モード: `"disabled"` (デフォルト) = bili は自身のキーを書き込まない; `"auto"` = #5079 以前の動作 (チャットワイヤーはすべてのプラグインレーンリクエストでスタンプ; Responses ワイヤーはアップストリームホストが正確に `api.openai.com` の場合のみ注入); `"enabled"` = 対応するすべてのレーンでスタンプ/注入 (Responses ワイヤーは任意のホスト)。このファイル、`ACP_PROMPT_CACHE_ROUTING`、または Web UI のクイック設定スイッチで設定する。このキーでプレフィックスキャッシュをルーティングするリレー/アカウントプールアップストリームへのアップグレードでは、`"auto"` (または `"enabled"`) を設定すべき — そうでなければトラフィックがランダムにルーティングされ、プレフィックスキャッシュをミスする可能性がある; 公式 API を直接使用するユーザーはデフォルトのままにできる。

### `cacheKeepalive`

- **Type:** `{ enabled?: boolean, ttlFactor?: number, maxDurationMs?: number, maxConcurrentPings?: number, assumeTtl?: "5m" | "1h", armWithoutBreakpoints?: boolean, intervalMs?: number }`
- **Default:** `{}` (機能オフ)
- **Status:** ACTIVE (#3376)
- **Description:** Anthropic ワイヤー向けのアイドル期間中のプロンプトキャッシュキープアライブ (#3376)。Anthropic のプレフィックスキャッシュは TTL (ブレークポイントごとに 5 分または 1 時間) で期限切れになる; セッションがアイドル状態 (昼休み、一晩中) の間、次の実際のリクエストは、キャッシュされたプレフィックスのフルプライスのコールドリビルドを支払うことになる。有効化されると、bili は各セッションの最後に正常に転送されたリクエスト本体のスナップショットを撮る — アップストリームに到達した正確なバイト列、`cache_control` ブレークポイントを含む — そして、セッションがアイドル状態の間、TTL 由来の周期で `max_tokens=1` を付けて再生する; キャッシュヒット応答は、最小限の 1 回の完了のコストで TTL を更新する。すべてのピンは、アップストリーム自身の `usage.cache_read_input_tokens` に対して検証される: ヒットすると次のピンを再スケジュールする; 読み取りトークンがゼロの場合、プレフィックスはすでに死んでいることを意味し、キープアライブは停止する。
  - **Arming.** 正常 (2xx) な Anthropic ワイヤー POST のみスナップショットをアーム/更新する。パススルーリクエスト、再署名レーン (保存された署名は古いバイト列をカバーするため)、非文字列本体、64 MiB を超える本体、および `cache_control` ブレークポイントのない本体は、以下で上書きされない限りアームされない。スナップショットはメモリ内のみ: 再起動でクリアされ、次の実際のリクエストで再アームされる。
  - **Cadence.** `tier × ttlFactor`。ここで tier は、いずれかのブレークポイントが `ttl: "1h"` を宣言している場合は `1h`、それ以外は `5m`; デフォルト係数 `0.9` → おおよそ 4.5 分 / 54 分ごとに 1 ピン。`assumeTtl` (本体検出をスキップ — bili の下流で `cache_control` TTL を注入または書き換えるリレー用) または絶対的な `intervalMs` (すべてに優先) で上書き可能; `armWithoutBreakpoints: true` はブレークポイントのない本体でもアームする (`assumeTtl` と組み合わせる)。
  - **Stopping.** セッションに対する実際のリクエストは即座にキャンセルする (キャッシュ自体を更新するため); セッションに進行中のリクエストがある間にティックが着地したピンは約 5 秒遅延; `cache_read_input_tokens = 0` → 停止 (`prefix-dead`); HTTP 429 → 即座に停止; 3 回連続したその他のエラー → 停止; セッションの最後の実際のリクエストから `maxDurationMs` (デフォルト 24 時間) を超える → 停止; `maxConcurrentPings` (デフォルト 4) は同時にアームされたセッション数を制限し、最も長い間アイドルだったものを先に退避させる。
  - **Cost & observability.** ピンはプロキシパイプラインを完全にバイパスするため、`/acp-cache` ヒットレートの台帳には決して入らない (合成トラフィックはヘルス判定を汚染すべきではない) かつ、キャッシュ帰属サンプルを作成しない — ミス帰属の計算は、キープアライブなしの場合と正確に同じリクエストシーケンスに対して実行される。各アーム/ピン/ディザームは `[keepalive] …` 行をログ出力する; `acp_status` はアームされたセッションに対して `CACHE KEEPALIVE: armed tier=… cadence=… · pings=N [· last-hit Mm ago]` 行を 1 行報告する (未アームの場合は存在しない); Web UI はセッションごとのキープアライブバッジと詳細行を表示し、その生 JSON 設定エディタはこのセクションを直接受け入れる (保存時にサーバー側で検証される)。
  - **Per-provider & per-model override.** すべてのフィールドは、プロバイダールート (`providers.<url>.cacheKeepalive`) 下およびそのルートの特定のモデル (`providers.<url>.models.<model>.cacheKeepalive`) 下でも設定できる — 1 つのアップストリーム背後の異なるモデルは、異なるティア/周期で実行できる。フィールドごとに、優先順位は: 環境変数 > モデル > ルート > グローバルブロック > 組み込みデフォルト。

### `autoUpdate`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** 定期的な npm レジストリバージョンチェック (`update.checkIntervalMs` ごと、デフォルト 3 分; プロセスごとの最初のチェックはスロットリングを無視する)。設定された `updateTag` チャンネル上の新しいビルドを検出する; 実行中のプロセスが実際に切り替えるかどうかは、`autoRestartOnUpdate` (自己再起動) または助言レーン (強制インストール) に依存する。`ACP_AUTO_UPDATE=0` で無効化。`advisoryCheck` とは独立: オートアップデートをオフにしたインストールでも、助言ウォッチャーを通じて既知の壊れたバージョン範囲を回避できる。#3619 以降、発見されたアップグレードは即座に適用されない — 自動アップグレードはランダムな遅延ウィンドウ内で段階的に実行される (組み込み 15 分 – 48 時間、リモートポリシーで調整可能; 以下の [`update`](#update) を参照) ため、悪いリリースは全フリートが移動した後にではなく、ロールアウト中に捕捉できる。

### `autoRestartOnUpdate`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** オートアップデートインストール後のオプトイン自己再起動 (#811): 進行中のリクエストがゼロであることを要求し、インストール健全性チェックを通過し、10 分のクールダウンマーカーを尊重する; 失敗した場合、元のリスナーが再開される。`ACP_AUTO_RESTART_ON_UPDATE=1` (0 以外の任意の値) で有効化。

### `updateTag`

- **Type:** `string` (npm dist-tag)
- **Default:** `"latest"`
- **Status:** ACTIVE
- **Description:** オートアップデータが追跡する dist-tag チャンネル (例: `dev`)。ローリング `pr` タグは、すべての PR にわたる最新の PR テストビルドを追跡する; レガシーな PR 別 `pr-N` タグはその PR の最後のビルドで凍結されており、明示的に設定された場合のみ追跡される。`ACP_UPDATE_TAG` によって上書きされる。
### `advisoryCheck`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** 重大欠陥アドバイザリーウォッチャー (#1481): 関連パッケージ `billion-context-advisories`（`advisories/` から CI 経由で公開）をポーリングし、実行中のバージョンが宣言された破損範囲内にある場合、固定された `target` バージョン（ロールバックの場合を含む）を強制インストールします。`autoUpdate` に独立して動作するため、自動更新をオフにしたインストールでも、既知の破損バージョンからの強制更新が行われます。フェイルオープン方式: ソースに到達できない場合や形式が不正な場合は警告のみ出力し、モデルトラフィックをブロックすることはありません。`BILI_ADVISORY_CHECK=0` で無効化できます。

### `advisoryUrl`

- **Type:** `string` (URL)
- **Default:** *(設定済みレジストリ上の関連パッケージ `billion-context-advisories` — `update.registry` に準拠)*
- **Status:** ACTIVE
- **Description:** アドバイザリー文書の URL のオーバーライド。`BILI_ADVISORY_URL` によって上書きされます。

### `releaseNotesCheck`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** リリースノート可視化ウォッチャー (#1870): 関連文書 `billion-context-release-notes` を取得し、保留中のスパンに `critical` ティアのエントリが含まれている場合のみ、`acp_status` および `/acp` パネル上で "CRITICAL update ready — restart to finish" または "critical update available" を表示します。通常のリリースは表示されません（設計上サイレント、#1977）。インストールも再起動も行いません。フェイルオープン方式。`BILI_RELEASE_NOTES_CHECK=0` で無効化できます。

### `releaseNotesUrl`

- **Type:** `string` (URL)
- **Default:** *(設定済みレジストリ上の関連パッケージ `billion-context-release-notes` — `update.registry` に準拠)*
- **Status:** ACTIVE
- **Description:** リリースノート文書の URL のオーバーライド。`BILI_RELEASE_NOTES_URL` によって上書きされます。

### `security`

- **Type:** object
- **Default:** 以下のどのノブも設定されていません（すべてフェイルクローズ）
- **Status:** ACTIVE
- **Description:** セキュリティ姿勢ノブ — 意図的にオンにすることで信頼境界が拡大される設定を、監査可能な単一のブロックとして保持する場所です。ファイル専用: ここに含まれるものには `BILI_*` 環境変数の対応物がありません (#2030)。

#### `security.adminRelay` (#3373)

- **Type:** `boolean`
- **Default:** `false` (フェイルクローズ)
- **Description:** 埋め込みホスト（現在は dsh の Web パネル）が、ホスト自身の Web エントリを通じて `/__bili/` 管理サーフェスの全体をリレーすることを許可します。これにより、別のマシン上のブラウザが、プロキシがループバック以外のインターフェースをバインドすることなくパネルを開くことができます。ヘッドレスセットアップ: `dsh web` を実行し、リバースプロキシをそこに指向し、どこからでも bili タブを開きます — 設定 iframe とその API 呼び出しはエントリと同じオリジンを保ち、ホストのリレーに乗ります。仕組み: dsh 側の bili プラグインは `/__bili` プレフィックスルートを登録し、ループバックプロキシ（`127.0.0.1:18787` ゾーン）へ転送します。`/bili/origin` は `{"relay":true}` を報告し始め、パネル UI が同じオリジンの URL を構築します。また、パネル自身の API ルートはページパスから導出されるため、プレフィックスゲートウェイ（`/app/dsh/…`）でも動作します。管理ゲート自体は変更されていません (#1538): リレーされたホップは、ローカルな非ブラウザクライアントとしてプロキシに到達します — ループバックソースアドレス、ループバック `Host`、`Origin`/`Cookie`/`Referer` は転送されません — これは既存のチェックがすでに許可している形状と完全に一致します。**セキュリティ注意:** `/__bili/` は読み取り専用ダッシュボードではなく、完全な管理サーフェスです — 設定編集や認証情報の書き込みが含まれます。このフラグを有効にすると、ホスト Web エントリに到達できる者がすべてに到達できるようになるため、有効にする前にエントリを保護してください（認証 / リバースプロキシ）。リクエストごとにライブで読み取られます: ファイルの切り替えは次の呼び出しから適用され、再起動は不要です。環境変数はありません — 意図的な姿勢の決定はファイルに属します。

### `maskHosts`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** プロキシログにおけるホストマスキング (#897/#255): 非パブリックなターゲットホスト（プライベートリレー、内部ドメイン）は、ログが定期的にパブリックな issue に貼り付けられるため、そのままではなく `<private-host>` として記録されます。認証情報ヘッダーのマスキングは独立しており、常にオンです。実際のターゲットホストは、このフラグを変更せずに `GET /__bili/stats` → `blindTunnels` および `GET /__bili/health`（どちらもループバック専用）を通じて利用可能です。`BILI_LOG_MASK_HOSTS=0` で無効化できます。

### `subagentSplit`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Claude Code サブエージェントセッション分割 (#970/#4352)。このスイッチで制御される2つのメカニズム。(1) `x-claude-code-agent-id` + `x-claude-code-parent-agent-id` のペアを持つ anthropic-wire リクエストは、メインセッションのロックの後ろにキューイングするのではなく、独自の `<session>\|sub:<agent-id>` セッション（独自のロックチェーンと圧縮状態）を取得します。(2) ヘッダーなしの claude code トラフィック（VS Code 拡張ビルド。そのサブエージェントは agent-id ヘッダーを持たず、親の最初のシステムブロックを共有するため、ペアゲートが検出できない — #4352）は、コンティニュイティ認識順序リゾルバーを介してルーティングされます。継続中のメイン会話では、順序+コンテンツの証拠に基づいて生のキーを保持しますが、履歴が非連続なサブエージェントライドは独自のレーンにフォークします — bili SubagentStart フックのトークンが最初のユーザーメッセージに乗っている場合は、DISPATCH ごとにキー付けされます（`<session>\|sub:<fp>:t:<token>`）、それ以外の場合は実行の最初のユーザーメッセージの断片でキー付けされます（`<session>\|sub:<fp>:<userFp>`）。これにより、同じタイプのサブエージェントが1つの親 ID 配下で再ディスパッチされても、圧縮セッションを共有しません (#5095)。有効なトークンも使用可能なユーザーテキストもないライドは、2セグメントの `<session>\|sub:<fp>` 形式を保持します。`BILI_SUBAGENT_SPLIT=0` を設定すると、両方のメカニズムが無効になります。

> **スコープ — anthropic wire のみ。** **Responses** wire
> (`x-claude-code-session-id` が存在し、`/v1/responses` アップストリーム) を話す Claude Code は
> `claudeSubagentSplit` を通りません。そのレーンはインストラクションの
> フィンガープリントでキー付けされます（`WIRE_CLIENTS` → `claude-responses` in
> `src/server/lane-decisions.ts`）が、`subagentSplit` ではゲートされていません —
> `BILI_SUBAGENT_SPLIT=0` はそこで何もしません。そのレーンでの2つの回避方法:
> - `personaSplit: false` / `BILI_PERSONA_SPLIT=0`、または
> - `stableSystemAnchor: true`。これによりインストラクションのドリフトが予期された
>   イベントとなり、変更されたシステムプロンプトがメイン会話をフォークすることがなくなります。

### `forkAdoption`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** 匿名（プレフィックスアフィニティ）クライアント向けのフォークブロック採用 (#629): このようなクライアントが会話中に履歴をフォークした場合（編集して再送信 / 以前のターンを再生成）、新しいセッションは、フォークされたリクエストに完全に存在するソースコンテンツを持つ親の圧縮ブロックを継承し、ゼロの圧縮状態から始めて共有プレフィックスを最初から折りたたみ直す代わりに動作します。識別されたレジュームフォークはこのスイッチの対象外です — `resumeInheritance` (#1834) と一緒にブロックを採用します。採用可能なインベントリは、無効化中であってもすべての匿名フォークで記録されるため、有効化する前に利点を評価できます。`BILI_FORK_ADOPTION=1` で有効化します。

### `affinitySimhash`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** 匿名（プレフィックスアフィニティ）クライアント向けの Simhash チェーン整列採用 (#2265): クライアント側の普遍的な装飾的書き換え（モデル切り替え後、Trae がすべてのアシスタントメッセージにモデルタグを再スタンプする）が正確なハッシュチェーンを壊した場合、すべてのリクエストが新しい pfa-* セッションを生成し、ゼロから完全な履歴を折りたたみ直すことになります。この段階では、メッセージごとの Simhash スケッチを位置ごとに比較します: ハミング距離 10 以内で 90% 以上のカバレッジ、かつ 20% 以上の変異したが類似した位置（普遍的な書き換えであり、ポイント編集ではない）、さらに少なくとも1つのバイト同一の USER メッセージ（所有権アンカー — ユーザーの言葉は異なる会話間で繰り返されませんが、ハーネス機構は繰り返されることがある）があれば、既存のセッションとその圧縮状態を再アタッチします。保存されたチェーンはその後、変異したバイトに再アンカーされ、次のリクエストは再び正確な高速パスで解決されます。編集して再送信するフォークは引き続き独自のセッションを生成します (#629 の契約は維持)。識別されたチェーンは決して採用されず、曖昧さは推測を拒否します。`BILI_AFFINITY_SIMHASH=0` で無効化できます。
### `resumeInheritance`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** 識別されたクライアント向けのレジューム継承（#1486/#1834）: クライアントが自身のセッション ID（例: Claude Code の `x-claude-code-session-id`）を送信しながら、新しいセッション ID で会話をレジュームし、完全なトランスクリプトをリプレイする場合（`cc --resume` は新しい UUID をフォークする）、bili は受信履歴をバイト単位で正確に照合し、そのクライアントが追跡しているチェーン（8 メッセージ以上、追記専用トラッキング）と一致させる。レジュームされたセッションの最初のリクエストにおいて、親の参照割り当てを継承する — 古いモデル引用は、番号付けが変更されたメッセージに誤ってヒットするのではなく、元のメッセージに解決される — 完全に存在する圧縮ブロックを採用し、`derivedFrom` の系譜を記録する。親は決して変更されず、新しいメッセージは親の参照空間より上に番号付けされる。レジュームは親の履歴を厳密に拡張でなければならない — 別の ID での等深度バイト完全一致リプレイは重複であり、レジュームではない。匿名セッションは独自の pfa-* ワールドを維持する（#309）。`BILI_RESUME_INHERITANCE=0` で無効化される。

### `stableSystemAnchor`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** 安定システムアンカリング（#1085）— プレフィックスキャッシュのためのベストエフォートのワイヤー層フォールバック。根本的な修正はクライアント側（クライアントは自身の履歴を所有し、指示変更の提示方法を決定する）に属する。プレーンプロキシモードのみ: プラグインモードのエージェント（`x-bili-plugin`）はコンテキスト管理を所有しており、アンカーリングされることはない。有効化されると、bili は各セッションで最初に確認されたヘッドのシステム/指示ブロックを記憶し、クライアントのシステムプロンプトが後で変更された場合でも、それらの正確なバイトを再送信し続ける: ローカライズされた変更（これまで有効だったバージョンと 70% 以上の行を共有するファイルスタイルの編集）では、末尾に `[System context update] …` ユーザーノートを追加し、コンパクトな行差分（`-` 削除 / `+` 追加）を保持する; ローカライズされていない変更（構造的な並べ替え、ツール定義の変更、タイムスタンプ付きバナー、400 行を超えるヘッド）はそのまま採用される — 1 回の意図的なキャッシュミスは、モデルを誤解させるノイズを追加するよりも良い; 8 件を超えるノートの蓄積もまた、アンカーを最新のテキストで置き換える。アンカーとノートログはセッションメタデータと共に永続化され、圧縮/コンパクト化後も生存する。アンカリングから除外されるもの: タイトル生成マイクロリクエスト（OpenAI/Google）、Responses コンパクショントリガーリクエスト、オートモード分類器リクエスト。`BILI_STABLE_SYSTEM_ANCHOR=1` で有効化される。

### `chainContentDetection`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** bili→bili チェーン認識のボディコンテンツ検出（#1086/#1421/#1683 のフォローアップ）: 受信リクエストが圧縮アーティファクト（レンダリングタグ / 歴史的な `acp_status`+`search_context` ツール呼び出し）またはダイジェスト付きの `<bili-chain …/>` チェックポイントを BODY に持ち、かつそのセッションの `x-bili-hop` ヘッダーもローカル圧縮状態もない場合、bili は助言的な観測を記録し、および/または first-processor-wins パススルーを適用する。デフォルトで OFF である理由は、リクエスト BODY のスキャンが CCR/ファイル導入テキストやモデルがエコーするタグに対して誤検出を起こす可能性があるためであり、これらは実際のマーカーのように見える — 中間ボックスが `x-bili-hop` を取り除く狭いマルチ bili リレーケースでのみ、その誤検出リスクを受け入れて有効化すること。`x-bili-hop` シグナル自体はどちらの場合も影響を受けない。`BILI_CHAIN_CONTENT=1` で有効化される。

### `chainEgressStamp`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** モデル可視の `<bili-chain …/>` チェーン整合性チェックポイントキャリアのエグレス出力（#1683）: 有効化されると、このインスタンスが実際に処理するすべてのリクエストは、ダイジェスト付きスタンプを付けて離れ、`x-bili-hop` ヘッダーが転送中に削除された場合でも（#1421）、下流の bili が first-processor-wins を適用できるようにする。キャリアはターミナルモデルも読むスロット（OpenAI/Responses では末尾の `user` メッセージ、Anthropic/Google では末尾のテキストパート）に配置されるため、モデルはそれを幽霊ユーザー入力として扱い、コメントするためにトークンを消費する — これがデフォルトでオフである理由である。`chainContentDetection`（受信ボディ検出）および `x-bili-hop` パススルーとは独立しており、後者はどちらの場合でも機能する。上記の狭いマルチ bili リレーケースでのみ有効化すること。`BILI_CHAIN_STAMP=1` で有効化される。

### `claude`

- **Type:** `{ nativePort?: number }`
- **Default:** `{}` （レーンは自己管理ポートゾーンに乗る）
- **Status:** ACTIVE
- **Description:** claude ネイティブレーンの設定。`nativePort` はフック生成プロキシの正確なポートを固定する（#964/#1660）: 厳密なポートセマンティクス — ポート上の占有者はホッピングするのではなく、はっきりと拒否される — かつ焼き込まれた管理対象 `ANTHROPIC_BASE_URL` はそれに向く。これがない場合、レーンは自己管理ゾーン（`BILI_ZONE_PORT` ベース + レーンごとのスティッキー）に乗るため、各セッションで管理対象 URL をライブオリジンに再固定し、ポートドリフトが自己修復される。`BILI_CLAUDE_NATIVE_PORT` によって上書きされる。

### `native`

- **Type:** `{ attachExternal?: boolean; attachLanePriority?: string[]; attachPolicy?: "own-lane" | "global-fallback"; attachUrl?: string }`
- **Default:** `{}` （own-lane ポリシー; レーン付きインスタンスに対してアタッチゲートは閉じられている; 外部レーンはリストされていない）
- **Status:** ACTIVE
- **Description:** ネイティブフックのアタッチ選択（#1335, #1660, #2905, #2877）。ネイティブフックは、コード互換性がありライフサイクルゲート（`watchdog.armed == true`、または `attachExternal: true`）を通過する場合、独自のものを生成する代わりに、すでに実行されているプロキシに乗ることができる。4 つの独立したノブが、*どの* プロキシに乗るかを形成する:
  - **`attachPolicy`** （デフォルト `"own-lane"`、環境変数 `BILI_NATIVE_ATTACH_POLICY`）— レーンアフィニティ、およびクロスレーンライドが発生するかどうかのゲート。`"own-lane"`: レーン付きフックは同じレーンのデーモン**のみ**に乗る; 利用可能なものがなければ、レーンなし/手動起動の `bili start` デーモンや他のレーンのデーモンにフォールバックするのではなく、**独自のものを生成する**（その収束はすべてのエージェントを 1 つのデーモンのバージョンに固定し、セッションを二重書き込みした、#2877）。**武装済み**のレーンなしデーモン（管理対象共有プロキシ、#1225）は、どちらのポリシー下でも共有可能のまま残る。`"global-fallback"` は #2877 以前の動作を復元する: まず同じレーン、次に互換性のあるレーンなし/ユーザーゾーンデーモン（および、`attachLanePriority` と一緒に、リストされた外部レーン）。
  - **`attachLanePriority`** （#2905、ファイルのみ、環境変数なし）— 独自のレーンインスタンスが存在しない場合、このフックが乗れる外部レーン名の順序付きリスト。クロスレーンライドが許可されている場合（つまり `global-fallback` 下）、アタッチ優先度は: まず独自のレーン → リスト順のレーン → ユーザーゾーンは常に最後。リストされていないレーンはアタッチ不可のまま残る（レーン分離 #1225/#1232）。デフォルト `[]` = 独自のレーン → ユーザーゾーン → 生成。設計上オプトイン: 外部インスタンスの MITM ホワイトリストがあなたのプロバイダーをカバーしていない場合があり、その場合モデルトラフィックはブラインドトンネルとなり、すべての圧縮ツール呼び出しが失敗する。すべてのレーン認識アタッチサイト（ランチャーレーン + hermes ネイティブプラグインのディスカバリー）に適用される。例: `"native": { "attachLanePriority": ["dsh"] }`。
  - **`attachUrl`** （環境変数 `BILI_MCP_PROXY`、これは `--origin` も受け入れる; 環境変数が優先）— 明示的なターゲットオリジン（ローカルまたはリモートの任意の URL）。設定されると、ディスカバリーはその正確なオリジンにのみアタッチする（ポリシーフィルタをバイパス）; 到達不能または非互換の場合、フックはハードフェイルするのではなく独自のものを生成する。これにより、ホストは特定の常駐デーモンに自身を固定できる。
  - **`attachExternal`** （環境変数 `BILI_NATIVE_ATTACH_EXTERNAL`）— ライフサイクルゲートのエスケープハッチ: `true` は*レーン付き*の非武装リスナーにもアタッチする（ウォッチドッグ状態に関係なく、コード/レーン互換の任意のリスナー、#1330 以前のビルドを含む）かつ `own-lane` アフィニティフィルタを完全にバイパスする（完全に寛容）。これはどのレーンのデーモンが優先されるかを変更しない — それは `attachPolicy` である。優先順位: `1` は閉じたファイル上でもゲートを開き; `0` は寛容なファイル上でもそれを閉じる。
  - **動作変更（#2877）:** デフォルトは「レーン付きフックは互換性のあるレーンなし/手動デーモンに乗ることにフォールバックする」から「独自のものを生成する」に反転した。1 つの手動 `bili start` デーモンがすべてのネイティブエージェントにサービスを提供するよう依存していた場合、`native.attachPolicy: "global-fallback"` を設定すること（または `BILI_NATIVE_ATTACH_EXTERNAL=1` を維持する）。完全なメカニクス: [technical-notes.md](technical-notes.md#proxy-reuse-and-the-attach-gate-1225-1335-1232-1660)。

### `pi`

- **Type:** `{ subagents?: PiSubagentsFileConfig | boolean }`
- **Default:** `{}` （パッケージデフォルトで acp_delegate サーフェス有効）
- **Status:** ACTIVE (#2230 config-home)
- **Description:** 組み込み **pi レーンサブエージェント**（`acp_delegate` / `acp_delegate_wait` / `acp_delegate_cancel`、`bili pi` が埋め込み拡張を配線する際に登録される）の設定。`pi.subagents` セクションはこのサーフェスの設定ホームである; リポジトリ内の `pi-subagents/` コンポーネント（npm 名 `billion-context-pi-subagents`）は、独自のローダーを通じて同じセクションを読む（ファイル形式が契約であり、共有コードではない）。以前これらのノブは pi の `~/.pi/acp.json` の `delegate` / `delegatePrompt` / `displayUsage` / `debug` にあった — これら 4 つのキーは**非推奨フォールバック**である: セクションが存在しない間はまだ読み取られる（ホストプロセスの stderr に一度きりの非推奨警告）、**セクションが存在すると無視される**、将来のリリースで削除予定。名前変更: `delegatePrompt` → `prompt`; `debug` はサブエージェントサブシステムにスコープされ、トップレベルプロキシの `debug` とは**衝突しない**。

```jsonc
"pi": {
  "subagents": {
    "enabled": true,              // master switch; false (or "subagents": false) removes tools+prompt+shortcut (new session)
    "forceEnable": false,        // keep acp_delegate even when a pi-subagents install (either scope) is detected (#415, #5637)
    "displayUsage": "separate",  // "separate" (own footer block) | "merged" (folded into tool-result usage)
    "maxDepth": 2,               // nesting depth cap, propagated to children
    "syncTimeoutMinutes": 5,     // hard timeout for sync delegates; 0/null disables
    "idleTimeoutMinutes": 5,     // idle watchdog for async delegates; 0/null disables (warns)
    "asyncTimeoutMinutes": 30,   // hard limit for async delegates; 0/null disables
    "maxConcurrent": 4,          // cap on concurrent background delegates (default unlimited; extras queue)
    "thinkingLevel": "medium",   // off|minimal|low|medium|high|xhigh|max; priority per-call > role > this > pi default
    "agents": {                  // per-role defaults: { model: "provider/id", thinkingLevel: "…" }
      "reviewer": { "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "high" }
    },
    "notifyIfRead": "skip",      // "skip" — no completion nudge if the model already read the result file
    "fleetShortcut": "ctrl+alt+d", // "" disables the keyboard shortcut (/acp-fleet still works)
    "prompt": null,              // replace (string) or remove (null) the ACP_DELEGATE NOTIFICATIONS appendix
    "debug": false               // debug events in ~/.pi/acp.log, scoped to sub-agents
  }
}
```

**環境変数オーバーライド**（プロセスごとの生成チャネル、デリゲート子プロセスに伝播; `PI_ACP_DELEGATE_*` > `pi.subagents` > 非推奨 acp.json > デフォルト）:

| 環境変数 | オーバーライド対象 | 備考 |
|---|---|---|
| `PI_ACP_DELEGATE_FORCE_ENABLE` | `pi.subagents.forceEnable` | `true`/`false`; 解析不能な値は警告し、ファイル値にフォールバックする。 |
| `PI_ACP_DELEGATE_MAX_DEPTH` | `pi.subagents.maxDepth` | 整数 ≥ 1; 無効な場合は警告し、フォールバックする。 |
| `PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES` | `pi.subagents.syncTimeoutMinutes` | `0` で無効化; 負/数値でない場合は警告し、フォールバックする。 |
| `PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES` | `pi.subagents.idleTimeoutMinutes` | `0` で無効化（警告 — ハングした子プロセスにはその後 `acp_delegate_cancel` が必要）。 |
| `PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES` | `pi.subagents.asyncTimeoutMinutes` | `0` で無効化。 |
| `PI_ACP_DELEGATE_MAX_CONCURRENT` | `pi.subagents.maxConcurrent` | 整数 ≥ 1; 無効な場合はファイル値に、次に無制限にフォールスルーする。 |

変更は**新しいセッション**で有効になる（ツールはセッション開始時に登録される）。完全なデリゲートサーフェスドキュメント（ロール、実行モデル、フリートインスペクター）: [billion-context-pi-subagents README](../pi-subagents/README.md)。
### プロセスレベルのブロック (#2030)

#2030 以降、すべての純粋な挙動制御ノブには、環境変数のほかに設定ファイルのキーが用意されています。解決順序は **環境変数 > 設定ファイル > ビルトインデフォルト** です。*設定済み* の環境変数値は、そのノブを所有します（ゴミデータであっても、#2030 以前と完全に同じようにパースされ、デフォルトにフォールバックします）。また、ファイル層にリークしたり、ファイル層によってシャドウされたりすることはありません。これらのブロックは **プロキシプロセス**（トランスポートタイミング、永続化、セッションライフサイクル、セルフアップデート、診断）のスコープを限定します。これらは意図的に、3レベルの圧縮マージ（[global → provider → model](#three-level-merge-example)）には参加しません。これらのノブにはプロバイダ別やモデル別のセマンティクスが存在しないためです。それらの環境変数形式はプロセス全体に適用されるものであり、トップレベルのキーはスコープを正確に保持します。すべてのキーは任意です。ブロックを省略しても何も変わりません。ノブごとの詳細なセマンティクスは、以下の [環境変数マッピングテーブル](#config-file-keys-for-environment-knobs-2030) に記載されています。

```jsonc
// ~/.config/billion-context/billion-context.json — #2030 process-level blocks (all optional)
{
  // Transport & retry timing
  "network": {
    "upstreamTimeoutMs": 720000,          // idle budget per upstream request (12 min default)
    "requestWatchdogMs": 1440000,         // total request budget; default = 2× upstream timeout
    "replayRetryMax": 3,                  // attempts after transient upstream 429/5xx
    "replayRetryBaseMs": 1500,            // backoff base; 0 disables the delay
    "maxShrinkPerCompress": 0.4,          // max fraction (0,1] one compress may shrink; omit = no steering
    "keepAliveTimeoutMs": 5000,           // client-facing socket keep-alive
    "clientErrorBackstopMs": 30000,       // half-open client socket destroy backstop
    "exposureLogIntervalMs": 3600000,     // [exposure] telemetry interval; 0 disables
    "streamKeepAliveMs": 15000,           // SSE keepalive during upstream silence; 0 disables
    "preflightHoldMs": 30000,             // grace before a long preflight hold starts
    "preflightDeadEndCooldownMs": 300000, // cooldown after a dead-end preflight verdict
    "proxyKeepAliveMaxMs": 55000,         // upstream-proxy connection reuse cap; 0 uncapped
    "postResponseLingerMs": 5000,         // post-response close linger budget (#1982)
    "allowPrivateHttpProviders": false    // opt-in: private-network plain-HTTP providers (#2984)
  },

  // Session persistence
  "persist": {
    "enabled": true,                      // false = in-memory only, lost on restart
    "zstd": false,                        // true = BILIZSTD1 files (#1080 owner decision: off)
    "debounceMs": 500,
    "tailTokens": 16384,                  // persisted snapshot budget; 0 = no message persistence
    "epermAlertThreshold": 5,             // Windows AV-exclusion alert after N failures
    "epermAlertRepeatMs": 0               // 0 = alert once
  },

  // Session lifecycle
  "sessions": {
    "max": 256,                           // in-memory LRU cap
    "gc": {
      "enabled": false,                   // opt-in (#1082): session files are user data
      "maxAgeDays": 7,
      "maxTokens": 1000000,
      "intervalMs": 3600000
    }
  },

  // Self-updater
  "update": {
    "registry": "https://registry.npmjs.org",
    "checkIntervalMs": 180000
  },

  // Debug & diagnostic toggles
  "diagnostics": {
    "dumpBody": false,                    // dump full request/response bodies
    "dumpReq": true,                      // gate for request-body dumps
    "rawDumpDir": null,                   // raw-dump location; null = <state dir>/raw
    "dump4xx": false,                     // capture rejected 4xx bodies
    "dump4xxMaxBytes": 2097152,
    "maxTotalBytes": null,                // cap total dump-dir bytes; null = no cap (#2412)
    "maxAgeDays": null,                   // delete dump files older than N days; null = off
    "renderNone": false,                  // stop injecting mNNNNN render tags
    "invariantJudge": true,               // L1 advisory outbound-invariant judge (#3938)
    "noInjectTool": false,                // suppress compress tool injection
    "noCompressPrompt": false,            // suppress compress prompt text
    "countTokensPassthrough": false,      // forward /count_tokens verbatim
    "compressProtocol": "tools"           // "tools" | "text"
  },

  // Fake-completion safety net (#371, opt-in)
  "fakeCompletion": { "retries": 0, "bufCapBytes": 16777216 },

  // Scalars
  "codexCompact": "intercept",            // or "pass"
  "ccrRetrievalTtlMs": 600000,            // queued acp_retrieve expiry; 0 disables
  "decompressTmpCap": 50                  // max concurrent decompress temp files
}
```
### `network`

- **Type:** `{ upstreamTimeoutMs?: number; requestWatchdogMs?: number; replayRetryMax?: number; replayRetryBaseMs?: number; maxShrinkPerCompress?: number; keepAliveTimeoutMs?: number; clientErrorBackstopMs?: number; exposureLogIntervalMs?: number; streamKeepAliveMs?: number; preflightHoldMs?: number; preflightDeadEndCooldownMs?: number; proxyKeepAliveMaxMs?: number; postResponseLingerMs?: number; allowPrivateHttpProviders?: boolean }`
- **Default:** `{}` (組み込み値: `720000`, `2× upstream timeout`, `3`, `1500`, 未設定, `5000`, `30000`, `3600000`, `15000`, `30000`, `300000`, `55000`, `5000`, `false`)
- **Status:** ACTIVE
- **Description:** プロセス全体のトランスポートおよびリトライのタイミング（ミリ秒）。各キーは、対応する環境変数（`BILI_UPSTREAM_TIMEOUT_MS`, `BILI_REQUEST_WATCHDOG_MS`, `BILI_REPLAY_RETRY_MAX`, `BILI_REPLAY_RETRY_BASE_MS`, `BILI_MAX_SHRINK_PER_COMPRESS`, `BILI_KEEP_ALIVE_TIMEOUT_MS`, `BILI_CLIENT_ERROR_BACKSTOP_MS`, `BILI_EXPOSURE_LOG_INTERVAL_MS`, `BILI_STREAM_KEEPALIVE_MS`, `BILI_PREFLIGHT_HOLD_MS`, `BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS`, `BILI_PROXY_KEEPALIVE_MAX_MS`, `BILI_POST_RESPONSE_LINGER_MS`, `BILI_ALLOW_PRIVATE_HTTP_PROVIDERS`, `BILI_CA_FILE`）を通じて、環境変数 > ファイル > デフォルトの優先順位で解決される。セマンティクス: `upstreamTimeoutMs` は、エンドツーエンドでのファーストバイトまでの時間とチャンク間の沈黙時間を制限する（#551）；`requestWatchdogMs` はリクエスト全体の予算であり（負の値を設定すると無効化される）；`replayRetryMax` は、一時的なアップストリーム拒否後の試行回数を数える（#189/#1688）；`maxShrinkPerCompress` は、bili がより小さい範囲へ向かうよう誘導する前に、1回の圧縮でリクエストを縮小できる上限を定める（#189）；`streamKeepAliveMs` は、レスポンスがその間ゼロバイトしか書き込まれていない場合に SSE コメントを発行する（#1647）；`proxyKeepAliveMaxMs` は、アップストリームプロキシの再サイクル頻度未満での接続再利用を制限し（#1263）、`0` で無制限にする；`postResponseLingerMs` は、プロキシ起因のレスポンス後のクローズにおけるグレースフルクローズの予算であり、ソケットはピアの FIN/TLS close_notify を待って保持され、期限が来ると破棄される（`reason=linger-backstop`）（#1982）；`allowPrivateHttpProviders` はオプトイン機能（#2984）であり、true の場合、プライベートネットワーク（RFC1918, 127/8, リンクローカル, IPv6 ULA/リンクローカル, `*.local`/`.lan`/`.internal`）上のプレーン HTTP プロバイダーの baseUrl が、通常はループバックのプレーンテキストのみを信頼するエージェントレジストリのインテークおよびサマリーエンドポイントのガードによって許可される — パブリック IP/ドメインおよび CGNAT (100.64/10) は常に拒否され、デフォルトの `false` は #2984 以前の動作をバイト単位で維持する；`caFile` (#3776) は、bili 自身のアップストリームフェッチを追加のルート CA PEM に向ける — 組み込みルートおよび `NODE_EXTRA_CA_CERTS` とマージされ、決して置き換えられない — セキュリティスキャナー/企業 MITM による再署名されたアップストリーム用。詳細は [env table](#config-file-keys-for-environment-knobs-2030) を参照。

### `persist`

- **Type:** `{ enabled?: boolean; zstd?: boolean; debounceMs?: number; maxDelayMs?: number; tailTokens?: number; epermAlertThreshold?: number; epermAlertRepeatMs?: number }`
- **Default:** `{ enabled: true, zstd: false, debounceMs: 500, maxDelayMs: 5000, tailTokens: 16384, epermAlertThreshold: 5, epermAlertRepeatMs: 0 }`
- **Status:** ACTIVE
- **Description:** セッション永続化の動作（対応する環境変数: `BILI_PERSIST`, `BILI_PERSIST_ZSTD`, `BILI_PERSIST_DEBOUNCE_MS`, `BILI_PERSIST_MAX_DELAY_MS`, `BILI_PERSIST_TAIL_TOKENS`, `BILI_PERSIST_EPERM_ALERT_THRESHOLD`, `BILI_PERSIST_EPERM_ALERT_REPEAT_MS`）。`enabled: false` はセッションをメモリ内にのみ保持する；`zstd: true` は `BILIZSTD1` ファイルを書き出す（#1080 オーナー決定: 回復可能性のためプレーン JSON がデフォルトのまま）；`tailTokens` は永続化された折り畳みスナップショットの予算を定める（`0` でメッセージ永続化を完全に無効化）；`debounceMs` / `maxDelayMs` はセッションファイルの書き込みデバウンスを制限する — ウィンドウはすべての変更で再起動し、最大遅延の上限は持続的なトラフィック下でも書き込みが予算内で完了することを保証する（この上限はセッション順序 / プレフィックスアフィニティのスナップショットライターにのみ存在し、#6058 でこのノブに配線されるまで 5 秒の予算がハードコードされていた。これにより摩耗に敏感なドライブでの定常状態の書き換えレートが設定された；メインのセッション別ライターは飢餓を起こさない非再起動型デバウンスを使用するため、そのような上限はない）；2つの `eperm*` キーは Windows のアンチウイルス除外アラートを調整する。詳細は [env table](#config-file-keys-for-environment-knobs-2030) を参照。

  **物理的な書き込み量の監視 (#6058).** これらのノブが敏感な（例: QLC）ドライブの実際の摩耗にどのような影響を与えるかを測定するには、代表的な実行の前後で NVMe SMART カウンターを差分比較する：

  ```bash
  smartctl -A -d nvme /dev/nvme0n1    # "Data Units Written" (+ "Percentage Used") を記録
  # ... N 分間ワークロードを実行 ...
  smartctl -A -d nvme /dev/nvme0n1    # 差分 = ウィンドウ内の物理的な書き込みバイト数
  ```

  その後、マシンがアイドル状態になった約 10 分後に一度だけ読み取り、バックグラウンド書き込み（WAL チェックポイント、スナップショットフラッシュ）とフォアグラウンドトラフィックを分離する。カウンターの単位はファームウェアで定義される（NVMe 標準では 512 バイト単位を使用 — 既知サイズのコピーに対して健全性チェックを行うこと）ため、絶対値ではなく固定ウィンドウでの DELTAS を比較すること。ファイルシステムレベルの集計（mtime/サイズのスキャン）では、ページレベルの index.db の書き換えや WAL の変動を完全に逃してしまう — 完全なボリュームを確認できるのは SMART カウンターのみである。

### `sessions`

- **Type:** `{ max?: number; gc?: { enabled?: boolean; maxAgeDays?: number; maxTokens?: number; intervalMs?: number } }`
- **Default:** `{ max: 256, gc: { enabled: false, maxAgeDays: 7, maxTokens: 1000000, intervalMs: 3600000 } }`
- **Status:** ACTIVE
- **Description:** `max` は LRU エビクションによりメモリ内のセッション数を制限する（対応する環境変数 `BILI_MAX_SESSIONS`；ディスクは依然として真実のソースである）。`warmMax`/`warmMaxBytes` は起動時のウォームキャッシュを、`residentMaxBytes` はアイドル時の常駐目標を制限する（#2803 有界な起動: 起動時に最も最近のウォームセットのみがハイドレーションされ、それ以外はオンデマンドで再読み込みされる；アクティブ/進行中の状態は決してエビクションされない）。`gc` は古いセッションファイルのクリーンアップを制御する（対応する環境変数 `BILI_SESSION_GC*`） — **オプトイン**であり、セッションファイルはユーザーデータであるため：圧縮されたセッションは決して削除されず、削除は監査ログに記録され、経過日数およびロスレスサイズのゲートが適用される。詳細は [env table](#config-file-keys-for-environment-knobs-2030) を参照。

### `plugin`

- **Type:** `{ snapshotCapBytes?: number }`
- **Default:** `{ snapshotCapBytes: 104857600 }`
- **Status:** ACTIVE
- **Description:** プラグインサーフェスのノブ（#2017）。`snapshotCapBytes` は、パブリックフォーク API（`GET /__bili/plugin/snapshot`, `POST /__bili/plugin/fork`）のためにプラグインセッションごとに保持される生ワイヤー履歴スナップショットの上限を定める：シリアライズされたスナップショットが上限を超えると、bili はそれを保持することを拒否する — ディスク上に無制限の生コピーを保持する代わりに、セッションはフォーク可能でなくなる（snapshot/fork が上限理由とともに `409` を返す）。デフォルトは `100 MiB`；`0` で保持を完全に無効化（どのセッションもフォーク不可）；対応する環境変数 `BILI_PUBLIC_SNAPSHOT_CAP_BYTES`。詳細は [env table](#config-file-keys-for-environment-knobs-2030) を参照。

### `update`

- **Type:** `{ registry?: string; checkIntervalMs?: number; staggerMinDelayMs?: number | string; staggerMaxDelayMs?: number | string; policyUrl?: string }`
- **Default:** `{ registry: https://registry.npmjs.org, checkIntervalMs: 180000 }` (stagger フィールド未設定 → 組み込みウィンドウ 15 分 – 48 時間；`policyUrl` 未設定 → 公式リポジトリの raw URL)
- **Status:** ACTIVE
- **Description:** セルフアップデーターのソース（対応する環境変数 `BILI_UPDATE_REGISTRY`, `BILI_UPDATE_CHECK_INTERVAL_MS`, `BILI_UPDATE_STAGGER_MIN_MS`, `BILI_UPDATE_STAGGER_MAX_MS`, `BILI_UPDATE_POLICY_URL`）。stagger ファイルフィールドは人間が読める期間文字列（`"15m"`, `"2d"`, `"1d12h"`, 単位 s/m/h/d/w、組み合わせ可能）を受け入れる；環境変数の対応物は生のミリ秒のまま。`registry`/`checkIntervalMs` はインポート時に解決されるため、次の再起動で有効になる — 環境変数と同様。`registry` はハーメティックテスト（verdaccio e2e レーン）のために意図されている；本番環境ではデフォルトのままにすること（#1153）。stagger フィールドおよび `policyUrl` は更新サイクルごとにライブ読み取りされる。

#### スタグダードロールアウトおよびリモート更新ポリシー (#3619)

新しいバージョンが発見された場合、自動アップグレードは即座に実行されない：インスタンスは遅延ウィンドウ内のランダムな 1 つの時刻を引き — 組み込みデフォルトは **15 分から 48 時間** — その時刻が来たらアップグレードする。引き出された時刻はキャッシュディレクトリ（`~/.cache/billion-context/.update-stagger.json`）に `(dist-tag, target version)` をキーとして永続化されるため、プロセスの再起動では再抽選されない（再起動が多いマシンが早期の値を引き続けることはない）。これにより、リリースから数分以内に全員が移動するのではなく、フリートのアップグレードがウィンドウ内に分散され、ロールアウト中に不良リリースを捕捉するための応答ウィンドウが確保される（#3401/#3600/#3394）。

ウィンドウの構成（各側独立して）：ローカル設定/環境変数 > リモートポリシーの `default` > 組み込み（15 分 / 48 時間）。**`0` はこのマシンの遅延を無効化する** — レガシーの即時アップグレードのために両側を `0` に設定する。

リモートポリシーファイル：bili は公式リポジトリの raw アドレスから `auto-update-policy.json` を匿名で GET する（`update.policyUrl` / `BILI_UPDATE_POLICY_URL` のオーバーライドはテストシームのみ）。キャッシュディレクトリに ETag/If-None-Match を使用してキャッシュされる。失敗ラダー（fail-open — ファイルによってアップグレード機能がブロックされることはない）：フェッチ/HTTP 失敗 → 30 日以内であれば最後に正常にキャッシュされたコピーを再利用、それ以外はローカルデフォルト；不正な JSON または不明な `schemaVersion` → キャッシュを破棄し、ローカルデフォルト。テレメトリゼロ：プレーン GET、クエリパラメータなし、デバイス ID なし。

フォーマット（フィールドは追加的；不明なフィールドは無視される）。キーは `minDelay`/`maxDelay`（期間文字列が優先 — 生のミリ秒の数値も受け入れられる）：

```jsonc
{
  "schemaVersion": 1,
  "default": { "minDelay": "15m", "maxDelay": "2d" },
  "overrides": [
    { "range": ">=0.1.200", "maxDelay": "1h" },
    { "version": "0.1.199", "maxDelay": "1m" }
  ],
  "hold": false,
  "blocked": [],
  "pinned": null
}
```

- `default` — オーバーライドに一致しないターゲットバージョンのベースウィンドウ。期間フィールド（`minDelay`/`maxDelay`、すべてのオーバーライドで同じ）は人間が読める文字列（`"15m"`, `"2d"`, `"1d12h"`, 単位 s/m/h/d/w、組み合わせ可能；プレーンな数値は依然として生のミリ秒を意味する）を受け入れる。不正な値は警告とともに無視される — 推測は決して行われない。
- `overrides[]` — ターゲットバージョンごとのウィンドウ調整：正確な `version` が `range`（npm semver レンジ）に優先する；最初に一致したレンジが勝つ。オーバーライドは片側のみを設定してもよい。
- `hold: true` — フリート全体の自動アップグレードを凍結する（チェックは実行され続けるが、何もインストールされない）。手動の `bili update` は依然として動作する。
- `blocked: ["x.y.z", …]` — これらのバージョンをスキップする；アップデーターはリストされていない次に公開されたバージョンにステップダウンする。
- `pinned: "x.y.z"` — アップグレードの上限：このバージョンを超える自動アップグレードは決して行われない（実行中のインストールを強制ダウングレードすることは決してない；ロールバックは依然としてアドバイザリーの役割である）。`null` = ピンなし。

セキュリティ境界：このファイルは、アップグレードする *タイミング* と、スキップまたはピンする *公開バージョン* を制御するのみであり、インストールされる *バイト* を決して制御しない。インストールソースは npm レジストリの dist-tag 解決のまま；実際に公開されていないバージョンである `blocked`/`pinned` の値はログ行とともに無視される。状態はユーザーに見える：凍結 / ピン / スタグダー中、`/__bili/status` は `updatePolicy`（`source`, `hold`, `pinned`, `blocked`, `plannedUpgrade`）を報告し、ログにもその旨が記載される。終了条件：手動の `bili update` は `hold` と stagger をバイパスする（ただし `blocked`/`pinned` は依然として尊重される）、`ACP_AUTO_UPDATE=0` は自動更新を完全に停止し、`0`/`0` の stagger はマシンごとにレガシーのタイミングを復元する。
### `diagnostics`

- **Type:** `{ dumpBody?: boolean; dumpReq?: boolean; rawDumpDir?: string; dump4xx?: boolean; dump4xxMaxBytes?: number; maxTotalBytes?: number; maxAgeDays?: number; renderNone?: boolean; invariantJudge?: boolean; noInjectTool?: boolean; noCompressPrompt?: boolean; countTokensPassthrough?: boolean; compressProtocol?: "tools" | "text" }`
- **Default:** `{ dumpBody: false, dumpReq: true, rawDumpDir: <state dir>/raw, dump4xx: false, dump4xxMaxBytes: 2097152, maxTotalBytes: null, maxAgeDays: null, renderNone: false, invariantJudge: true, noInjectTool: false, noCompressPrompt: false, countTokensPassthrough: false, compressProtocol: "tools" }`
- **Status:** ACTIVE
- **Description:** 以前は環境変数のみで制御されていたデバッグ/診断用トグル（`ACP_DUMP_BODY`, `ACP_DUMP_REQ`, `ACP_RAW_DUMP_DIR`, `BILI_DUMP_4XX`, `BILI_DUMP_4XX_MAX_BYTES`, `ACP_RENDER_NONE`, `ACP_NO_INJECT_TOOL`, `ACP_NO_COMPRESS_PROMPT`, `ACP_COUNT_TOKENS_PASSTHROUGH`, `ACP_COMPRESS_PROTOCOL`）。`compressProtocol` は起動時に一度だけ解決される（環境変数と同様）が、それ以外はリクエストごとにライブで読み込まれる（再起動不要）。`renderNone` を設定すると、送信履歴への `mNNNNN` レンダリングタグの注入が停止する。リファレンスベースの圧縮を必要としないワークフローの場合のみ無効化すること（#933）。保持期間の上限（#2412）: ダンプディレクトリはデフォルトでは書き込み専用でローテーションなし。アクティブなボディ/SSEキャプチャは約 63 GB/日と測定されており、数日でディスクを埋め尽くす可能性がある。`maxTotalBytes` および/または `maxAgeDays` を設定して上限を設けること（古いものから削除、`err-*`/`summary-err-*` のインシデントダンプは保護対象、削除は warn レベルでログ出力）。両方未設定の場合は無制限の保持となる。詳細は[環境変数テーブル](#config-file-keys-for-environment-knobs-2030)を参照。

### `fakeCompletion`

- **Type:** `{ retries?: number; bufCapBytes?: number }`
- **Default:** `{ retries: 0, bufCapBytes: 16777216 }`
- **Status:** ACTIVE
- **Description:** ストリーム途中で中断するホスト向けのフェイクコンプリーションのセーフティネット（#371）— **オプトイン**方式で、`retries: 0`（デフォルト）は #371 以前のパススルー動作。`bufCapBytes` はバッファリングされたレスポンスに対する OOM ガード。`BILI_FAKE_COMPLETION_RETRIES`, `BILI_FAKE_BUF_CAP` と対応。

### `codexCompact` / `ccrRetrievalTtlMs` / `decompressTmpCap`

- **Type:** `string` ("intercept" | "pass") / `number` / `number`
- **Default:** `"intercept"` / `600000` / `50`
- **Status:** ACTIVE
- **Description:** トップレベルのスカラー値。`codexCompact`: bili が codex ネイティブ圧縮リクエストをインターセプトしてローカル ACP ハンドオフを偽造するか、それともアップストリームにパスするかを決定する（対応変数 `BILI_CODEX_COMPACT`。リクエストごとに読み込まれるため、どちらの階層でも再起動なしで切り替え可能）。スコープ（#3008）: インターセプトは明示的な形式（`/compact` トリガーアイテムと `POST /responses/compact`）と、通常のターンとして通過するインライン自動圧縮（SUMMARIZATION_PROMPT テンプレートで検出）をカバーする。ユーザーが上書きした compact_prompt は検出から除外され、そのまま通過する。bili が観察のみした圧縮（pass モード / ゲート拒否）は、圧縮後の履歴に事後ベースで再設定される（#2372）。`ccrRetrievalTtlMs`: キューイングされたが未配信の `acp_retrieve` 注入の有効期限。期限切れ時は明示的に破棄される（対応変数 `BILI_CCR_RETRIEVAL_TTL_MS`。`0` で無効化）。`decompressTmpCap`: 並行実行可能なデコンプレッション一時ファイルの最大数（対応変数 `BILI_DECOMPRESS_TMP_CAP`）。

既存のブロックを拡張する #2030 のキーがさらに 3 つある: [`mitm.handshakeTimeoutMs`](#client-integration)（デフォルト `10000`、対応変数 `BILI_MITM_HANDSHAKE_TIMEOUT_MS`）、[`compat.noCacheControl`](#compat)、および [`compat.keepResponseId`](#compat)。

---
## プロバイダー

`providers` ブロックは、**アップストリーム URL** をプロバイダーごとの設定にマッピングします。各キーは URL プレフィックスであり、各値はモデルのコンテキストウィンドウ、プロバイダーごとのプロキシ、圧縮プロトコル、ワイヤープロトコルの宣言、圧縮のオーバーライド、画像課金モード、ルートごとのパススルー、クライアント側の直接接続の免除、およびレーン認証情報のオーバーライド（[`apiKeyEnv`](#lane-credentials-apikeyenv--credentialref)）を宣言できます。URL 以外の**名前付き**キーも許可されています：それらは単独ではルーティングに無効ですが、[`bind`](#named-provider-entries-bind) を通じて実際のレーンになります。
```jsonc
{
  "providers": {
    "https://api.anthropic.com": {
      "models": {
        "claude-sonnet-4-5": { "context": 200000, "output": 8192 }
      },
      "proxy": "http://10.0.0.1:7890",
      "compressProtocol": "tools",
      "compress": { "maxContextLimit": "70%" }
    },
    "https://relay.example.com/my/custom/complete": {
      "protocol": "openai"
    }
  }
}
```

### URL キーのマッチング

キーは、リクエストのアップストリーム URL に対して**最長プレフィックス優先**でマッチングされます。リクエスト URL がキーと等しい場合、または `key + "/"` で始まる場合にキーがマッチします。これにより、マッチングは境界安全になります：キー `https://api.example.com` は `https://api.example.com/v1/chat` にマッチしますが、`https://api.example.com.evil`（攻撃者制御の類似ホスト）にはマッチし**ません**。

浅いキー（`https://open.bigmodel.cn`）は、そのホスト上のすべてのパスにマッチします。深いキー（`https://open.bigmodel.cn/api/anthropic`）は、そのエンドポイントのみをマッチします。2 つのキーが両方ともマッチする場合、より長い（より具体的な）方が優先されます。キーの末尾スラッシュは自動的に除去されます。

**アップストリームがどのキーにもマッチしないリクエストには、プロバイダーごとのオーバーライドは適用されません。** リクエスト URL が上記のどのキーにもマッチしない場合、そのリクエストはレジストリ/グローバルのデフォルトのみで実行されます — その `models.<m>.context`、`compress.modelContextLimit`、プロキシ、プロトコルなどはすべて無言で無視されます。一般的な罠は、ピン留めが旧ホストのキーの下にある間に、クライアントを*別のリレーホスト*に切り替えることです：新しいホストはルートミスとなるため、旧キーの下で設定したものは決してそこに到達しません。#2317 以降、これは無言ではなく明示的になりました — bili は (upstream, model) ごとに 1 回だけ、既知のキーを特定する `[route]` 警告をログに記録し、`[window]` / codex-clamp の行に `upstream=<…> route=miss` をスタンプし、ウィンドウ超過ペイロードに対するプリフライト 502 は `compress.modelContextLimit` を再設定するよう指示するのではなく、欠落しているキーを指し示します。新しいホスト（または URL プレフィックス）にオーバーライドを適用するには、`providers` エントリを追加してください。これらの行のエンドポイントは、ログのホストマスキング（`BILI_LOG_MASK_HOSTS`）と整合性を保つため、そのまま出力されるのではなくフィンガープリント化（`<host:xxxxxxxx>`）されます。

### MITM と `/bili/` キースキーム

ログインクライアント（MITM 経由の ZCode）と API キークライアントは、同じホスト（`open.bigmodel.cn`）にアクセスできます。それらの設定を異ならせるために、MITM トラフィックはプロバイダー検索キーで `mitm://` スキームを使用し、`/bili/` トラフィックは実際の `https://` を使用します：

| クライアント | 検索キーの例 |
|---|---|
| ZCode (MITM, ログイン) | `mitm://open.bigmodel.cn` |
| API キークライアント (`/bili/`) | `https://open.bigmodel.cn/api/anthropic` |

したがって、API キークライアントに影響を与えることなく、ZCode に独自のアップストリームプロキシを与えることができます：

```jsonc
{
  "providers": {
    "mitm://open.bigmodel.cn":            { "proxy": "http://127.0.0.1:20173" },
    "https://open.bigmodel.cn/api/anthropic": { "proxy": "http://127.0.0.1:20172" }
  }
}
```

2 つのスキームは決して重複しません：`mitm://` キーはそのホストの MITM（ログインクライアント）トラフィックのみを対象とし、プレーンな `https://` キーは `/bili/`（API キー）トラフィックのみを対象とします。

### 名前付きプロバイダーエントリ（`bind`）

URL ではないキー（例：`"claude-bridge"`）は**名前付き**エントリです。単独ではルーティングに無効です — 最長プレフィックスマッチングは決してそれにはヒットしません — かつ、[`compactionOptIn`](#compactionoptin) のようなエージェント側のアイデンティティのみを保持します。`bind` フィールドがあると、別のレーンの純粋な**エイリアス**になります：

- **型:** `string` — エイリアス化するレーンの http(s) ベース URL。
- 解決は**完全に設定読み込み時**に行われます：エントリのルーティングフィールド（`compress`、`models`、`proxy`、`passthrough`、`compressProtocol`、`compat`、`imageBilling`、`imageTokenCap`、`protocol`）はバインドされた URL のルートにディープマージされ、その URL キーの下に書かれたかのように正確に適用されます。名前自体はリクエストパスやワイヤー上には決して現れません；プロキシは単一の URL プレフィックスルーティングを維持します。
- **優先順位（フィールドごと）:** 明示的な URL キーエントリはすべてのエイリアスフィールドに優先します；ソース間で、外部の `ACP_PROVIDERS` ファイルはすべてのレベルでインライン設定に優先します（エイリアスはソース順に折り畳まれ、最初に設定されたものが優先されます）。オブジェクトはキーごとにマージされます；配列/スカラーは勝者から丸ごと取得されます — 要素ごとのマージはありません。
- `bind` がないがルーティングフィールドを保持している名前付きキーはデッド設定です：bili は起動時に警告をログに記録し、キーと無効なフィールドを特定します（「`bind` を追加するか、これらを URL エントリの下に移動してください」）無言で無視する代わりに。無効な `bind` 値（非文字列、非 http(s) URL）は警告し、エントリを無効のままにします；URL キーでの `bind` は警告し無視されます（キーはすでにレーンです）。

```jsonc
{
  "providers": {
    "claude-bridge": {
      "bind": "https://api.anthropic.com",
      "compactionOptIn": true,
      "compress": { "maxContextLimitPct": 0.75 }
    }
  }
}
```

### レーン認証情報（`apiKeyEnv` / `credentialRef`）

URL キー付きレーン（または `bind` を持つ名前付きエントリ）は、クライアントのものではなく**独自の**認証情報をアップストリームに送信できます — レーン所有者のキーが、エージェントクライアントがワイヤー上に置いたものを置き換えます（#2336）。典型的なケース：共有マシンプロキシで、所有者の `deepseek` レーンは、どのクライアント（およびその個人キー）がそれを介して通信しても、所有者のキーで認証します。

```jsonc
{
  "providers": {
    "https://api.deepseek.com": { "apiKeyEnv": "DEEPSEEK_LANE_KEY" }
  }
}
```

- **型:** `string` — `apiKeyEnv` は環境変数の名前（`env:VAR` セマンティクス）、`credentialRef` はプライベートな[サマリー認証情報ストア](#shared-external-summary-service)内の名前（`secret:NAME` セマンティクス）です。エントリごとにちょうど 1 つ；無効な値は設定を拒否します（#1909 の規律 — 起動失敗 / Web UI 400）。
- **置換ルール:** `x-api-key` と `x-goog-api-key` は完全に置き換えられます。`authorization` は、クライアントの値が Bearer トークンの場合**のみ**置き換えられます — その他のスキーム（SDK-HMAC 署名、mTLS フィンガープリント…）は署名所有であり、警告とともにそのままにされます。3 つのいずれも保持していないリクエストには `authorization: Bearer <key>` が付与されます。
- **#1884 の相互作用:** リクエストで CodeArts 再署名アームがアクティブな場合は常にスキップされます — 再署名者がそこに `Authorization` を所有するためです。
- **失敗時の姿勢:** 環境変数が未設定またはシークレットが存在しない場合、bili はクライアント自身のヘッダーを保持し、レーン+参照ごとに 1 回警告します（可視的であり、保証された 401 に無言で劣化することはありません）。警告は成功した解決後に再アームされます。
- 共有フォワードヘッダーセットに一度適用されるため、リクエストのすべての出口 — 初期送信、ロールラダーリトライ、オーバーフローリフォールド、圧縮ループラウンド、継続リフェッチ — がレーン認証情報を保持します。
### ルートレベルの k̂ 校正ポリシー

- **型:** `object` — `{ "disabled"?: boolean, "max"?: number }`; 少なくとも 1 つのキーが必要
- **デフォルト:** *(未設定 — 学習された k̂ が修正なしで適用される)*
- **ステータス:** ACTIVE
- **説明:** 使用量レポートが誠実なトークナイザのスケールを超えて膨張するアップストリーム向けの、ルートごとのエスケープハッチ (#3211: リレーのマークアップ / トークン以外の集計により k̂ ≈ 1.86–1.97 が学習され、決定メーターが永続的にプレッシャーバンドに固定される — このバンドは成長ゲート + キャデンスをバイパスするため、数千トークン単位の保留分が蓄積するたびに、ラインを下回る程度に回復する別のフォールドがトリガーされ、高頻度で小規模な変動（チャーン）が発生する）。使用量ストリームのみでは、bili は本当に高密度なトークナイザと膨張したレポートを区別できないため、このポリシーはルートごとにオプトイン方式であり、k̂ の公開（PUBLICATION）時に適用される — 学習されたリングは監査のために `stats.calibrationRing` に生データのまま保持され、変更されるのは適用係数 (`stats.calibratedEstimate`) のみである:
  - `"disabled": true` — このルートでは学習された係数を絶対に適用しない; 決定メーターはローカル推定値の生データで動作する。
  - `"max": <number>` (0 < max ≤ 4) — 適用係数を ≤ max にクランプする。`1` = 縮小の学習のみを許可（膨張は許可しない）: ローカル推定値よりわずかに少ない金額で請求している誠実なルートでも、その修正から恩恵を受ける。
  - 両方を設定可能; `disabled` が優先される。
  マッチングは、他のプロバイダーフィールドと同様に、最長 URL プレフィックスルールに従う（パススコープのキーを含む）。効果は、そのルートの次の k̂ 公開時に発効する（≤ 3 回の確定ターン）; ポリシーを削除すると、次の公開時に学習された値が復元される。無効な値（型エラー、空オブジェクト、(0, 4] 範囲外の `max`）は、設定の読み込みを明確に拒否する。

### `models`

- **型:** `Record<string, { context?: number; output?: number; compress?: CompressSettings; benefit?: boolean }>`
- **デフォルト:** *(なし)*
- **ステータス:** ACTIVE
- **説明:** モデル名をそのコンテキストウィンドウ宣言にマッピングする。LLM の `/models` エンドポイントはコンテキストウィンドウを返さない（OpenAI、Anthropic、zhipu、comfly で検証済み）ため、プロキシは実行時にそれらを発見できない。`context` はトークン単位のモデルのコンテキストウィンドウ; `output` は最大出力サイズであり、リクエストに出力予算フィールドが全くない場合の出力ヘッドルームのフォールバックとして機能する（[`outputHeadroomMaxPct`](#outputheadroommaxpct) を参照）。また、#546 の出力予算復元にも下限として機能する: クライアント自身の `max_tokens` がツールを持つメインリクエストで ≤ 200 に飢餓状態になった場合、プロキシはそれをセッションの最後の健全な予算に復元し、その復元ターゲットはモデルの既知の最大出力上限で下限が設定される — クライアント報告の実行時情報 > ランチャーチャネル > この宣言値 > models.dev レジストリ一覧 (#1665/#1840)。どのソースもモデルの出力上限を知らない場合、プロキシはモデルごとに一度だけ警告をログに記録する: その場合、復元はクライアントの最後の非飢餓値にのみ依存し、最大トークン数で長いセッションが切り詰められる可能性がある。

  **解決順序（最初の一致が優先）:** (1) リクエストごとのソース — クライアントの `anthropic-beta` による大規模コンテキスト交渉、協調プラグインの報告、ランチャーのモデルごとのウィンドウ; (2) このモデルごとの `context` 宣言; (3) モデルがリストされている場合の **ウォーム** な models.dev レジストリキャッシュ（リレー/プライベートホストは、レジストリのプロバイダー接頭辞付きエントリに対して素のモデル名を照合する）; (4) 組み込みコンテキストテーブル。したがって、このモデルごとの `context` 宣言は **レジストリより優先される** — リレー/プライベートデプロイメントが実際に提供するウィンドウに設定すれば、models.dev がモデルに対して異なる（通常はより大きな）ウィンドウをリストしていても、こちらが優先される。すべてのルートでウィンドウを固定したい場合、`compress.modelContextLimit` が最優先ソース（常に優先）として残る。各モデルエントリには、モデルごとの `compress` ブロック（[圧縮チューニング](#compression-tuning) を参照）および #1884 の再署名アームのモデルレベルノブ: `benefit: true | false` — このモデルが CodeArts の無料クォータに対して請求されるかどうか（その再署名リクエストは署名済み `maas_type: benefit` ヘッダーを持つ; 環境変数 `BILI_RESIGN_BENEFIT` がツリー全体に対して優先され、未設定の場合は組み込みの `glm-5.3-flash, deepseek-v4.1-flash` セットにフォールバックする）— を持つことができる。

  組み込みコンテキストテーブル（ステップ 4）はリリースごとに同梱される静的データであり、古くなる可能性がある — 例えば、DeepSeek の正規リクエスト ID `deepseek-flash` は models.dev にその名前でリストされていない（そのウィンドウは `deepseek-v4-flash` の下にリストされている）ため、テーブルのみが回答していた (#852)。ログはどのソースが優先されたかを記録し、プロセスごとにモデルごとに一度だけ（`[window] ... fallback=true` は値が組み込みテーブルから来たことを意味する）。解決されたウィンドウが誤っているように見える場合、上記のように `models.<name>.context` を宣言する — レジストリとテーブルの両方より優先される — または `compress.modelContextLimit` を固定する; そして、プロバイダーキーはトラフィックのスキームを持たなければならないことを忘れないでください（MITM ログインクライアントトラフィックには `mitm://<host>`、`/bili/` トラフィックには `https://<host>`）。

### `proxy`

- **型:** `string`
- **デフォルト:** *(トップレベルの `proxy` を継承)*
- **ステータス:** ACTIVE
- **説明:** プロバイダーごとのアップストリーム HTTP プロキシ (`http://host:port`)。このプロバイダーに対してのみ、トップレベルの `proxy` を上書きする。空文字列は「明示的に直接接続」を意味し、この 1 つのプロバイダーに対してプロキシなしでグローバルプロキシを上書きする。

### `compressProtocol`

- **型:** `"tools" | "marker"`
- **デフォルト:** `"tools"`
- **ステータス:** ACTIVE
- **説明:** 圧縮ツールをリクエストに注入する方法。`"tools"`（デフォルト）は、ネイティブな関数呼び出しツールとして注入する。`"marker"` は代わりにテキストトリガープロトコルを使用する — 宣言された `tools` フィールドと共存できないアップストリームに使用する。

### `protocol`

- **型:** `"anthropic" | "openai" | "responses" | "google"`
- **デフォルト:** *(なし — リクエストパスから推論)*
- **ステータス:** ACTIVE
- **説明:** このレーンのワイヤプロトコルを宣言する (#1909)。組み込みサフィックステーブル（`/chat/completions`, `/messages`, `/responses`, Google パス）に一致しないエンドポイント向け。2 つの粒度: 素のホストキー (`"https://relay.example.com": { "protocol": "openai" }`) は、そのホスト配下のすべてのボディ付き POST をカバーする; パスキー (`"https://relay.example.com/my/custom/complete": { "protocol": "openai" }`) は、そのサブツリーのみをカバーする。これは、クライアント側の `/bili/<protocol>/<origin>` エスケープハッチのサーバー側対応であり、ベース URL を変更できないクライアント（カスタムエンドポイントパスを持つリレー、MITM 拦截されたホスト）をカバーする。優先度: `/bili/<protocol>/` の明示的マーカーは **宣言より優先され**、宣言は組み込みサフィックステーブルより優先される。宣言はリクエストを *識別* するだけであり、セーフティネットを緩和しない: 宣言されたプロトコルとしてパースできないボディはそのままリレーされる (#1284)、ボディのない GET は決して宣言されたプロトコルにはならない。

  **クライアント側対応 — `/bili/<protocol>/<origin>` エスケープハッチ:** クライアントのベース URL を *制御* できるが、エンドポイントパスが非標準である場合、設定を完全にスキップしてプロトコルを URL 自体に含める:

  ```text
  http://127.0.0.1:8787/bili/openai/https://relay.example.com/api/custom/complete
  ```

  `<protocol>` ∈ `anthropic` | `openai` | `responses` | `google`。パスに関係なくワイヤプロトコルを強制し、すべてのサーバー側宣言（および組み込みサフィックステーブル）より **優先される**。プロトコルセグメントなしのプレーン形式 (`/bili/<absolute-url>`) は変更なし: プロトコルは依然としてパスから推論される。クライアントごとに URL 形式を使用し、ベース URL を変更できない場合（ハードコードされたエンドポイント、MITM 拦截されたホスト）は、レーンごとにこの `providers.protocol` フィールドを使用する。

  **シャドウイングなし (#1909):** `protocol` は他のプロバイダーフィールドとは独立して解決される — すべての一致キーが最長プレフィックス優先でスキャンされ、`protocol` を *明示的に宣言* した最も深いキーが優先されるため、ホストキーの宣言はサイレントなパスキーの下でも適用され続ける（重複は不要）。*他の* フィールドは、既存の単一エントリ最長キーセマンティクスを維持する: すべてのパスキーと同様に、プロトコル専用のパスキーはそのサブツリーの下で勝利するエントリとなるため、URL スコープのフィールド（`compress`, `models`, …）のホストレベルの値は、パスキーで繰り返されない限り、そのサブツリーには到達しない。1 つの例外: `compressProtocol` はアップストリームオリジンに対してのみ解決されるため、そこではパスキーがホストレベルの値をシャドウすることはできない。`protocol` を含まないパスキーは、依然としてルーティング設定にすぎない; `mitm://` キーは他のすべてのフィールドと同様のスキーム分割に従う。無効な値は設定の読み込みを明確に失敗させる（Web 保存は 400 を返す）。

### `compress`

### `compat`

- **型:** `{ roles?: Record<string, string>; dropFields?: string[] }`
- **デフォルト:** `{}` (無効)
- **ステータス:** ACTIVE
- **説明:** プロバイダーごとのワイヤ互換性オーバーライド。`roles` はメッセージロールを、このアップストリームが受け入れるロール名にマッピングする。例えば、新しい codex クライアントが送信する `developer` ロールを拒否するアップストリーム向けに `{"developer": "system"}` (#552)。最終的に転送される `openai`/`responses` ボディ（クライアント送信のロールと、bili 自身が注入したプロンプトの両方）および、compress-retry ループが再送信するすべてのボディに適用される。グローバル `compat` ブロック（[サーバー設定](#server-settings) を参照）に対してキーごとに優先される。`dropFields` は、厳格なスキーマのアップストリームが拒否するクライアント固定フィールドを削除する (#1757): ドットパスのプレーンオブジェクトパス（ワイルドカード/インデックスなし）、グローバルリストと **加法的に** マージされる（プロバイダーはパスを追加できるが、グローバルなものを撤回することはできない）; 構造的な削除のみ — 文字列値は変更されず、存在しないパスはスキップされ、何も一致しない場合はバイト単位でそのまま転送される。正規ケース — SenseNova の Responses ゲートウェイは、pi-ai の固定 `reasoning.summary: "auto"` で 400 を返す:

  ```jsonc
  {
    "providers": {
      "https://token.sensenova.cn/v1": {
        "compat": { "dropFields": ["reasoning.summary"] }
      }
    }
  }
  ```

### `passthrough`

- **型:** `boolean`
- **デフォルト:** *(なし — 圧縮が有効)*
- **ステータス:** ACTIVE
- **説明:** グローバル [`passthrough`](#passthrough) 設定のルートごとのオーバーライド。`true` の場合、このルートに一致するすべてのリクエストは **バイト単位でそのまま** 転送される: カーネル往復なし（メッセージの再シリアライズなし、ACP レンダリングタグなし、`prompt_cache_key` の削除なし）、レスポンスはそのままパイプされ、そのルートに対してセッション状態は作成されない。bili が書き換えたボディを拒否する不正アクセス防止フィンガープリンティングを持つアップストリームに使用する — 例えば、カーネル再構築された `messages` ボディに対する ZCode の `405 / 3012`（「異常な活動のためリクエストがブロックされました」）(#661)。`mitm://` キーはそのホストの MITM（ログインクライアント）トラフィックのみを対象とし、プレーンな `https://` キーは `/bili/`（API キー）トラフィックのみを対象とする — 2 つのスキームは決して重複しない:

  ```jsonc
  {
    "providers": {
      "mitm://zcode.z.ai": { "passthrough": true }
    }
  }
  ```
### `direct`

- **Type:** `boolean`
- **Default:** *(なし — ルートは bili を経由する)*
- **Status:** ACTIVE
- **Description:** クライアントサイドルーティングの例外 (#1622): `true` の場合、このアップストリームは**クライアントサイドで**決して bili を経由しない。ストア書き換えネイティブレーン（現在は ZCode）は、プロバイダストアのエントリをラップする代わりにマッチしたエントリをスキップするため、トラフィックはクライアント → アップストリームへ無加工で流れる — [`passthrough`](#passthrough) とは異なり、プロキシで終端しない。他のすべてのプロバイダフィールドと同様に、最長 URL プレフィックスルールでマッチするため、どのレーンでも同様に適用できる。クライアントの実際のオリジンを確認する必要があるアップストリーム（例: リクエスト署名がオリジンから導出されるアカウント）や、このマシンの bili を経由させたくないプロバイダに使用すること:

  ```jsonc
  {
    "providers": {
      "https://api.moonshot.cn/v1": { "direct": true }
    }
  }
  ```

### `imageBilling`

- **Type:** `"auto" | "pixels" | "bytes"`
- **Default:** *(グローバル `imageBilling`、次に `"auto"`)*
- **Status:** ACTIVE
- **Description:** サイズゲートによるインライン画像の課金方法のルート別オーバーライド (#767/#1843)。バイトカウント方式のリレーには `"bytes"` を設定する — バイト課金では、古いウィンドウ外のベースラインと大きな base64 スクリーンショットにより、アップストリームでは画像が数千トークンしか課金されないにもかかわらず、プリフライトが永遠に 502 で失敗する。これがまさに、未知のホストに対するデフォルトではなく、明示的なオプトインとして `"bytes"` が扱われる理由である。両レベルで未設定の場合、すべてのホストに対して課金は `"pixels"` に解決される (#1843: ピクセル事前分布 — スクリーンショットあたり約 1k–3k トークン — はすべてのビジョンエンコーダにとって適切な桁数であり、旧来のバイトデフォルトは非 OpenAI アップストリームで最大 15 倍の誤差があった)。`BILI_IMAGE_BILLING` 環境変数は両方の設定レベルをオーバーライドする:

  ```jsonc
  {
    "providers": {
      "https://relay.example.com/v1": { "imageBilling": "bytes" }
    }
  }
  ```

### `imageTokenCap`

- **Type:** 正の整数 (1 画像あたりのトークン数)
- **Default:** *(グローバル `imageTokenCap`、次に未設定 — 上限なし)*
- **Status:** ACTIVE
- **Description:** 1 画像あたりのトークン推定値のルート別上限 (#1843)。このルートで解決された課金モードの上に適用される。グローバル `imageTokenCap` より優先される。`BILI_IMAGE_TOKEN_CAP` 環境変数は両方より優先される。数値でないか正でない値は破棄される (寛容なパース、`imageBilling` と同じ)。

---
## モデルエンドポイントパターン

`modelEndpointPatterns` は、非標準パス上のモデルエンドポイントを宣言します。これは、組み込みのワイヤファミリーのいずれにも該当しないパス形状を持つ URL（例: `https://api.commandcode.ai/alpha/generate`）を指します。宣言がない場合、そのようなリクエストはゼロ圧縮でバイト単位そのままリレーされます（#1290）。宣言がある場合、両方のゲートがこれらについて合意します。クライアント側のフェッチパッチがリクエストを主張し、プロキシが宣言されたワイヤファミリーに分類します。

- **型:** `{ "match": string, "wire": "anthropic" | "openai" | "responses" | "google" | "commandcode" }` の配列
- **デフォルト:** `[]`（組み込みパステーブルのみ）
- **ステータス:** ACTIVE
- **説明:** 各エントリは、絶対 URL プレフィックスと、それをどのワイヤファミリーとして扱うかの指定です。最長一致プレフィックスが優先されます。一致には、同一オリジンとパスセグメント境界が必要です（`…/alpha/generate` は自身とサブパスには一致しますが、`…/alpha/generate2` には一致せず、他のオリジンには決して一致しません）。1 つの設定ソースが、すべてのネイティブエントリにおいてプロキシのプロトコル分類器とクライアント側のフェッチ主張の両方に供給されるため、以前はハードコードされていた 2 つのテーブルが乖離することはなくなります（#1295）。パス書き換えを行うプロバイダーでは、2 つのゲートが異なる URL に一致することに注意してください。クライアント側の主張はクライアントが呼び出した URL に、プロキシの分類器はルート書き換え後の URL に一致します — **リクエストが実際に到達する URL を宣言してください**（`upstreamPath` 書き換えがある場合、それは書き換え後のパスです）。ユーザー情報（`https://user:pass@host/…`）は起動時に明確に拒否され、`search`/`hash` コンポーネントも同様です。ボディベースの曖昧さ解消は依然として適用されます（#1284）：モデル会話のように見えないボディを持つ宣言済みエンドポイントはそのままリレーされ、変換可能なストリーミング CLI 会話でない `commandcode` ボディも同様です（[wire-contracts.md](wire-contracts.md)）。4 つの標準ファミリーは分類のみを変更し、そのパイプラインは変更なしで実行されます。`commandcode` は commandcode CLI ワイヤです：openai-completions 形状の会話の周りにネストされたエンベロープで、生の JSONL イベントストリーム応答を持ちます。ストリーミングリクエストは OpenAI ファミリーループを通じて圧縮されます（プロキシモードとプラグインモードの両方）、非ストリーミングリクエストはそのままリレーに降格されます。宣言はプロセス起動時に読み込まれます — 変更を適用するには bili（およびエンドポイントの主張が必要なフェッチパッチを持つネイティブクライアント）を再起動してください。不正なエントリは静かに破棄されるのではなく、起動時の明確な失敗となります。

  ```jsonc
  {
    "modelEndpointPatterns": [
      { "match": "https://api.commandcode.ai/alpha/generate", "wire": "commandcode" }
    ]
  }
  ```

---

## 圧縮チューニング

圧縮の動作は `compress` ブロックによって制御され、3 つのレベルで出現できます。これらは**フィールド単位で、最も深いレベルが優先**してマージされます：より深いレベルで設定されたフィールドは、上位の同じフィールドを上書きしますが、より深いレベルで*未設定*のフィールドは、上位で設定された値をクリアすることはありません。つまり、子ノードはフィールド単位で親ノードをカバーし、オブジェクト全体を置き換えることはありません。

### 共有外部サマリーサービス

任意の `compress.externalSummary` ブロックは、圧縮サマリーを個別に設定された 1 つ以上のモデルに送信します。他のすべてのフィールドと同様に、このブロックは 3 つの `compress` レベルすべてに存在し、チェーン全体のセマンティクスを持ちます：より深いレベル（プロバイダーまたはモデル）で設定されたチェーンは、それより上位の**チェーン全体を置き換えます** — `tiers` と全く同じように、ターゲット別や予算別の部分マージはありません。`enabled` が `true` でない限り無効です。有効な場合、ターゲットは順序通りに試みられ、失敗または使用不能なターゲットは次のものにフォールスルーします。メインリクエストのプロバイダー、モデル、認証情報は、これらの呼び出しのために再利用されることはありません。この機能は圧縮ツール契約を変更し、`summary` を任意の非権威的なヒントにします。プロキシは元のメッセージを復元可能な状態に保ち、検証された返されたサマリーのみをコミットします。会話モデルがコミットされたサマリーを書き込まなくなったため、チェーンが有効な間、注入される圧縮プロンプトはサマリー作成ルール（`HOW TO COMPRESS`、`KEEP VERBATIM`、`DROP`、`PRIORITY`）とサマリーごとの長さ予算を削除します。サマリーリクエスト自体は依然として完全なルールを持ちます（#4460）。

ターゲットは **`providers` テーブルへの参照**です：各エントリは文字列 `"provider/model"` で、`provider` は*名前付きプロバイダーレシピ*（ダイヤルフィールドを持つ非 URL の `providers` エントリ）であり、`model` はその `models` マップのキーです。エンドポイント、プロトコル、認証情報はレシピから導出され、ターゲットごとに URL を繰り返す必要はありません：

```json
{
  "providers": {
    "glm": {
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "api": "openai",
      "apiKeyEnv": "GLM_API_KEY",
      "models": { "glm-4.9-flash": { "outputTokens": 4096 } }
    },
    "claude": {
      "baseUrl": "https://api.anthropic.com",
      "api": "anthropic",
      "credentialRef": "primary",
      "models": { "claude-haiku-4.5": {} }
    }
  },
  "compress": {
    "externalSummary": {
      "enabled": true,
      "targets": ["glm/glm-4.9-flash", "claude/claude-haiku-4.5"],
      "budget": { "totalTimeoutMs": 50000, "targetTimeoutMs": 25000, "maxSummaryBytes": 65536 },
      "concurrency": 8,
      "autoFold": true,
      "autoFoldTargetTokens": 40000
    }
  }
}
```

レシピには以下が含まれます：`baseUrl`（HTTPS。ローカル開発用にループバック HTTP を許可。埋め込み認証情報、プロキシ再帰パス、任意のクエリパラメータは不可）、`api`（`openai` | `anthropic` | `responses` | `google` のいずれか。ワイヤプロトコルを選択し、`baseUrl` からリクエストパスを導出）、認証情報参照はちょうど 1 つ — `apiKeyEnv: "VAR_NAME"`（呼び出し時に読み込まれる環境変数）または `credentialRef: "NAME"`（Web UI 経由で保存された値）—、そしてモデルごとのフィールドを持つ `models` マップ。モデルごとのフィールドは `contextWindow`（デフォルト 128000）、`outputTokens`（デフォルト `min(8192, window/4)`）、`stream`（デフォルト false）です。レシピは URL エントリと同様に `recipe`/`bind` ルーティング形式に分割することもでき、名前付きエントリはバインドされない限りルーティング無効です。

チェーンあたり最大 16 個のターゲットがサポートされます。Web API 経由で有効なチェーンを保存すると、すべての参照が解決できることが検証されます（不明なプロバイダーまたはモデル → HTTP 400）。実行時に解決できない参照は 1 回ログに記録され、修正されるまでチェーンが無効になります — メインモデルでのサマリー化にフォールバックすることはありません。`secret:` 値は、メインの JSON 設定とは別に、プライベートな `billion-context.json.summary-credentials.json` ファイルに保存され、設定 API によって返されることはありません。Windows では、このファイルとその親ディレクトリを管理者専用の ACL で保護してください。古い `.lock` ファイルは、プロキシプロセスがストアに書き込んでいないことを確認した後、手動で削除する必要があります。総予算はすべてのターゲットと圧縮エントリポイント間で共有され、キャンセルまたはセッション状態の変更は、折りたたみ（フォールド）せずに生成された結果を破棄します。エージェント側のプラグインブリッジ（dsh / pi / opencode / codex MCP）は、各 `compress` 呼び出しの HTTP 待機時間を `totalTimeoutMs` に小さなオーバーヘッドマージンを加えた値に設定します — ブートストラップ時にプロキシから学習 — したがって、この予算を引き上げても、長いフォールドが隠れた 60 秒のクライアント側タイムアウトで制限されなくなります（#2652）。

`concurrency`（整数 `1..32`、デフォルト `4`）は**プロセス全体のサマリーキュー**のサイズを決定します：このホスト上のすべての外部サマリー呼び出し — *すべての*セッションのプリフライト自動フォールドと、モデルが開始するすべての `compress` 呼び出し — は、実行中リクエストの 1 つのプールを共有します。サマライザーに余裕がある場合（ローカルリレー、セルフホストモデル、高クォータのフラッシュエンドポイント）には引き上げてください。小規模なプロバイダークォータでは保守的なデフォルトを維持してください。チェーンの値は、そのチェーンの作業が実行中である間のみ共有プールのサイズを変更します。異なる値を持つ複数のチェーンが並行して実行される場合、プールは最大の要求に成長し、それらのバッチが落ち着くとベースサイズに戻ります — 1 つのセッションが他のすべてのためにプールのサイズを永続的に変更することはできません。このノブは**成長のみ**であることに注意してください：1 つのセッションがプールのサイズを引き上げても、他のセッションの実行中作業をスロットリングしてはならないため、デフォルト未満の値（`1..3`）は検証のために受け入れられますが、プールを `4` 未満に縮小することはありません — クォータ保護を期待して低い値を設定しないでください。代わりに、チェーン自身の `budget`/`targetTimeoutMs` を設定してください。

予算との相互作用：バッチの達成可能なフォールドレートは、プール（`concurrency`）に収まる呼び出しの数と、各呼び出しが許容される時間（`targetTimeoutMs`）によって制限されます — 予算だけでは結果を制御できません。飽和したプールは可視的なエラーとして表面化しません：総期限が切れた時点でまだキューイングされているバッチは、試行が記録されず（`attempts=[]`）、`batch=deadline` として破棄され、フォールドパスは混雑の背後にさらなるラウンドをキューイングする代わりにそこで停止します。自動フォールドでは、これは一時的なスケジューラ混雑として扱われ、**チェーンの失敗ではありません**：10 分間のバックオフは設定されず、次のターンで（おそらく空になった）プールに再試行されます。ターゲットへの直接呼び出しが素早く成功しているのにこれらの行が見える場合、制約条件はタイムアウトではなくプールです。

期限セマンティクス（#4833）：`targetTimeoutMs` はすべての単一ディスパッチに上限を設けます — 1 つの遅い呼び出しが `totalTimeoutMs` 全体を使い切ることはできません。1 ターゲットのチェーンであっても同様です（フォールスルー順序の各ターゲットは、共有総量から引き出される独自の新しい `targetTimeoutMs` ウィンドウを得ます）。期限が切れた場合、実行中の試行は中止され、**再試行されません**：有界リトライループ（`attempt 1/3`）は、一時的なプロバイダー判定（429/5xx/リスク管理ボディマーカー）とフェイルファストなネットワーク死のみを再ディスパッチします。期限による中止は試行を即座に終了します。失敗ログは、どのクロックが期限切れになったかを特定します：試行ごとの警告行にはソース — `target-timeout`、`batch-deadline`、または真のダウンストリームキャンセルのための `client-abort` — と安全な診断情報（経過時間、適用中の予算、ワイヤプロトコル/ストリームモード、ペイロードバイトサイズ、入力トークン推定値、出力文字数上限）が含まれ、`completed N/M range(s)` 行は各試行の詳細を記録します（`attempts=[t0:timeout (target-timeout 25000ms (elapsed 25002ms))]`）。`compress` 呼び出しが完全に失敗した場合、同じ診断情報がツール結果に乗ります。大規模コンテキストワークロードのサイズ設定：非ストリーミングサマリーは、最初のバイトが到着する前に完全な生成レイテンシを支払うため、`targetTimeoutMs` は、最大の予想入力に対する入力処理と完全なサマリー生成をカバーする必要があります — 数十万トークンは、遅いエンドポイントでは 25 秒のデフォルトを容易に超えます。大きなフォールドで `target-timeout` が見える場合、チェーンを無効にするのではなく、`targetTimeoutMs` を引き上げてください（そして、予想されるフォールスルー深度に対して `totalTimeoutMs` が十分大きくなるようにしてください）。

2 つの任意のノブが、チェーンを**プロキシ駆動の自動フォルダー**（`autoFold`）に変えます：`"autoFold": true` を設定すると、プロキシはモデルが圧縮ツールを呼び出すのを待たなくなります — オーバーフローウィンドウを保護するのと同じゼロモデルフォールディングエンジンが、外部チェーンとカーネル選択範囲を使用して、転送する*前に*会話を `autoFoldTargetTokens`（デフォルト：モデルウィンドウの半分）まで折りたたみます。モデルはナッジを見ることも、圧縮計画を作成するために思考トークンを消費することもありません。このノブはブロックの残りの部分と同様に、チェーン全体の置き換えセマンティクスを持ちます。チェーン自体が有効な間のみ効果が現れます — 無効（または `enabled` が省略された）チェーンにどちらかのノブを設定しても効果はなく、静かに失敗するのではなく、警告として 1 回ログに記録されます。`autoFoldTargetTokens` は `[8192, 10000000]` の範囲の整数でなければなりません。失敗はフェイルオープンです：フォールド時にチェーンがエラーになると、リクエストはそのまま転送され、10 分間のバックオフが自動フォールディングを抑制し、そのウィンドウの間は従来の助言ナッジが戻ります。1 つの例外（#2662）：共有プールが飽和しているため、バッチは送信されたがサマリー呼び出しが一度もディスパッチされなかったことによる、純粋なキュードロップによるゼロ進捗フォールドは、スケジューラ混雑でありチェーンの失敗ではないため、バックオフを設定しません。自動フォールドは単に次のターンで再試行します。

自動フォールドの成長トリガーは利益ゲート付き（#3444）であり、単純な閾値超過ではありません：成長フォールドは、テキストチャネルが有効なターゲット予算を少なくとも **4096 トークン**超過した場合にのみ設定されます — ターゲットに達している（またはわずかに超過している）ペイロードは、固定コスト未満を節約するために完全な外部サマリー往復を消費するのではなく、そのまま転送されます。同じゲートはフォールド後にも適用されます：4096 トークン未満しか節約できない成長フォールドは、ゼロ進捗パスと同様に 10 分間のバックオフを設定します。画像中心のペイロードは免除されます（画像は折りたたみ可能ではないため、その超過分は「期待される利益」として扱われない）、従来のオーバーフローフォールディングは変更されません — そこでは発火が必須です。さらに、有効なターゲットには**測定された下限**があります：セッションの不可約化ベースライン（システムプロンプト + ツール定義 + ライブテール）が設定された `autoFoldTargetTokens` より大きい場合、ターゲットはその測定サイズに引き上げられ、警告が実際の数値を特定します — 到達不可能なターゲットは、それ以外の場合、すべてのリクエストで無駄なフォールドを再設定することになります。下限は、ターゲットをモデルウィンドウ以上には引き上げません。

#### エージェント報告プロバイダー（フォールバックレイヤー）

ACP ネイティブエージェント（現在は `pi` 拡張機能）は、プロセスごとに 1 回、自身で設定されたプロバイダーをプロキシに報告します（`POST /__bili/agent-providers`）：プロバイダー名、ベース URL、ワイヤプロトコル、解決された API キー、モデルリスト。これらのレシピは**フォールバックレイヤー**を形成します — チェーンは `"zhipu/glm-5"` を参照できますが、ファイル内でダイヤルフィールドを重複させる必要はありません。したがって、エージェント自身の設定で一度設定されたプロバイダーは、サマリーターゲットとして直接使用できます。マージ順序は**ファイル優先**です：同じ名前を持つファイルのレシピは、そのプロバイダーに対してエージェントの貢献を完全にシャドウします（モデルを含む）。エージェントレイヤーはディスクに永続化されません：キーはプロキシプロセスメモリ内にのみ存在し、設定 API によって返されることも、ログに表示されることもありません。報告側のスキップルール：OAuth 認証プロバイダー、`auth.json`（"stored"）認証情報、プロキシ自身を指すエンドポイントを持つプロバイダー、サマリーダイヤルのないワイヤプロトコル（`bedrock`、`vertex`、`mistral`、`pi-messages`）は報告されません。プレーン HTTP の非ループバック baseUrl も送信されません（サーバーはそれらを拒否します — インライン apiKey は平文で移動してはならないため、#2585）。受け入れはエントリごとです：拒否されたエントリはログに記録され、レスポンスの `skipped` リストに名前が示されますが、レポート全体を破棄することはありません — 残りのエントリは正常に登録されます。Web UI は、ターゲットドロップダウンでエージェント報告モデルに `(agent)` バッジを付けます。

3 つのレベル、最も広いものから最も具体的なものまで：

1. **グローバル** — トップレベルの `"compress": { … }` キー。すべてのリクエストに適用されます。`injectTool` / `injectNudge` トグルが尊重されるのはこのレベルのみです。
2. **プロバイダーごと** — `providers[url]` エントリ内の `"compress": { … }` ブロック。
3. **モデルごと** — `providers[url].models[model]` エントリ内の `"compress": { … }` ブロック。

各リクエストについて、プロキシは最長 URL プレフィックス一致（プロバイダーを見つけるため）とリクエストのモデル名（モデルエントリを見つけるため）によって設定を解決し、その後、グローバル → プロバイダー → モデルの順にマージします。
### CompressSettings フィールド

#### `modelContextLimit`

- **型:** `number | string`
- **デフォルト:** *(モデルのネイティブウィンドウ)*
- **ステータス:** ACTIVE
- **説明:** トークン単位のコンテキストウィンドウサイズです。これはエンジンが使用率（`usage = tokens / modelContextLimit`）を計算する際の**分母**であり、切り詰め上限ではありません。絶対数（`200000`）またはパーセンテージ文字列（`"80%"` = モデルのネイティブウィンドウの80%、組み込みテーブルまたは models.dev レジストリから解決）を受け入れます。すべてのレベルで省略された場合、ネイティブウィンドウが使用されます。これはモデル制限に対する最優先ソースであり、組み込みテーブル、レガシーなモデル別 `context` フィールド、トップレベルの `modelContextLimit` を上書きします。また、**ハードなプリフライト壁**としても機能します。ペイロードがこの値に達すると、プロキシは転送前に能動的にコンテキストを折りたたみ、折りたたみで下回れない場合は、アップストリームに送信する代わりにリクエストを即座に失敗させます。日常的なコンテキストを小さく保ちつつ、大きな読み取り時にネイティブウィンドウまでバーストできるようにするには、`modelContextLimit` をネイティブ値のままにし、代わりに `maxContextLimit` をソフトターゲットとして使用してください（[エラスティックなヘッドルームを持つソフトターゲット](#soft-target-with-elastic-headroom-1122) を参照）。
- **オーバーフローアームの挙動 (#3450)。** アップストリームが明示的なウィンドウエラーでペイロードを拒否した場合、プロキシはその拒否をリトライ用にアームします。ここで宣言されたウィンドウがアップストリームが示すものと異なる場合、両方の値を名指しした警告を一度だけ記録し、両者のうち小さい方を基準に折りたたみます。エラーボディにトークン数が示されている場合（例: `you requested N tokens (M in the messages, K in the completion)`）、`M` は測定されたペイロードサイズとして計上されます（上限はサイズではないため）、アームが有効の間、`K` はこの壁から差し引かれて適合判定に使われます — アップストリームは同じ予算に対して補完部分の請求を行うことを証明しているためです。次の実際の使用量レポートで、アームと予約は同時に解除されます。宣言が誤っている場合は、このキーを正しいウィンドウに設定してください。警告は消え、折りたたみターゲットもそれに従います。

#### `outputHeadroomMaxPct`

- **型:** `number | string`
- **デフォルト:** `0.25`
- **ステータス:** ACTIVE
- **説明:** コンテキストウィンドウに対する出力ヘッドルーム予約の上限（分数）です。予約量 = `min(max_tokens, pct × window)`。**予算ソース:** リクエストに出力予算フィールド（`max_tokens` / `max_completion_tokens` / `max_output_tokens`）が全く含まれていない場合（例: Codex のネイティブ Responses パスは `max_output_tokens` を送信しない #924）、プロキシはモデルの宣言済み最大出力にフォールバックします。まずルート別の `providers[url].models[model].output` 設定、次に models.dev レジストリの出力上限（オフラインフロアとしてのバンドルスナップショット）を参照し、どちらも存在しない場合は予約を行いません。同じ上限がフォールバック値にも適用されます。この予約により、エンジンのナッジ/切り詰めバンドが `window − reserved` 以下に保たれ、長い返信が「入力 + 出力」をウィンドウを超えさせないようにします — これは出力をウィンドウにカウントする API に適用されます（Anthropic Messages は例外です：その入力制限は `max_tokens` に独立して強制されるため、除外されます）。上限がない場合、登録済み最大出力がウィンドウの大きな割合を占めるモデル（例: 262144 ウィンドウで `maxTokens` 131072）は入力予算の大部分を失い、75% の強制圧縮閾値がフルウィンドウの約3分の1で発火してしまいます。デフォルトの `0.25` は、ウィンドウの25%までの単一ターン返信に対して95%の緊急閾値でのオーバーフローがないことを保証しつつ、その損失を制限します。より長い返信は一度オーバーフローしますが、次のターンのオーバーフロー自己修復によって回復します。なお、この上限は過大予約を緩和するだけです：`max_tokens` が既に `pct × window` 以下の場合、予約は完全な `max_tokens` のままです（レガシー動作とバイト単位で同一）。比率（`0.25`）またはパーセンテージ文字列（`"25%"`）を受け入れます。`0` に設定すると予約を完全に無効にし、`>= 1` にするとレガシーな全機能予約（入力 + 全予算の返信が常に収まる — SGLang/vLLM などの厳格なバックエンドが強制するもの）に戻ります。負の値や解析不能な値は `compress` ブロック全体を拒否します。例: 262144 トークンのウィンドウ、`max_tokens = 131072` → デフォルト `0.25` で 65536 を予約 → 有効ウィンドウ 196608（レガシーの完全予約: 131072）; `max_tokens = 65536` → 65536 を予約 → 196608 のまま（65536 ≤ ウィンドウの25%）。billion-context-pi (`#207`) と #896 により整合性が取られています。

#### `maxContextLimit`

- **型:** `number | string`
- **デフォルト:** `"75%"`
- **ステータス:** ACTIVE
- **説明:** **強制圧縮**ナッジを発火させるコンテキスト使用率の閾値です。使用率がこの比率を超えると、エンジンは成長ゲートと頻度チェックをバイパスするナッジを発火します。比率（`0.75`）またはパーセンテージ文字列（`"75%"`）を受け入れます。値が低いほど早く圧縮されます。カーネルフィールド `nudge.maxContextLimitPct` にマッピングされます。

#### `emergencyThresholdPercent`

- **型:** `number | string`
- **デフォルト:** `"95%"`
- **ステータス:** ACTIVE
- **説明:** 大きなツール出力の**緊急切り詰め**を発火させるコンテキスト使用率の閾値です。比率またはパーセンテージ文字列を受け入れます。`maxContextLimit` 以上である必要があります。カーネルフィールド `nudge.emergencyThresholdPct` および `truncate.threshold` にマッピングされます。

#### `nudgeGrowthTokens`

- **型:** `number`
- **デフォルト:** `50000`
- **ステータス:** ACTIVE
- **説明:** ソフト圧縮ナッジのためのトークン成長ステップです。この数のトークンが圧縮可能になったたびに、ほぼナッジが発火します。値が低いほど、より頻繁にナッジが発生します。カーネルフィールド `nudge.growthFloor` および `nudge.growthCap` にマッピングされます（エンジンの適応バンドをこの固定ステップに平坦化します）。**これを最小のモデルウィンドウに対して比例させること:** T1 マストリガーには圧縮可能コンテンツの1ステップ分が必要であるため、ウィンドウより大きいステップ（例: ~1M ウィンドウに対して `1500000`）は、そのウィンドウ全体でマストリガーを到達不能にします — 使用率パーセンテージの圧力バンドとプリフライトはバックストップとして残りますが、増分折りたたみは沈黙し、ウィンドウ超過リクエスト（セッション中に小さなウィンドウのモデルへのフォーク後によく見られる）は、早期折りたたみではなく、マルチラウンドのプリフライト要約マラソンに直接突入します。

#### `minPressureBenefitTokens`

- **型:** `number` (トークン, ≥ 0)
- **デフォルト:** *(未設定 — カーネルデフォルト `max(5000, context limit × 1%)`)*
- **ステータス:** ACTIVE
- **説明:** 圧力バンドナッジ（使用率が既に `maxContextLimit` 以上）が発火する前に必要とする最小の回収可能トークン量です。圧力バンドは設計上、成長ゲート + 頻度をバイパスするため、決定メーターが膨張して動作しているルート（k̂ 増幅、#3211）では、数千トークンの保留でも別の折りたたみをトリガーします — 各折りたたみはバンドを下回るのに十分な量しか回復せず、すぐに再入します：高頻度・低収益のチャーン（「ラインに達するたびに少し折りたたむ」）。このフロアを上げる（例: ~200k ウィンドウに対して `50000`）と、フロア未満の圧力ナッジは抑制されます（抑制として記録され、`truncate.threshold` が安全弁として残る）。成長がバンドから使用率を外すのに十分な1バッチに蓄積するまで — 正直なルートが成長ゲートから無料で得るリズムです。明示的な `0` はレガシーな任意保留動作に戻します。他の compress フィールドと同様に、グローバル → プロバイダー → モデル間でフィールドごとにマージされます。カーネルフィールド `nudge.minPressureBenefitTokens` にマッピングされます。

#### `requireUsageSampleForPressure`

- **型:** `boolean`
- **デフォルト:** `true` (カーネルデフォルト)
- **ステータス:** ACTIVE
- **説明:** ナッジ計測パスのためのファントム圧力ガードです。ターンが中断された場合、または使用量レポートが届く前にアップストリームのサンプル配信ウィンドウが期限切れになった場合（短TTLキャッシュ環境）、有効なカウンターは請求済み読み取りに依存できず、実際に請求されるものよりも構造的に数倍高くなるローカル文字数ベースの推定値にフォールバックします。そのような読み取りに対して、圧力バンド（使用率 ≥ `maxContextLimit`）は歴史的に即座に EMERGENCY/OVER-LIMIT 注入を発火していました — 悪いメーターと焼けたプレフィックスキャッシュに基づいた破壊的な書き換えです。ガードが ON の場合、推定値読み取りで遭遇した圧力バンドナッジは1ラウンド延期されます：次のリクエストは新しい請求レポート（または出所安定アンカー）を持ち、実際の数値から判断するため、延期のコストはほぼゼロです。ハードオーバーフローバックストップ（`truncate.threshold`、プリフライト出力クランプ）は無条件でアームされたままです。請求済み読み取り（"usage"）とソースマーカーを省略するホストは、バイト単位で同一の動作を維持します；非圧力ティア（成長 / 頻度 / 初見マス）はマーカーを完全に無視します。`false` に設定すると、レガシーな推定駆動圧力注入に戻ります。他の compress フィールドと同様に、グローバル → プロバイダー → モデル間でフィールドごとにマージされます。カーネルフィールド `nudge.requireUsageSampleForPressure` にマッピングされます。

#### `tierNudgeTokens`

- **型:** `object` — `{ "t1"?: number, "t2"?: number, "t3"?: number }` (各値はトークン単位, ≥ 1)
- **デフォルト:** *(未設定 — すべてのティアが導出値を使用)*
- **ステータス:** ACTIVE (acp-kernel >= 0.0.108 が必要)
- **説明:** T1/T2/T3 圧縮パスのティア別トークンマストリガー閾値 (#2376)。デフォルトでは、3つのティアすべてが `nudgeGrowthTokens` から導出されます（T1 = ステップ、T2/T3 = ステップ × 1.5）；このフィールドは各ティアを独立して固定します — 例: 長いタスクでは T1 を攻撃的に保ちつつ、T2 を早期または遅延で蒸留させる。未設定のサブフィールドは、そのティアの導出デフォルトにフォールバックするため、欠落または空のオブジェクトは統合値と完全に後方互換です。変更されるのはトークンマストリガーの比較のみです：カウントトリガー（`tiers.tier2Trigger` / `tiers.tier3Trigger`）、頻度フロア、初見マスバイパス、圧力/緊急ルーティングは既存の基準を維持します。グローバル → プロバイダー → モデル間でサブフィールドごとにマージされます（モデルレベルの `t2` はプロバイダーレベルの `t1` を破棄しません）。カーネルフィールド `nudge.tierGrowthTokens` にマッピングされます。
#### `nudgeModelDecided`

- **型:** `boolean`
- **デフォルト:** *(設定されない限りオフ)*
- **ステータス:** ACTIVE (#2228)
- **説明:** モデル決定による圧縮タイミング。有効化されると、アームされた**ティア1**ナッジ（穏やかな成長または制限超過）は、その助言テキストを即座に注入しません。代わりに、bili はセッションの既にキャッシュされたプレフィックス（同じ system/tools/messages プレフィックス、小さな出力予算、15秒アイドルタイムアウト） üzerinden1つの短い**サイドコール**を送信し、現在のタスクを考慮して、今すぐ圧縮することが純粋に有益かどうか、オプションでどのスパンを折りたたみ、短いトピックを尋ねます。回答は厳密な JSON（`{"compress": true|false, "range": "mNNNNN-mNNNNN"?, "topic": "?"}`）である必要があります；それ以外の出力は失敗として扱われます。有効な「はい」の場合、bili はプログラムで最終化されたスパンを名指しした明示的な圧縮ディレクティブを注入します — 提案された範囲は、ライブの圧縮可能範囲に完全に含まれている場合のみ尊重され、そうでない場合は最大のライブ範囲が使用されます。「いいえ」、不正な回答、またはタイムアウトの場合、このラウンドでは何も注入されません。**3回の連続ハード失敗**の後、次のアームはレガシーな助言に一度フォールバックし、カウンターがリセットされます（自己修復ラダー）。**EMERGENCY** アームと**ティア2/3蒸留**は決定を経由せず、レガシーな助言をバイト単位で維持します。ホスト専用フィールド — カーネルには渡されません。デフォルトではオフです。

#### `nudgeDecisionMaxTokens`

- **型:** `number`
- **デフォルト:** `200`
- **ステータス:** ACTIVE (#2228)
- **説明:** `nudgeModelDecided` が有効なときに実行されるモデル決定サイドコールの出力予算（トークン単位）です。0 より大きい必要があります（無効な値は設定読み込み時に拒否されます）。

#### `requireNudge` / `requireRecommendation`

- **型:** `boolean` (それぞれ)
- **デフォルト:** *(設定されない限りオフ)*
- **ステータス:** ACTIVE (#5683)
- **説明:** 自発的に圧縮するモデルのためのポリシーゲート（フィールドケース: qwen 27b がプロンプトなしで compress を呼び出す）。両方ともホスト専用フィールドであり、カーネルには渡されません。他の compress フィールドと同様に、グローバル → プロバイダー → モデル間でフィールドごとにマージされ、Web パネルのクイック設定カードまたは任意の設定レベルで編集可能で、次のリクエストからホット適用されます。
  - `requireNudge` (タイミングゲート): モデル主導の compress 呼び出しは、NUDGE CREDIT がライブでない限り拒否されます (#5943) — 最後にモデルに実際に到達した圧縮ナッジ（ゲート後の配信事実 `nudgeOutcome === "injected"`：助言ナッジ、モデル決定ディレクティブ、緊急ナッジはすべてこれを発行し、"gated"/"vetoed"/"skipped" ラウンドは決して発行しない）によって発行された20モデルラウンドのウィンドウです。各新しい注入でウィンドウが更新され、ナッジされていない各モデルラウンドで1ずつ減衰します；非モデルリクエスト形状（countTokens / responsesCompact / ローカルフォージ）は更新せずに開いたままにし、1ターン内のループ再リクエストは再スタンプしないため、何も消費しません。成功した折りたたみはクレジットを消費しません — ナッジの推奨クリーンアップを複数ラウンドにわたって完了すること（#5943 が報告するマルチラウンドクリーンアップ拒否ストーム）は、まさにナッジが求めたものです；長期的な厳格さは、ナッジが成長駆動であるため、静かなセッションは20ラウンドのナッジなしで厳格な拒否に期限切れになり、成長しているものはウィンドウを継続的に更新することで維持されます。拒否は、ナッジが表示されるまでここでの無促圧縮は無効であることをモデルに伝えるエラーレシートです。
  - `requireRecommendation` (スコープゲート): 提出されたすべての範囲は、bili が現在折りたたみを**推奨**している範囲内に留まる必要があります — ナッジテキストと `acp_status` が示す同じライブ圧縮可能セット（存在する場合このリクエストの準備時オファー、なければライブ再計算、通常の viable + dead-ref + `minCompressRangeChars` フィルタ付き）。判定は**カバレッジ**によるもので、等価ではありません：推奨スパンをより小さなチャンクに細分することは合格します（bili 自身の初見ガイダンスは分割を奨励する）、そしてアクティブブロックに既に折りたたまれたメッセージは免除されるため、既存ブロックのサマリーを更新する再折りたたみは合法のままです。他のライブメッセージを含む範囲は、問題のスパンを名指しし `acp_status` を指して、全体として拒否されます。
  - 免除と相互作用: bili 自身のオーバーフローバックストップ折りたたみ（プリフライト / オートフォールド — モデル呼び出しなし）は両方のゲートから免除されるため、ゲートされたセッションはコンテキストオーバーフローで死にません；ナッジチャネル自体が抑制されている間でも可用性には影響しません（自己修復 D1）。独自のメカニズムで圧縮を駆動するホスト（例: codex の compaction トリガー、これは bili ナッジではない）は、タイミングゲートの「促された」概念の外にあります — このようなレーンがルートを共有する場合、これらの設定をグローバルではなく影響を受けるプロバイダー/モデルにスコープしてください。新しい環境変数はありません；レベルが明示的にフラグを有効にしない限り、動作は変わりません。

#### `preserveRecentMessages`

- **型:** `number`
- **デフォルト:** *(カーネルデフォルト, `3`; #3058 で `5` から調整)*
- **ステータス:** ACTIVE
- **説明:** 圧縮対象として提供されない最新のメッセージの数です。アクティブな作業セットを保護し、モデルが最新のターンを逐語で保持できるようにします。カーネルフィールド `preserveRecentMessages` にマッピングされます。

#### `preserveRecentTokens`

- **型:** `number`
- **デフォルト:** *(カーネルデフォルト, 通常 `5000`)*
- **ステータス:** ACTIVE
- **説明:** 最近のメッセージ保護のために予約されるトークン予算です。カーネルフィールド `preserveRecentTokens` にマッピングされます。

#### `minCompressRangeChars`

- **型:** `number`
- **デフォルト:** *(カーネルデフォルト, 通常 `5000`)*
- **ステータス:** ACTIVE
- **説明:** メッセージ範囲が圧縮対象となるための最小範囲サイズ（**文字数**、トークンではありません）；より小さい範囲はスキップされます。英語/コードは1トークンあたり約4文字、CJK は約1-2文字であるため、同じ数はトークンベースのメンタルモデルよりも英語テキストに対して約4倍寛容に読まれます。カーネルフィールド `compress.minCompressRange` にマッピングされます。

#### `minCompressRange`

- **型:** `number`
- **ステータス:** DEPRECATED (`minCompressRangeChars` のエイリアス、後方互換性のために保持)
- **説明:** `minCompressRangeChars` のレガシー名 — 同じカーネルマッピング（`compress.minCompressRange`）、同じ単位（文字数）。同じレベルで両方のキーが設定されている場合、正規名が優先されます；レベル間で、どの名前で使われていても深いレベルが優先されます。

#### `maxSummaryLength`

- **型:** `number`
- **デフォルト:** *(カーネルデフォルト `20000`)*
- **ステータス:** ACTIVE (#3635)
- **説明:** 1つの生成サマリーに対する**文字数**でのハード上限です。長い返信は全体として拒否されます — モデル内サマリーに対するカーネルのオールオアナッシング長さチェックと、設定済みチェーンに対する外部サマリー実行器によって（切り詰めなし、リトライなし）。プリフライトとモデルツール圧縮パスの両方が、外部サマライザーにこの正確な上限を事前に伝えます（プリフライトは #1775 から、compress パスは #3635 から）ため、超過は不透明な破棄ではなく、名前の付いたログ理由を持つモデルコンプライアンス失敗になります。`0` は上限を無効にします。カーネルフィールド `compress.maxSummaryLength` にマッピングされます。#3635 以前、このキーはどこでも受け入れられませんでした：パネル PUT はそれをサイレントに破棄し、ファイル編集は解決済み設定に到達しなかったため、有効な値は常にカーネルデフォルトでした。

#### `minSummaryLength`

- **型:** `number`
- **デフォルト:** *(カーネルデフォルト `50`)*
- **ステータス:** ACTIVE (#3635)
- **説明:** 生成サマリーのフロア（**文字数**）；短い返信は全体として拒否されます。`0` はフロアを無効にします。カーネルフィールド `compress.minSummaryLength` にマッピングされます。`maxSummaryLength` と同じ受け入れ履歴 (#3635)。

#### `tiers`

- **型:** `boolean`
- **デフォルト:** `true`
- **ステータス:** ACTIVE
- **説明:** マルチティア圧縮を有効にします — 古いサマリーのティア2蒸留とティア3凝縮。`false` に設定すると、ティア1のみのモードで実行されます（すべてのサマリーがフラットなティア1サマリーになります）。カーネルフィールド `tiers.enabled` にマッピングされます。

#### `protectedLatestTools`

- **型:** `string[]` (ツール名パターン、例: `["todo_list"]`)
- **デフォルト:** `[]` *(なし — クライアントごとにオプトイン、ツール名はクライアント固有)*
- **ステータス:** ACTIVE
- **説明:** その**最新**のツール呼び出し + ペアリング結果が決して圧縮されないツール名パターン（カーネル `protectedLatestTools`、`acp-kernel` >= 0.0.80 が必要）。累積スナップショットツールのために構築されました — 例: エージェントの todo/タスクリスト、新しい結果が古いものをすべて上書きする：ソースオブトゥルースは最新インスタンスのみであるため、**すべての**インスタンスを保護する（`protectedTools` を通じて）と、そのツールの履歴が無制限に成長しますが、**最新**を保護すると、ライブスナップショットをコンテキストに保ちつつ、すべての上書きされたインスタンスが正常に折りたたまれます。これは「圧縮後にエージェントがタスクリストを忘れる」失敗 (#639) を解決します。保護はハード除外です：最新インスタンスはアドレス不能（その参照は `BLOCKED` としてレンダリングされる）であり、提案された範囲でも明示的な compress 範囲でもカバーできません；両方の圧縮モードとすべてのワイヤーで同様に適用されます。パターンは正確なツール名または `*` グローブで一致します（例: `"todo_list"`, `"todo*"`）。`/` を含むパターンは正規スキルパスに一致し、パスごとに最新インスタンスを保護します (#1947)：スキルロードはすべてのクライアントで `skill/<name>` にプロジェクト化されます — opencode `skill({name})`、Claude Code/ZCode `Skill({skill})`、および `<dir>/<name>/SKILL.md` を読む任意のツール — したがって `"skill/*"` はすべてのスキルの最新ロードを保持します（名前ごとに1つの保護インスタンス）、スラッシュなしの `"skill"` はプレーンな単一最新セマンティクスを保持します。最も深く定義されたレベルで配列全体の置換。例: `{ "compress": { "protectedLatestTools": ["todo_list", "skill/*"] } }`。

#### `protectedTools`

- **型:** `string[]` (ツール名パターン、例: `["skill"]`)
- **デフォルト:** `[]` *(なし — クライアントごとにオプトイン、ツール名はクライアント固有)*
- **ステータス:** ACTIVE
- **説明:** ツール呼び出しおよびペアリング結果が**決して圧縮されない — すべてのインスタンス、完全な履歴**（カーネル `protectedTools`）ツール名パターン。保護はハード除外です：すべての一致する参照は `BLOCKED` としてレンダリングされるため、提案された範囲でも明示的な compress 範囲でもインスタンスをカバーできません；両方の圧縮モードとすべてのワイヤーで同様に適用されます。パターンは正確なツール名または `*` グローブで一致します（例: `"skill"`, `"skill_*"`）。`/` を含むパターンは、すべてのクライアントで名前によってスキルを選択します (#1947)：スキルロードは正規パス `skill/<name>` にプロジェクト化されます — opencode `skill({name})`、Claude Code/ZCode `Skill({skill})`、および `<dir>/<name>/SKILL.md` を読む任意のツール — したがって `"skill/release-orchestrator"` はその1つのスキルのすべてのロードを保護し、`"skill/review-*"` は名前セグメント内でグローブ一致します（`*` は `/` をまたがない）、`"skill"` / `"skill/*"` は等価のままです（ノードおよびすべての後継）。`/` を含まないパターンはバイト単位で変更されません。最も深く定義されたレベルで配列全体の置換。例: `{ "compress": { "protectedTools": ["skill/release-orchestrator"] } }`。
- **⚠ どのノブを使用すべきか（設定前に読むこと）:** ツールの結果が互いにどのように関係しているかによって選択してください：
  - **独立したコンテンツ** — 各インスタンスは、後の結果が上書きしない独自の情報を持ちます（opencode/pi `skill` ロード、ワンショット参照）: `protectedTools` を使用します。古いロードを折りたたむとそのコンテンツが永久に失われます；保護はすべてのロードをコンテキストに保ちます (#1109)。1つのオーケストレータースキルのすべてのロードを保護しつつ、より軽いスキルを折りたたませるには `skill/<name>` パスパターンを使用します（`protectedTools: ["skill/release-orchestrator"]`, #1947）。
  - **累積スナップショット** — 新しい結果が古いものを上書きします（クライアントの todo/タスクリスト）: `protectedLatestTools` を使用します。そのようなツールの**すべての**インスタンスを保護すると、その履歴が無制限に成長します — #639 が最新のみを保護することで回避したまさにその失敗です。
  - 経験則: 低頻度、高価値のツール → `protectedTools`；チャッティなツール → 完全な履歴保護はしない（コンテキストが無制限に成長する）；累積スナップショットツール → `protectedLatestTools`。

#### `neverPreserveRecentTools`

- **型:** `string[]` (ツール名パターン)
- **デフォルト:** 未設定 → カーネル組み込み `["decompress", "search_context", "read", "bash"]` (`acp-kernel` >= 0.0.92 が必要)
- **ステータス:** ACTIVE
- **説明:** ソフト保護された最近ゾーン（`preserveRecentMessages`/`preserveRecentTokens`）から**除外**されるツール名パターン：最近ウィンドウ内の一致するツール結果は、最初に老化するのではなく、すぐに圧縮可能になります。カーネルデフォルトは `read`/`bash` を圧縮可能に保ちます。それらが最大の回収可能マスであるため — しかし、同じデフォルトがバッチ読み取りワークフローで新しく読んだファイルをすぐに折りたたみ、フォールド→再読み取りデスループに陥る原因でもあります (#1198/#1277)。**推奨される対策: `read` のみを削除する** — `{ "compress": { "neverPreserveRecentTools": ["decompress", "search_context", "bash"] } }` — 新鮮な読み取り結果を最近ゾーンに保ち、後に位置によって老化させる（`protectedLatestTools` は最新の読み取りを永遠にピン留めするため、それとは異なる）。逐語置換セマンティクスを必要としない場合、よりシンプルな陽性形式 `preserveRecentTools: ["read"]` を優先してください — 次のセクションを参照。`decompress`/`search_context` はリストに保ってください：それらを再包含すると、ちょうど復元されたブロックを最近ゾーンにピン留めし、回収不能にする — 別の病です。**⚠ 空配列 `[]` は有効であり、何も除外しません**（最大保護のエスケープハッチ）— `protectedTools`/`protectedLatestTools` と異なり、空配列は拒否されません；明示的な配列はデフォルトを逐語で置き換え、最も深く定義されたレベルで配列全体の置換。

#### `preserveRecentTools`

- **型:** `string[]` (ツール名パターン)
- **デフォルト:** 未設定 → 減算なし（`neverPreserveRecentTools` ?? 組み込みリストが逐語で支配；`acp-kernel` >= 0.0.93 が必要）
- **ステータス:** ACTIVE
- **説明:** `neverPreserveRecentTools` の**陽性側**の対応物：有効な最近ゾーン除外リストから**削除**されるツール名パターン。#1198/#1277 のバッチ読み取りフォールド→再読み取り対策は、組み込みリストを再記述（または古い手動コピーを凍結）せずに新鮮な読み取り結果を保護し、組み込みの進化に従う1エントリ設定 — `{ "compress": { "preserveRecentTools": ["read"] } }` — になります。有効な除外 = `(neverPreserveRecentTools ?? 組み込み) minus preserveRecentTools`；明示的な `neverPreserveRecentTools` と組み合わせ可能（減算は明示的なリストにも適用）；グローブサフィックスパターンは一致するエントリを減算します（`"bash*"` は `bash` を削除）。逐語置換セマンティクスを本当に必要としない限り、never-list の編集よりもこのノブを優先してください。**⚠ 空配列 `[]` は拒否されます** — ここでは純粋な何もしない操作であるため、単独の `[]` はほぼ確実に `neverPreserveRecentTools: []`（最大保護のエスケープハッチ）のタイプミスです。兄弟ノブと同様に、最も深く定義されたレベルで配列全体の置換。

#### `prompts`
- **デフォルト:** *(カーネルデフォルト — `acp-kernel` の `defaultPrompts` を参照)*
- **ステータス:** ACTIVE
- **説明:** システムプロンプトとナッジメッセージに注入される圧縮プロンプトテキストを上書きします。すべてのフィールドは**荷重**です：カーネルルールは数ヶ月の生産使用で調整されており、それらを上書きするとサマリー品質が低下する可能性があります（パス / シグネチャ / 決定の喪失 → 検索の破損）。上書きは、3レベルマージ後に `acknowledgePromptsRisk` が `true` に解決された場合のみ有効になります — フラグは独自の最も深く定義されたレベルで独立して解決され、各パーツがどのレベルに存在するかに関係なく、**すべての** `prompts` 上書きをゲートします（グローバルレベルのフラグはモデルレベルの `prompts` を有効にする）；それ以外の場合は無視され、一度の警告が記録されます。非文字列フィールドはサイレントに破棄されます（不正な部分が良いデフォルトを上書きすることはありません）。主に非英語または小規模モデルのチューニングに有用 — issue #156 を参照。

#### `acknowledgePromptsRisk`

- **型:** `boolean`
- **デフォルト:** `false`
- **ステータス:** ACTIVE
- **説明:** `prompts` 上書きが有効になるためには `true` である必要があります。他のすべてのフィールドと同様に解決されます（最も深く定義されたレベルが優先）し、各パーツがどのレベルに存在するかに関係なく、すべての `prompts` 上書きをゲートします — 解放する `prompts` と同じブロックに存在する必要はありません。設定すると、上記に文書化されたサマリー品質リスクを承認したことになります。

#### `promptPack`

- **型:** `string` (パック名、例: `"lean"`)
- **デフォルト:** `default` *(未設定は等価 — アイデンティティサーフェス、カーネルデフォルト)*
- **ステータス:** ACTIVE
- **説明:** 名前付きプロンプトパックを選択します — ツール説明、compress システムプロンプトセクション、ナッジセクションをカバーするキュレーションされたサーフェスプリセット — ホストのパックチェーンから解決されます：**プロジェクト** `./.billion-context/packs/<name>.json` → **ユーザー** `<configDir>/packs/<name>.json` → **shipped** (`chat`) → **builtin** (`default`, `lean`)。組み込み `lean` は4つの ACP ツール説明を1行に置き換えます（スニペット/ガイドラインの装飾なし）が、圧縮ルールはデフォルトのままです。組み込み `chat` (#5319) は、長期コンパニオンシップ / マルチセッションメモリ使用のために、compress 哲学と compress 方法の散文のみを書き換えます；他のすべてのサーフェスパーツはホストデフォルトのままです、同名のユーザーまたはプロジェクトファイルがそれを上書きします。不明な名前は一度の警告とともにアイデンティティサーフェスにフォールバックします。他のフィールドと同様の3レベルマージ；パックサーフェスセクション（ツール/セクション上書き）は直接適用され、`acknowledgePromptsRisk` ゲートなし — そのゲートはインライン `compress.prompts` ルールテキスト上書きのみを支配します。なお、パックの `prompts` ブロックはこのプロキシによって無視されます：ルールテキスト上書きはインライン `compress.prompts` を通じてのみ可能です。`acp-kernel` >= 0.0.66 が必要。設定パネルはユーザーディレクトリのファイルを直接管理できます — `<configDir>/packs/` 配下のパックの New/Edit/Delete（ピッカーは各エントリの出所を知っています；組み込みと shipped パックは那里で読み取り専用です、代わりに同名のユーザーパックで上書きしてください）。編集ダイアログには3つのタブがあります (#5344)：**ガイド付きフォーム** — フィールドごとのヘルプテキストと、`default`/`chat`/`lean` から読み込まれるワンクリックベーステキスト（空のフィールドは省略され、実行時にシステムデフォルトにフォールバック）；**AI アシスト** — シナリオを平易な言葉で説明し、生成されたプロンプトを任意の LLM にコピーし、その JSON を貼り戻すとフォームに直接解析されます；**詳細 (JSON)** — 完全な制御のための生ファイルテキスト。

**パックファイル形式。** 各 `<dir>/<name>.json` は1つのパックオブジェクトを保持します。不明なフィールドは、すべての読み込みパスで使用される同じサニタイザー（`sanitizePackSurface`）によって破棄されるため、追加のメタデータは無害です：

```json
{
  "name": "my-pack",          // optional — defaults to the file name without .json
  "version": "1.0.0",         // optional — shown by `bili pack list` and the panel
  "description": "…",         // optional
  "promptSections": {
    "philosophy": "…",        // replace a whole system-prompt section; JSON null keeps the default
    "howToCompress": "…"      // start from the tuned texts in src/chat-pack.ts
  }
}
```

オプションのサーフェスブロック: `prompts` (インラインルールテキスト上書き), `nudgeSections`, `toolPrompts`, および `adapters` (ホスト固有の追加、例: `"pi": { "promptSections": { … } }`)。少なくとも1つの認識されたフィールドがサニタイジング後に残る必要があります。そうでない場合、ファイルは書き込み時に拒否されます。

**他の人のパックのインストール。** ルートに `bili-pack.json`（上記のパックオブジェクト）を含む任意の npm パッケージはインストール可能です：`bili pack install <pkg>` — `name@version`、スコープ付き名、git URL、`.tgz` パスも受け入れます（ローカル `npm` に委譲するため、レジストリ認証は正常に動作します）。ファイルはデフォルトで `<configDir>/packs/` に配置されます（`--project` は `./.billion-context/packs/` をターゲット；`--force` は既存のパックを拒否する代わりに置き換えます）。その後、設定パネルから管理するか、`bili pack remove <name>` / `bili pack list` を使用します。

#### `reconcile`

- **型:** `string` — `"off"` | `"warn"` | `"repair"`
- **デフォルト:** `"repair"`
- **ステータス:** ACTIVE
- **説明:** **フォールド状態の調整** (#1921) を制御します：クライアントが圧縮されたものと*コンテンツ*が乖離した履歴を再送信した場合に何が起きるか — 例: フォークが以前のターンを再シリアライズ (#1908)、クライアントがメッセージバイトをインプレースで書き換え、またはプロバイダーが空白を正規化。デフォルトではメッセージアイデンティティはコンテンツハッシュであるため、1バイトのチャーンは影響を受けたメッセージをすべての圧縮ブロックからサイレントに落とし、生のオリジナルがワイヤーに再入します（「フォールドドリフト」）。`"repair"` モードでは、プロキシはフォールド実行前にメッセージごとにドリフトを分類します：安定したツール呼び出しアンカー（`tool_use_id`）と正規化アイデンティティアンカー（NFC テキスト、CRLF/空白折りたたみ）は、新しいメッセージ ID に圧縮ブロックを再アンカーし、クライアント側のチャーンに対してバイト単位でクリーンな再送信と等価にフォールドを生存させます；真に*編集された*メッセージ（正規化テキストが異なる、または長さが `max(256, 25%)` を超えてドリフト）は、折りたたみずにワイヤーに再入するように残されます — 正直で、決してサイレントな書き換えではなく — 次の圧縮パスがそれらを再折りたたみます。`"warn"` は同じ分類器を実行しますが、発見したものを記録するだけです；`"off"` はレイヤー全体を無効にします（#1921 以前の動作）。環境変数 `BILI_FOLD_RECONCILE` は1プロセスについて設定された値を上書きします。アンカーメタデータはセッションごとに永続化されます（セッションレコードの `foldAnchors`、16384 エントリ上限）で、各ブロックが実際に参照するメッセージをカバーします。システムプロンプトがメッセージチャーンなしで変更された場合、1行の `info` が記録されます（システムのみドリフトはフォールド状態に触れません）。

#### `absorb`

- **型:** `object` (`{ enabled?, minToolTokens?, contextThresholdPct?, excludeTools?, toolName? }`)
- **デフォルト:** *(無効 — `enabled: true` を設定しない限り機能はオフ)*
- **ステータス:** ACTIVE
- **説明:** オプトインの**即時ツール結果圧縮**（issue #605、`acp-kernel` absorb API を通じて）。有効化されると、大きなツール結果は結果時に強制 `[ACP absorb]` 指示を受け、モデルは `absorb` ツールを通じて結果をコンパクトなサマリーに蒸留し、元のツール呼び出し/ツール結果ペアは次のターンからワイヤーから隠されます — フォールドラウンド間のセッション中の圧力を低く保ちます。サブフィールド（他の CompressSettings フィールドと同様に最も深いものが優先してマージ）：
  - `enabled: boolean` — メイナスイッチ；`true` 以外のものは機能を完全にオフに保ちます（ツールなし、プロンプトなし、マーカーなし）。
  - `minToolTokens: number` — このトークン数以上の結果のみがプロンプトされます（カーネルデフォルト 1000）。
  - `contextThresholdPct: number|percent-string` — 使用率が `modelContextLimit` のこの分数に達したときのみプロンプトします（`0` = サイズゲートのみ；`"75%"` は受け入れられます）。
  - `excludeTools: string[]` — 決して absorb されないツール名パターン。**既知の制限:** [ranxianglei/acp-kernel#213](https://github.com/ranxianglei/acp-kernel/issues/213) がリリースされるまで、ツール*結果*に対しては何もしません（ワイヤー投影は結果に `toolName` を持たないため、カーネルの名前ガードが発火できません）。
  - `toolName: string` — 注入されたツールの名前を変更（デフォルト `"absorb"`）；宣伝/注入スキーマ、システムプロンプトセクション、セッションごとの裁定は両方のレーンで名前に従います。**レーンガバナンス (#1359):** プラグインモードは**ベース**設定によって `absorb` ブロック全体を支配するため、名前変更されたツールはその名前で宣伝され、その名前で実行されます（決して乖離しません）；プロバイダー/モデルレベルの `absorb.*` 上書きは**プロキシレーンのみ**です（プロキシはマージされた名前で注入し裁定します）。読み込み時の警告は、ベースから乖離するプロバイダー/モデル `absorb.*` フィールドを列挙します。
  注入はワイヤーのネイティブツールサーフェスに従います：プロキシモードは anthropic/openai/responses ネイティブツールワイヤーでツール（リクエストごとに解決された名前で）+ システムプロンプトセクションを注入し、プラグインモードは**有効な間のみ**プラグインマニフェストで宣伝します（ホストはマニフェストのツールを逐語に登録します — 無効なツールの宣伝はそれらを壊します、#1192；MCP シェルは無料で拾います）。Responses **マーカー/テキストプロトコル**ルートはサポートされていません（ネイティブツールサーフェスなし — REQUIRED absorb 指示は満たせません）、タイトル生成リクエスト（`max_tokens ≤ 200`）は compress プロンプトと同様に注入をスキップします。Absorb されたペアは再起動後も隠されたままです（セッション状態に永続化）。

#### `blockOps`

- **型:** `object` (`{ enabled? }`)
- **デフォルト:** *(オフ — ツールは `enabled: true` の間のみ注入)*
- **ステータス:** ACTIVE (issue #5765)
- **説明:** オプトインの**圧縮ブロックライフサイクル管理**。有効化されると、3つのツールが ACP ツールとともに注入（プロキシレーン）/ 宣伝（プラグインレーン）され、それぞれに独自のシステムプロンプトセクションがあり、プラグインツール API がワイヤーが得た同じ値を解決するように、セッションごとの有効フラグが保存されます：
  - `acp_retire` — アクティブな圧縮ブロックをレジデントビューから移動（そのサマリーはもはやすべてのリクエストに乗らない；`acp_restore` / `decompress` / `search_context` はまだ ID で到達可能）。
  - `acp_restore` — 引退したブロックをレジデントビューに戻す。
  - `acp_rewrite` — ブロックのサマリーをインプレースで置き換え（1ステップロールバックスロット `previousSummary` を保持；同一/空白の書き換えは拒否）。
  カーネル状態変更は冪等であり、バッチ可能（`blockId` 単一または `ids` 配列）。**デフォルトでオフである理由:** 3つのツールスキーマは有効な間、常にオンサーフェスです — 有効なプロキシのすべてのセッションのリクエストごとに約 +0.7k の推定トークン — したがって、オプトインしない限り、サーフェス（ツール配列、プロンプト、マニフェスト）は #5765 以前とバイト単位で同一のまま出荷されます。無効な間の誤った呼び出しは、エラーではなく、モデル向けの「この bili プロキシでは有効になっていません (compress.blockOps.enabled is not true)」レシートを受け取り、状態には決して触れません。引退/書き換え状態はセッション状態で再起動後も永続化され、エクスポート台帳（markdown ハンドオフ + JSONL）は `retired` ステータス、メッセージ参照スパン、オリジナル/サマリー文字数を報告します。

#### `ccr`

- **型:** `object` (`{ enabled?, minToolTokens?, excludeTools?, toolName?, maxHeadChars? }`)
- **デフォルト:** *(v2 からプロキシモードでオン (#1179) — 未設定は `enabled: true` に解決；任意のレベルでの明示的な `enabled: false` はオプトアウト。プラグインレーンはオプトインのまま：明示的なグローバル `enabled: true` でのみアーム、#1271/#1273。)*
- **ステータス:** ACTIVE (v2 — プロキシモードがデフォルト；プラグインモードは明示的に有効な場合の anthropic + openai ワイヤー)
- **説明:** **コンテンツアドレスメッセージストア** / 組み込み CCR (issue #1097/#1179、`acp-kernel` CCR API を通じて、acp-kernel >= 0.0.84)。過大ツール結果を強制蒸留する（`absorb` のように）のではなく、または永遠にワイヤーに乗せるのではなく、カーネルは到着時にそれらを ID 参照します（ccr-store ノードは `processTurn` 内の prune と absorb の間に実行 — ID 参照は蒸留に優先）：ワイヤーは決定的でバイト安定なプレースホルダー（`📦 [acp-stored #m00423 · shell output · 4,213 tok] \`npm run build\`\n   → acp_retrieve("m00423") returns the full text`）を保持し、オリジナルはセッションのコンテンツストアに入ります。モデルは注入された `acp_retrieve` ツールを通じてオンデマンドで完全なオリジナルを取得します；retrieve は一時的です（リクエスト内ツール結果チャネルに乗る、フォールドスペースに入らない、メッセージ参照を消費しない）。デフォルトでロスレス：retrieve を行わないコストは1回の安価なツール呼び出し；absorb で蒸留された詳細は永久に失われます。サブフィールド（他の CompressSettings フィールドと同様に最も深いものが優先してマージ）：
   - `enabled: boolean` — メイナスイッチ。**未設定の場合デフォルトで `true`** (#1179)；任意のレベルでの明示的な `false` が優先し、機能を完全にオフに保ちます（プレースホルダーなし、ツールなし）。プラグインモードのアームはさらに明示的なグローバル `true` を要求します (#1273) — マニフェストはオペレーターが明示的に有効にしたもののみを宣伝します。
  - `minToolTokens: number` — このトークン数以上のツール結果のみが ID 参照されます（カーネルデフォルト `4000`）；小さい結果は逐語のままです。
  - `excludeTools: string[]` — 決して保存されないツール名パターン（グローブサフィックス許可；カーネルデフォルト: なし）。
  - `toolName: string` — 取得ツールの名前を変更（デフォルト `"acp_retrieve"`）；宣言、ディスパッチ、プレースホルダーヒントはすべて名前に従います。クライアント自身のツール名に対して一意である必要があります。
  - `maxHeadChars: number` — プレースホルダー内のヘッド/コマンドプレビュー長さ（カーネルデフォルト `96`）。
  **プラグインレーンガバナンス (#1345):** プラグインモードでは、`ccr` ブロック全体が**ベース**設定に従います — セッションはベースレベルの `enabled: true` でのみアームされ、ベースの `toolName` と閾値で実行されます。なぜなら、プラグインマニフェスト（ホストの取得サーフェスの唯一の宣言）はベース設定のみから構築されるためです。したがって、プロバイダー/モデルレベルの `ccr.*` 上書きはプロキシモードセッションにのみ適用されます（プロキシはマージされたブロックでリクエストごとに宣言しディスパッチします）。すべての乖離した上書きは、設定読み込み時にレベル、フィールド、プラグインセッションが実際に使用する値を名指しした `[acp-config] ccr override ignored in plugin sessions: …` 警告として記録されます。
  ストアはセッション JSON の隣に単一のエンベロープファイル（`.content-store.json`）として永続化され、`BILI_ENCRYPTION_KEY` が設定されている場合、セッションファイルと同じ静止時コーデックを使用します；エントリはコンテンツハッシュで重複排除され、セッションごとに遅延読み込みされます。`tool` 結果内の*コンテンツ*のみが縮小します — アシスタント `tool_calls` とのペアリングには触れません。スコープゲート：**すべてのレーンでオプトイン** (#1207 オーナー決定 — ローカル検証後の任意のレベルで `compress.ccr.enabled: true`)：プロキシモードは有効化されるとアームし、さらにプラグインモードは anthropic + openai ワイヤーで、CCR がグローバルに明示的に有効な間、プラグインマニフェストが `acp_retrieve` を宣伝します (#1271)；responses マーカー/テキストプロトコルルート、`ACP_NO_INJECT_TOOL`、プラグインモードの responses/google ワイヤーは、retrieve を実行するための証明されたリクエスト専用ラウンドトリップチャネルを持たないため、コンテンツを失う代わりにそこでストアを解除します。v2 (#1179) 以降、フォールドもロスレスです：compress フォールドが着地すると、カバーされたオリジナルはストアに永続化されます（first-write-wins、reasoning はスキップ）；したがって `acp_retrieve("mNNNNN")` は折りたたまれたコンテンツにも機能します；`decompress` はブロックのスパンのみを復元するためにオプションの `startId`/`endId` メッセージ参照を受け入れます（一時的な注入、retrieve と同じチャネル）；`search_context` ヒットはブロックメタデータとともにカバーされた参照スパン（`[m00044–m00097 · N msgs]`）を持ち；`acp_status` はブロック→参照リンク（`BLOCK SPANS`）と STORE 行の別個の `range-restored` カウントを列挙します。設計決定 (#1282)：**キャップなし、エビクションなし、永遠に** — エンベロープは保持されるユニークなオリジナルとともに成長し、セッションのライフサイクルを共有します；フットプリントは `acp_status` で確認できます。セッションごとの統計（保存バイト、現在のワイヤーバイト節約、retrieve レート）は `acp_status` に表示されます；各 retrieve は `[ccr] retrieve …` 行を記録します。

#### `search`

- **型:** `object` (`{ planAware? }`)
- **デフォルト:** *(オフ — 未設定は `planAware: false` に解決；出力はプレーンなレキシカル検索とバイト単位で同一)*
- **ステータス:** ACTIVE (CCR v3 プラン認識検索、#1336 — 測定されるまでデフォルトオフ；プロキシモード + プラグインモード)
- **説明:** `search_context` 用のオプトイン**プラン認識検索** (issue #1336)。有効化されると、クエリが `limit` より多くのブロックに一致する場合、候補はコンテキスト内メッセージビューから抽出された現在のプラン状態に対して再ランキングされます：各プランニングツールの最後のツール呼び出し（組み込みパターン `TodoWrite`, `todowrite`, `todo_list`, `update_plan`, `TaskCreate`, `TaskUpdate`、およびすべての `compress.protectedLatestTools` パターン — カーネルのスナップショット保護と同じ最新優先セマンティクス）と、最近のユーザーターン。候補トピック/サマリーは、その状態との加重語重複によってスコアリングされます；スコアがゼロ以上のブロックが最初にソートされ、同点は元のレキシカル順序を保持します。そのときのみ2つのことが起こります：返されるサブセットが純粋なレキシカルカットと異なる可能性があり、`[plan-aware]` スティアリングセクションが追加されます。(a) `top fetch targets:` — 最高スコアの返されたブロックのカバーされた参照スパン、(b) このセッションで2回以上取得されたカバーされた参照へのヒント、繰り返し `acp_retrieve` の代わりにワンショット `decompress({blockId, startId, endId})` 範囲復元を指します。フラグがオフの場合、コンテキストにプラン状態がない場合、またはマッチプールが `limit` に収まる場合、出力は機能以前とバイト単位で同一です。ランキングは候補順序にのみ触れます — ストア/フォールド/注入メカニクスは変更されず、新しい永続化はなく、外部セッション検索（`conversation_id`）は読み取り専用レキシカルのままです。すべての再ランキングは、ブロックごとのスコアを含む `[acp-search-plan] …` 行を記録します。コンパニオン統計：ブロック全体の decompress は `acp_status` の `RETRIEVAL QUALITY` 行の下でカウントアップされます（合計、およびより安価な精密パスが利用可能だったものの数 — すなわちブロックが参照スパンを持ち CCR がアームされていた場合）；したがって、有効化前後で retrieve-vs-decompress のトレードオフを測定できます。サブフィールド（他の CompressSettings フィールドと同様に最も深いものが優先してマージ）：
  - `planAware: boolean` — メイナスイッチ；`true` 以外のものは機能を完全にオフに保ちます。

#### `rules`

- **型:** `boolean`
- **デフォルト:** `false`
- **ステータス:** ACTIVE
- **説明:** **永続モデルリマインダー** (issue [ranxianglei/billion-context-pi#433](https://github.com/ranxianglei/billion-context-pi/issues/433)、`acp-kernel` rules API を通じて)、**デフォルトでオフ** — 有効にするには `compress.rules: true` を設定します（#1399 の決定：有効化されると、モデルはセッションルールに対して完全な権限を持ち、削除/クリアを含むプロンプトなしで呼び出すことができます）。有効化されると、`acp_rule` ツールが ACP ツールとともに注入されます：短い `rule` 引数で呼び出すと、**ハード保護**された原則レベルのリマインダーが記録されます（呼び出し + 結果はすべてのフォールドを通じてコンテキストに残る）、引数を省略すると記録されたルールがリストされます。ルール ID（例: `"rule3"`）とともに `delete` を渡すと、その1つのルールを削除します（`Removed ruleN: <text>`）；`clear: true` を渡すとすべてのルールを削除します。これらは互いに排他であり、`rule` ともに排他です — 1回の呼び出しにつき1つの操作 — したがって、古いまたは誤って記録されたルールは、カウンタールールでヘッジするのではなく削除できます。*いつ*記録すべきか（ユーザーが強調した教訓、ユーザーが記憶を要求する行動、遭遇した重大な落とし穴）に関するガイダンスは完全にツール説明内にあります — システムプロンプトには何も追加されません。カーネル制限が適用されます（50 ルール × 各 300 文字）；重複テキストは既存の ID を指して拒否されます。注入は `absorb` と全く同じようにワイヤーのネイティブツールサーフェスに従います：プロキシモードは anthropic/openai/responses ネイティブツールワイヤーでツールを注入し、プラグインモードは**有効な間のみ**プラグインマニフェストで宣伝します（ホストはマニフェストのツールを逐語に登録します — 無効なツールの宣伝はそれらを壊します、#1192；実行はセッションごとにゲート）。記録されたルールはセッション状態で再起動後も永続化され、削除も同様に永続化されます。`acp-kernel` >= 0.0.70 が必要（削除/クリアには >= 0.0.84）。人間はモデルを経由せずに完全な操作セットを得られます：pi/omp はツールと同じセマンティクスのネイティブ `/acp-rule` コマンドを公開します — プレーン `/acp-rule` はすべての記録されたルールをリストし、`/acp-rule <text>` は1つを直接記録し、`/acp-rule remove <id>` は1つを削除し、プレーン `/acp-rule clear` はすべての記録されたルールを消去します（`clear <text>` は消去するのではなく記録します）(#1251; remove/clear は #1399 で追加)。

#### `reasoning`

- **型:** `object` (`{ drop?, threshold? }`)
- **デフォルト:** `drop: true`, `threshold: 2048` — オン
- **ステータス:** ACTIVE
- **説明:** **圧縮推論衛生** (issue #651、`billion-context-pi` #339/#348 / `opencode-acp` #377 のプロキシ側ツイン)。`reasoning`/`thinking` トレースをワイヤーに保持するモデルは、永久に圧縮不能なフロアを蓄積します：フォールドのアンカーは `compress` 呼び出しであり、その呼び出し*以前*にある推論メッセージは保護プレフィックスの一部としてすべてのフォールドを生き延びます — 再要約されることは決してなく、ストリップされるだけです。ストームセッションでは、このフロアは可視コンテキストの約50%に達しました。オンの場合、プロキシは**クローズド**な `compress` 呼び出しの直前にある推論ランを削除します — **ラウンド証拠**によるクローズド：呼び出しのツール結果（`contentType: "tool-result"`、一致する `toolCallId`）が後のインデックスに到着し、その後少なくとも1つのメッセージが存在すること。ユーザーメッセージは必要ないため、長いエージェントセッションもラウンドをクローズします [#348 ツイン]。安全ゲート：*進行中*のラウンド（結果欠落、または結果がまだ最後のメッセージ）には決して触れません；通常のツール呼び出し（`read`, `bash`, …）のランは推論を保持します；ランはその合計長によって判定されるため、2×1200 文字のランでも 2048 ゲートに引っかかります；非連続な推論（断片間のテキスト）はそのままにされます。サブフィールド（他の CompressSettings フィールドと同様に最も深いものが優先してマージ）：
  - `drop: boolean` — キルスイッチ；`false` は古いワイヤーを逐語で復元します。`tools` を持つリクエストで `reasoning` ラウンドトリップを必須とする思考モデルのプロバイダーごとに必要です — DeepSeek、GLM thinking、Qwen-QwQ は、以前の `reasoning_content` がエコーバックされない場合 HTTP 400 を返します。#684 以降、これはほぼ自動です：`deepseek` アップストリーム**およびボディの `model` ID が `/deepseek/i` に一致するリクエスト** (#1027 — 非 deepseek ゲートウェイから提供される DeepSeek モデル) は静的に検出され、**Anthropic ワイヤー**では履歴に**署名付き思考ブロック**を持つ任意のリクエストはリクエストごとに drop を無効にします (#1658 — 署名付き思考はその `tool_use` 兄弟とラウンドトリップする必要があり、そうでない場合アップストリームはペアを拒否するため、drop するとペアが孤立します；拡張思考のないセッションには影響しません)、そして `reasoning_content` を言及するボディで 400 を返す**任意の**アップストリームは、セッションに推論を保持することを教えます（自己修復、セッションスコープ；オペレーションログは `[acp-loop] learned strictReasoningEcho` を持ちます）。設定は他の厳格な推論アップストリームのための手動エスケープハッチのままです：
    ```jsonc
    "providers": { "https://api.deepseek.com": { "compress": { "reasoning": { "drop": false } } } }
    ```
  - `threshold: number` — 文字数ゲート；これより**厳密に大きい**ランは drop されます（`0` = 空でない任意のランを drop）。無効な値はスローするのではなくデフォルトにフォールバックします。

#### `reasoningGuard`

- **型:** `object` (`{ enabled?, maxContinue?, maxTierN?, markerText?, base?, offset?, debugLog? }`)
- **デフォルト:** *(無効 — あるレベルで `enabled: true` を設定しない限りオフ)*
- **ステータス:** ACTIVE
- **説明:** gpt-5.x/gpt-6.x の**「格子」推論切り詰め**に対するオプトインガード (issue #739; アップストリーム [openai/codex#30364](https://github.com/openai/codex/issues/30364))。これらのモデルは間歇的に正確に `base*n + offset` 推論トークン（デフォルト `518n−2` → 516, 1034, 1552, …）で思考の途中で停止し、半端な思考から回答します。スコープ内のターミナルラウンドが格子にヒットし**かつ** `encrypted_content` ブロブを持つ場合、bili はレスポンスをバッファリングし、独自の推論をリプレイして継続ナッジ（最大 `maxContinue` 継続ラウンド）を再送信し、すべてを1つのレスポンスに折りたたみ、その使用量は真の合計になります。推論ストリームはフォールド中にクライアントにライブで配信されます（完全なバッファリングなし）；最終クリーンラウンドの非推論出力のみがパススルーされます。Responses/SSE ストリーミングリクエストにのみ適用されます（bili は SSE のみ）；compress 注入ターンは免除されます（ループがそれらを所有）。サブフィールド（他の CompressSettings フィールドと同様に最も深いものが優先してマージ）：
  - `enabled: boolean` — メイナスイッチ；`true` 以外のものはガードを完全にオフに保ちます。スコープは、このブロックが3レベルツリー（グローバル / プロバイダー / モデル）の**どこ**に存在するかによって設定されます — 別個のモデルリストはありません。厳密なシグネチャ（正確な格子ヒット + `encrypted_content` + ツール呼び出しなし）は、実際に回復をトリガーするラウンドを制限します。
  - `maxContinue: number` — 初期ラウンド後の最大継続ラウンド数（デフォルト `3`）。
  - `maxTierN: number` — 継続が許可される最高格子ティア `n`（デフォルト `6`）；`0` = 無制限。稀な深層ティア切り詰めのために引き上げます（例: gpt-6-astra で観察された `n=11` ヒット）。
  - `markerText: string` — 各継続ラウンドでコメントメッセージとして追加されるナッジテキスト（デフォルト `"Continue thinking..."`）。
  - `base: number` / `offset: number` — 格子シグネチャ `tokens == base*n + offset`（デフォルト `518` / `-2`）。別のモデルファミリーが異なる格子で切り詰める場合は上書きします。
  - `debugLog: boolean` — 詳細なラウンドごとのログ（デフォルト `false`）。
   ```jsonc
   // enable globally
   { "compress": { "reasoningGuard": { "enabled": true } } }
    // tune per provider (placement scopes it to that provider's traffic)
    { "providers": { "https://your-relay.example": { "compress": { "reasoningGuard": { "enabled": true, "maxContinue": 2 } } } } }
   ```

#### `priceProfile`

- **型:** `object` (`{ w?, r?, q? }`, すべて非負数)
- **デフォルト:** *(未設定 — レポートはリクエストモデルの models.dev 価格行から絶対 $/Mtok でフォールドを価格付け；レジストリが解決できないモデルのみがカーネルの組み込み相対比率 `{ w: 1, r: 0.1, q: 4 }` にフォールバック)*
- **ステータス:** ACTIVE
- **説明:** セッションキャッシュレポート（`acp_cache` ツール / `/acp-cache` コマンド / `GET /__bili/cache-report`、#800/#1279）内の**キャッシュ経済学的判定**のための価格プロファイル。フォールドごとの P&L フィールド（`oneTimeCostUnits`, `perTurnSavingUnits`, `breakevenTurns`, `paidBack`）は、入力トークン単位に対する3つの乗数から計算されます：`w` (キャッシュ書き込みコスト)、`r` (キャッシュ読み取りコスト)、`q` (出力コスト)。2つの単位規約が共存し、両方ともレポートヘッダー（`FOLD ECONOMICS (N folds @ w=.. r=.. q=..)`）に逐語で印刷されます：
  - **ユーザー設定**は**入力価格 (p_in = 1) に正規化された比率**を使用します：`w` = cacheWrite ÷ input、`r` = cacheRead ÷ input、`q` = output ÷ input。サブフィールドは他の CompressSettings フィールドと同様に3レベル間で最も深いものが優先してマージされます（プロバイダーレベルで `q` を設定し、モデルレベルで1フィールドを微調整）；部分プロファイル内で未設定のフィールドはカーネル比率 `w: 1`, `r: 0.1`, `q: 4` にフォールバックします。
  - **レジストリデフォルト**（どのレベルもキーを設定しない）：リクエストモデルの models.dev 価格行から導出 — **絶対 $/Mtok**、`w = cost.input`、`r = cost.cache_read ?? 0.1 × input`、`q = cost.output ?? 1.5 × input`（それらのフィールドのない行のための規約フォールバック）。プロバイダー直接トラフィックはそのホスト自身のリスティングを取得します；不明なリレーはホスト間で最初の一致するリスティングを取得します（リスティングが競合する場合、一度の警告）。ライブレジストリは到達可能なら優先し、バンドルスナップショットはオフラインフロアです (#282)。
  ユーザー設定は全体として優先します — どのレベルで設定されたプロファイルも、レジストリ行とフィールドごとに混合されることはありません。最後のリクエストの有効な値はセッションにスタンプされるため、すべてのレポートフェイスは、そのセッションの最近のターンを支配したプロファイルでフォールドを価格付けします。**レポート専用**：プロファイルは圧縮トリガー、頻度、または任意のワイヤー動作に影響しません。ユーザー設定の例（リレーのカスタムマークアップなど、レジストリ行を上書き）：
  ```jsonc
  // DeepSeek-V3 ≈ low output multiple
  { "providers": { "https://api.deepseek.com": { "compress": { "priceProfile": { "w": 1, "r": 0.1, "q": 1.5 } } } } }
  // OpenAI GPT-4o/o-series: 50% cached-read discount, flat writes, 4× output
  { "providers": { "https://api.openai.com": { "compress": { "priceProfile": { "w": 1, "r": 0.5, "q": 4 } } } } }
  // Self-hosted / free tier: everything costs zero tokens of your budget
  { "compress": { "priceProfile": { "w": 0, "r": 0, "q": 0 } } }
  ```
  同じモデルの通常入力価格に対するリスト価格を使用してください；カスタムマークアップを持つリレーは、その有効なレートを使用すべきです。

#### `outputSteering`

- **型:** `object` (`{ enabled?, verbosityLevel?, effortRouting? }`)
- **デフォルト:** *(無効 — あるレベルで `enabled: true` を設定しない限りオフ)*
- **ステータス:** ACTIVE
- **説明:** オプトインの**出力側圧縮** (issue #1093)：*出力*トークンを削減する2つのリクエスト時レバー、それらは入力よりも高く、ストリーミングされた瞬間に請求されます。決定ロジック（ターン分類、L0–L4 ディレクティブ文言、エフォートクランプ）は acp-kernel にあり、エージェント側と共有されます；bili は他のすべてのボディ変更の後、それをワイヤーに落地させるだけです：
  - **冗長性スティアリング** — システムプロンプトの**末尾**に追加される決定的な簡潔性ディレクティブ（決して前置しない — それならクライアントのプロンプトバイトをシフトし、プレフィックスキャッシュを壊す）。センチネルラップされ、冪等です：リトライはそれを蓄積せず、レベル変更はインプレースで置き換えます。なお、文言はリリース間でバイト安定です（カーネル文言編集は、そのレベルのすべてのセッションにとってプレフィックスキャッシュバスターです）。
  - **エフォートルーティング** — 最後のユーザーターンを構造的に分類（ブロック構成のみ、コンテンツパターンマッチングなし）；*機械的継続*（クリーンなツール結果、エラーなし、新しいユーザーシグナルなし）の場合、既に存在するエフォートフィールドは最小値に向かってクランプされます。クランプのみ：クライアントが送信しなかったフィールドを注入することはない（エフォートサポートのないモデルはそれで 400 になる）、`thinking.type` を切り替えることはなく、`minimal` を上げることはありません。ワイヤー：OpenAI `reasoning_effort`、Responses `reasoning.effort`、Anthropic `thinking.budget_tokens` (フロア 1024)、Gemini `generationConfig.thinkingConfig.thinkingBudget` (フロア 128; `-1` ダイナミックは触れない)。
  - サブフィールド（他の CompressSettings フィールドと同様に最も深いものが優先してマージ）：`enabled: boolean` メイナスイッチ；`verbosityLevel: number` 0–4 (0 = ディレクティブなし、デフォルト 2)；`effortRouting: boolean` (`enabled` のときデフォルトオン)。範囲外の値はブロックを拒否するのではなく、**警告とともに**デフォルトにフォールバックします。4つのすべてのワイヤー（openai chat / responses / anthropic / google）に適用されます；システムキャリアのないリクエストは触れられません（スキップ-if-absent）。
  ```jsonc
  // enable globally
  { "compress": { "outputSteering": { "enabled": true } } }
  // only lower effort, no wording directive
  { "compress": { "outputSteering": { "enabled": true, "verbosityLevel": 0 } } }
  // per provider (placement scopes it to that provider's traffic)
  { "providers": { "https://your-relay.example": { "compress": { "outputSteering": { "enabled": true, "verbosityLevel": 3 } } } } }
  ```

#### `stripImages` — REMOVED

- **型:** ~~`boolean`~~ / **`stripImagesKeepRecent`** ~~`number`~~ — 削除済み (2026-10、#2607/#2640 のフォローアップ)
- **説明:** オプトインのワイヤー側画像ストリップはもはや存在しません。デフォルトのメディア折りたたみ (#2640: アーカイブ可能なメディアは他のメッセージと同様に折りたたまれ、フォールド前に `<state>/retrieve/img/<session>/` 下にピクセルがアーカイブされ、`decompress({ imageRef })` がそれらを復元する) がそれを冗長にし、ストリップ自体は4つのワイヤーのうち3つでターンごとのプロンプトキャッシュブレイカーでした（そのスライディングカットオフ `len - keepRecent` は毎ターンバイト境界を移動する；anthropic のみフォールドアンカー修正を持っていた）。まだ `compress.stripImages` / `compress.stripImagesKeepRecent` を持つ設定は不活性です：キーは無視され、一度の `[acp-config] … INERT` 警告がこの注記を指します。bili が保存できないバイトを持つメディア（リモート URL、ファイル参照）はワイヤーにピン留めされたままです — #2609 を参照。

#### `visibilityMarkers`

- **型:** `boolean`
- **デフォルト:** `true`
- **ステータス:** ACTIVE
- **説明:** プロキシがプロキシツール呼び出し（`compress` / `decompress` / `search_context` / `acp_status`）を実行した後に発行される 📦/❌ ACP 可視性マーカーを制御します。オンの場合、各実行はレスポンスストリームにマーカー行を追加し、および/またはそのラウンドの再構築履歴にマーカーメッセージを再注入し、モデルが後のターンで何が起きたかを見られるようにします。両方の成果物を抑制するには `false` に設定します — モデルがマーカーを模倣またはナレーションするデプロイメントのために（独自の確認行やコメントを出力；issue #862 を参照）。ツール実行自体には影響しません：呼び出しは依然として実行され、ペアリングされたツール呼び出し/ツール結果メッセージは通常通り記録されます；マーカー行/メッセージのみが省略されます。#913 以降、`false` はナッジと注入された compress プロンプトに追加されるマーカー完全性注記から #862 沈黙条項も削除します — 不可視デプロイメントにはモデルが模倣またはナレーションするマーカーがないため、そこでは条項は純粋なノイズです。#717 偽造防止セグメントはすべての設定で無条件のままです。他のすべてのフィールドと同様の3レベルマージ。#717 偽造防止によるモデル発行の偽マーカーのストリップはこのフラグとは独立しており、アクティブのままです。

#### `messageTimestamps`

- **型:** `boolean`
- **デフォルト:** `true`
- **ステータス:** ACTIVE
- **説明:** メッセージタイムスタンプ (#4313, PR #5236; リーク監査フォローアップ以降デフォルトオン)：bili は初見時に各メッセージに1つの不変なローカルタイムスタンプを発行し、それをレンダリングします — ワイヤー上のすべての `<acp>` 圧縮タグの `time="yyyy-MM-dd HH:mm:ss"` 属性、各 compress レシートフィンガープリント行に追加される `[start – end]` カバレッジスパン、レンダリングされたブロックサマリーの Occurred 行。可視の場合、コストはメッセージあたり約8トークンです。スタンプは決定的なレンダリング入力です（保存された値からレンダリングされ、決してウォールクロックではない）ため、再レンダリングされた履歴はターンごとにバイト安定のままです；ライブセッション監査は、フラグオンとオフで同じプロンプトキャッシュヒットレートを示しました。#4313 以前のバイトを正確に再現するには `false` に設定します（time 属性なし、オリジナルプロンプトテキスト、フィンガープリントスパンなし）。スタンプはどちらの場合も保存に記録されるため、後でオプトインしてもデータ損失なしで完全な履歴が表示されます。フラグが true に解決される最初の再起動は、アクティブなセッションごとに1回のフローズンプレフィックスキャッシュ書き換えを支払います。解決は環境変数（`BILI_MESSAGE_TIMESTAMPS`; `0` はオフを強制、他の値はオンを強制、BILI_RESIGN と同じ規約）が設定ファイルを上書きし、プロキシインスタンスごとに一度解決されます — フラグの変更には再起動が必要です。
### 注入トグル（グローバルのみ）

これら2つのトグルは **グローバル** レベルでのみ有効です。プロバイダーごとまたはモデルごとの `compress` ブロック内で設定しても効果はありません。

#### `injectTool`

- **型:** `boolean`
- **デフォルト:** `true`
- **ステータス:** ACTIVE
- **説明:** `compress` / `decompress` / `search_context` ツールおよび圧縮システムプロンプトを各リクエストに注入します。ツール注入を完全に無効にするには `false`（または `ACP_COMPRESS_TOOL=0`）を設定してください。

#### `injectNudge`

- **型:** `boolean`
- **デフォルト:** `true`
- **ステータス:** ACTIVE
- **説明:** 使用量しきい値を超えた際に、自動圧縮ナッジメッセージを注入します。ナッジ注入を無効にするには `false`（または `ACP_COMPRESS_NUDGE=0`）を設定してください。`injectTool` と `injectNudge` の両方を無効にすると、機能面では `passthrough` に類似しますが、プロキシはトークン使用量をトラッキングし続けます。

### なぜ最初のコンパクト化は200kまで待つか

コンパクト化は絶対的なウィンドウ位置ではトリガーされ**ません** — トリガーされるのは**成長間隔**です：デフォルトでは、セッションが**起動コンテンツから50kトークン成長した**後に最初のソフトコンパクト化が発火します
（[`nudgeGrowthTokens`](#nudgegrowthtokens)、ウィンドウサイズに依存しない平坦なステップ）。したがって、最初のコンパクト化の絶対的な位置は ≈ **起動 +
50k** となります：

- 起動 30k–50k（dsh のデフォルト）→ 最初のコンパクト化は約80k–100kで発生；
- 起動が約100k、または成長ステップが約100kに設定されている場合 → 最初のコンパクト化は
  **約200k** まで待たされる可能性があります。

強制しきい値（[`maxContextLimit`](#maxcontextlimit)、デフォルト 75%）は
バックストップにすぎず、*実効* ウィンドウに適用されます — 出力リザーブ
`min(max_tokens, outputHeadroomMaxPct × window)`（キャップデフォルト `0.25`、
[`outputHeadroomMaxPct`](#outputheadroommaxpct) を参照）が最初に差し引かれます。
リザーブは通常小さく、リクエストが非常に大きな `max_tokens` を伴う場合にのみ
25% のキャップに達します：262,144トークンのウィンドウで
`max_tokens = 131072` → 実効ウィンドウ 196,608 → 強制ライン ≈147k；同じ
ウィンドウで8kのリザーブ → 強制ライン ≈190k。

その後、頻度は成長ベースのまま維持されます：圧縮可能な成長ごとに +50k ごとに
1回の増分コンパクト化。ローカルモデルでは、各コンパクト化は完全な再プリフィル
です — 重い起動と大きなウィンドウは、1つの長いタスクにそれらを複数回含める
ことになり、これがウォールクロック時間が2〜3倍長くなる原因となります。

最初のコンパクト化をより早く発火させ（トークンを節約し）るには、この順序で：

1. **システムプロンプトをトリムし、不要なツールを無効にし、スキルを剪定する** — 起動
   サイズは最初のコンパクト化の絶対的な位置を直接決定します；
2. **`nudgeGrowthTokens` を約50kに下げる**（特に100kに引き上げられていた場合）；
3. **リーンモードを有効にする**（`promptPack: "lean"`）；
4. **`maxContextLimit` を下げる**（例：`"40%"`） — 圧迫バンドはその使用量レベルで
   圧縮を要求し始めるようになり、成長頻度を待つことはなくなります；デフォルトの
   75% バックストップが及ばない状態で、アップストリームまたはクライアントが大きな
   リクエストで劣化する場合（タイムアウト、最初のバイトが遅い）に使用してください
   （#4007）。45% 未満の場合、acp-kernel はターンごとの検証警告をログ出力します —
   ノイズのみで、しきい値には影響しません。

チューニング前に、`/acp` または Web UI で実際の起動/コンテキスト使用量を測定してください。

### 弾性ヘッドルーム付きソフトターゲット（#1122）

自律エージェントは同時に2つのことを望むことが多いです：*アクティブ* コンテキストを小さく保つこと（コスト/レイテンシ）、そして本当に必要とされる場合（例：大きなファイルの読み取り）には、単一のタスクがそのターゲットを大きく超えてバーストすることを許可すること。`modelContextLimit` をモデルのネイティブウィンドウ未満に設定しても、それを表現することはできません — 1つのフィールドが同時に2つの役割（使用率比の分母 **かつ** ハードプリフライト壁）を担っているため、それを超えるペイロードはタスク途中で折りたたまれたり、素早く失敗したりします（#1122）。

代わりに、既存のソフトバンドで表現してください：制限をネイティブウィンドウに保ち、`maxContextLimit` でターゲットを固定します：

```jsonc
// model with a 200k native window; keep ~70k active, allow bursts up to the real edge
{
  "compress": {
    "modelContextLimit": 200000,   // = native window → hard wall only at the true edge
    "maxContextLimit": "35%"       // forced-nudge zone starts ≈ 70k (= target ÷ native window)
  }
}
```

圧縮が実際にどのように決定するか（acp-kernel、検証済み）：

1. **成長レイヤー（日常の駆動要因、絶対トークン）：** 前向きなナッジは、最後のアンカー（セッション開始 / 最後のナッジ / 圧縮後のリセット）以降の累積成長が成長ゲートに達し**かつ**十分な圧縮可能な質量が蓄積されたときに1回発火します。両方の数値は設計上、絶対値でありウィンドウに依存しません：成長ステップはすべてのウィンドウサイズで平坦な50kです（カーネル `nudge.growthFloor == nudge.growthCap == 50000`、ゴールデンピン済み；ウィンドウパーセンテージのスケーリングは意図的に削除されました — #379/#380；`nudgeGrowthTokens` でオーバーライド可能）；成長ゲートは `max(20k, 0.45 × step)` ≈ 22.5k であり、T1 パスはさらに1ステップ（50k）以上の圧縮可能な質量を必要とします。このレイヤーは、パーセンテージバンドよりはるかに下でも、長いセッションを圧縮し続けます。
2. **圧迫レイヤー（ウィンドウのパーセンテージ）：** `usage ≥ maxContextLimit`（デフォルト 75%）→ コンテキストが再び下回るまで、各ターンでナッジが注入されます；`usage ≥ emergencyThresholdPercent`（デフォルト 95%）→ 強制ナッジ + 緊急切り詰め。
3. **資格レイヤー（カーネルデフォルト 45%、公開されていません）：** ターン1のコールドスタートチケットと、T2/T3 ティアエスカレーションのブロック数フロアのみをゲートします — 日常のパスの一部ではありません。

注：`maxContextLimit` をカーネルの45%デフォルト未満に設定しても正しく動作します（レイヤーは独立しているため）、しかし acp-kernel はターンごとの検証警告（`minContextLimitPct must not exceed maxContextLimitPct`）をログ出力します — ログノイズのみで、しきい値には影響しません。

古い低制限設定（例：`modelContextLimit: 70000`）との比較：ハード壁は70kからネイティブウィンドウに移動します（大きな読み取りがタスク途中で潰されたり、素早く失敗したりしなくなります）；強制ゾーンは75%×70k ≈ 52.5kから、選択した%×ネイティブに移動します；強制ゾーン未満では、コンテキストは毎ターン固定されるのではなく、成長レイヤーに従ってドリフトします — そのドリフトは弾性の代価です。厳密な日常の上限 *かつ* バーストヘッドルームを同時に必要とする場合、静的なパーセンテージバンドでは両方を表現できません；許容できる上限の%を選択するか、構造認識圧縮を追跡してください（#344）。

同じフィールドはプロバイダーごと / モデルごと（3レベルマージ）で機能し、Web UI によるホットリロードも可能です。
### 3レベルマージの例

この例では、グローバルデフォルト、プロバイダーごとのオーバーライド、モデルごとのオーバーライドがフィールド単位でスタックされる様子が示されています：

```jsonc
{
  // Level 1 — global: applies to every request
  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000,
    "tiers": true,
    "injectTool": true,
    "injectNudge": true
  },

  "providers": {
    "https://api.anthropic.com": {
      // Level 2 — per-provider: overrides global fields for this provider
      "compress": {
        "maxContextLimit": "70%",          // compress a bit earlier here
        "preserveRecentMessages": 8        // keep more recent turns
      },
      "models": {
        "claude-sonnet-4-5": {
          "context": 200000,
          // Level 3 — per-model: the deepest, highest priority
          "compress": {
            "modelContextLimit": 180000,   // treat window as 180k (leaves headroom)
            "emergencyThresholdPercent": "90%"
          }
        }
      }
    }
  }
}
```

`https://api.anthropic.com/v1/messages` へのリクエストでモデルが `claude-sonnet-4-5` の場合、解決された設定は以下のようになります：

| フィールド | 解決元 | 値 |
|-------|---------------|-------|
| `maxContextLimit` | プロバイダー（レベル 2） | `"70%"` |
| `emergencyThresholdPercent` | モデル（レベル 3） | `"90%"` |
| `nudgeGrowthTokens` | グローバル（レベル 1） | `50000` |
| `preserveRecentMessages` | プロバイダー（レベル 2） | `8` |
| `modelContextLimit` | モデル（レベル 3） | `180000` |
| `tiers` | グローバル（レベル 1） | `true` |

---
## 環境変数

環境変数は設定ファイルよりも優先されます。ファイルの編集なしで、環境固有の上書き（CI、コンテナなど）を行う場合に便利です。

**優先度モデル (#2030)。** すべての動作制御項目は **環境変数 > 設定ファイル > ビルトインデフォルト** の順で解決されます。#2030 以降、すべての純粋な動作制御項目には設定ファイルのキーも用意されたため、デプロイメント全体を `billion-context.json` に記述することが可能になりました。環境変数は依然として上書きレイヤーとして機能します。*設定済み* の環境変数は、その値が不正であっても、その制御項目を所有します — #2030 以前と同様に正確にパースされ（デフォルトにフォールバックする）、ファイルレイヤーに漏洩したり、ファイルレイヤーによってシャドウされたりすることはありません。環境変数のみで管理される変数は、ファイルに格納できないもの（シークレット（`BILI_LAUNCH_TOKEN`、`BILI_ENCRYPTION_KEY`）、別の bili コンポーネントがスポン時に書き込むプロセス単位のチャネル（`BILI_MCP_PROXY`、`BILI_PARENT_PID`、`BILI_STRICT_PORT`、`BILI_OPENCODE_ACP_SPEC`、`BILI_LAUNCHER_MODEL_*`）、サードパーティ製ホストプロセス内で読み取られるホスト側の姿勢（`BILLION_CONTEXT_PLUGIN*`、`BILI_NATIVE_*`、`BILI_RECLAIM_FETCH_PATCH`）、パスの再配置（`BILI_CONFIG_FILE`、`BILI_SESSIONS_DIR`、`ACP_DUMP_DIR`、`XDG_*`）、およびサードパーティの慣習（`CLAUDE_CODE_SESSION_ID`、`CODEX_HOME`、`https_proxy`））に予約されています。新しい制御項目は、AGENTS.md の "Environment Variable Discipline" に記載されているルールに従います。

### 環境制御項目の設定ファイルキー (#2030)

ファイルキーは、対応する環境変数が未設定の場合にのみ解決されます。括弧内のデフォルト値は、ビルトインのものです。
<!-- bili:gen env-map -->
| 環境変数 | 設定ファイルキー | デフォルト |
|---------|------------|--------|
| `` | `pi.commands` | ["acp", "acp-cache"] |
| `ACP_AUTO_RESTART_ON_UPDATE` | `autoRestartOnUpdate` | false |
| `ACP_AUTO_UPDATE` | `autoUpdate` | true |
| `ACP_COMPRESS_NUDGE` | `compress.injectNudge` | true |
| `ACP_COMPRESS_PROTOCOL` | `diagnostics.compressProtocol` | "tools" |
| `ACP_COMPRESS_TOOL` | `compress.injectTool` | true |
| `ACP_COUNT_TOKENS_PASSTHROUGH` | `diagnostics.countTokensPassthrough` | false |
| `ACP_DEBUG` | `debug` | false |
| `ACP_DUMP_BODY` | `diagnostics.dumpBody` | false |
| `ACP_DUMP_REQ` | `diagnostics.dumpReq` | true |
| `ACP_DUMP_SSE` | `dumpSse` | unset (directory) |
| `ACP_HOST` | `host` | 127.0.0.1 |
| `ACP_KEEP_RESPONSE_ID` | `compat.keepResponseId` | false |
| `ACP_LOG` | `log` | true |
| `ACP_LOG_FILE` | `logFile` | XDG state path (off disables the file, keeps stderr) |
| `ACP_MODEL_CONTEXT_LIMIT` | `modelContextLimit` | 200000 |
| `ACP_NO_COMPRESS_PROMPT` | `diagnostics.noCompressPrompt` | false |
| `ACP_NO_INJECT_TOOL` | `diagnostics.noInjectTool` | false |
| `ACP_PASSTHROUGH` | `passthrough` | false |
| `ACP_PORT` | `port` | 8787 |
| `ACP_PROMPT_CACHE_ROUTING` | `promptCache.routing` | disabled |
| `ACP_PROVIDERS` | `providersPath` | unset |
| `ACP_RAW_DUMP_DIR` | `diagnostics.rawDumpDir` | <state dir>/raw |
| `ACP_RENDER_NONE` | `diagnostics.renderNone` | false |
| `ACP_SESSION_HEADER` | `sessionHeader` | x-acp-session |
| `ACP_UPDATE_TAG` | `updateTag` | latest |
| `ACP_UPSTREAM` | `upstream` | https://api.anthropic.com |
| `BILI_ADVISORY_CHECK` | `advisoryCheck` | true |
| `BILI_ADVISORY_URL` | `advisoryUrl` | unset (built-in feed) |
| `BILI_AFFINITY_SIMHASH` | `affinitySimhash` | true |
| `BILI_ALLOW_DSH_COMPACTION` | `dsh` | {} |
| `BILI_ALLOW_PRIVATE_HTTP_PROVIDERS` | `network.allowPrivateHttpProviders` | false |
| `BILI_ANNOUNCEMENTS_URL` | `remoteAnnouncementsUrl` | unset (official feed: GitHub master announcements/remote.json) |
| `BILI_AUTO_MODE_FORGE` | `autoModeForge.enabled` | true |
| `BILI_CACHE_KEEPALIVE` | `cacheKeepalive.enabled` | false |
| `BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS` | `cacheKeepalive.armWithoutBreakpoints` | false |
| `BILI_CACHE_KEEPALIVE_ASSUME_TTL` | `cacheKeepalive.assumeTtl` | null (detect from body breakpoints) |
| `BILI_CACHE_KEEPALIVE_INTERVAL_MS` | `cacheKeepalive.intervalMs` | null (derive from TTL tier) |
| `BILI_CACHE_KEEPALIVE_MAX_DURATION_MS` | `cacheKeepalive.maxDurationMs` | 86400000 |
| `BILI_CACHE_KEEPALIVE_MAX_PINGS` | `cacheKeepalive.maxConcurrentPings` | 4 |
| `BILI_CACHE_KEEPALIVE_TTL_FACTOR` | `cacheKeepalive.ttlFactor` | 0.9 |
| `BILI_CA_FILE` | `network.caFile` | unset |
| `BILI_CCR_RETRIEVAL_TTL_MS` | `ccrRetrievalTtlMs` | 600000 (0 disables retrieval) |
| `BILI_CHAIN_CONTENT` | `chainContentDetection` | false |
| `BILI_CHAIN_STAMP` | `chainEgressStamp` | false |
| `BILI_CLAUDE_NATIVE_PORT` | `claude.nativePort` | unset (lane sticky zone port) |
| `BILI_CLIENT_ERROR_BACKSTOP_MS` | `network.clientErrorBackstopMs` | 30000 |
| `BILI_CODEARTS_REF` | `resign` | {} (armed; built-in scheme sdk-hmac-sha256) |
| `BILI_CODEX_COMPACT` | `codexCompact` | "intercept" |
| `BILI_DECODED_BODY_BYTES` | `network.decodedBodyBytes` | 10737418240 |
| `BILI_DECOMPRESS_TMP_CAP` | `decompressTmpCap` | 50 |
| `BILI_DSH_AUTHORED_COMPACTION` | `dsh.authoredCompaction` | true (on, #3901 flip) |
| `BILI_DSH_CONTEXT_TAB` | `dsh.contextTab` | true |
| `BILI_DUMP_4XX` | `diagnostics.dump4xx` | false |
| `BILI_DUMP_4XX_MAX_BYTES` | `diagnostics.dump4xxMaxBytes` | 2097152 (floor 1024) |
| `BILI_DUMP_MAX_AGE_DAYS` | `diagnostics.maxAgeDays` | unset (off) |
| `BILI_DUMP_MAX_TOTAL_BYTES` | `diagnostics.maxTotalBytes` | unset (off) |
| `BILI_EXPOSURE_LOG_INTERVAL_MS` | `network.exposureLogIntervalMs` | 3600000 (0 disables the log) |
| `BILI_FAKE_BUF_CAP` | `fakeCompletion.bufCapBytes` | 16777216 |
| `BILI_FAKE_COMPLETION_RETRIES` | `fakeCompletion.retries` | 0 (opt-in) |
| `BILI_FOLD_RECONCILE` | `compress.reconcile` | "repair" |
| `BILI_FORK_ADOPTION` | `forkAdoption` | false |
| `BILI_GUARDRAIL_BASH_TIMEOUT` | `guardrails.bashTimeout` | 60 |
| `BILI_GUARDRAIL_MAX_OUTPUT_BYTES` | `guardrails.maxOutputBytes` | 50000 |
| `BILI_GUARDRAIL_REPETITION` | `guardrails.repetition` | true |
| `BILI_GUARDRAIL_TEXT_RUN_THRESHOLD` | `guardrails.textRunThreshold` | 200 |
| `BILI_HTTP_OUTBOUND_BYTES` | `network.httpOutboundBytes` | 10485760 |
| `BILI_IMAGE_BILLING` | `imageBilling` | auto (resolves to pixels) |
| `BILI_IMAGE_RESCALE` | `imageRescale` | true |
| `BILI_IMAGE_TOKEN_CAP` | `imageTokenCap` | unset (uncapped) |
| `BILI_INGEST_BODY_BYTES` | `network.ingestBodyBytes` | 33554432 |
| `BILI_INVARIANT_JUDGE` | `diagnostics.invariantJudge` | true |
| `BILI_KEEP_ALIVE_TIMEOUT_MS` | `network.keepAliveTimeoutMs` | 5000 |
| `BILI_LOG_BUDGET_BYTES` | `diagnostics.logBudgetBytes` | 268435456 (256 MiB, floor 1 MiB) |
| `BILI_LOG_MASK_HOSTS` | `maskHosts` | true |
| `BILI_LOG_RETENTION_HOURS` | `diagnostics.logRetentionHours` | 48 (floor 1) |
| `BILI_MAX_MESSAGES` | `network.maxMessages` | 0 |
| `BILI_MAX_SESSIONS` | `sessions.max` | 256 |
| `BILI_MAX_SHRINK_PER_COMPRESS` | `network.maxShrinkPerCompress` | unset |
| `BILI_MCP_PROXY` | `native.attachUrl` | unset (discover per lane) |
| `BILI_MESSAGE_TIMESTAMPS` | `compress.messageTimestamps` | true |
| `BILI_MITM` | `mitm.enabled` | true |
| `BILI_MITM_DOMAINS` | `mitm.domains` | [] |
| `BILI_MITM_HANDSHAKE_TIMEOUT_MS` | `mitm.handshakeTimeoutMs` | 10000 |
| `BILI_MYSQL_DSN` | `storage.mysql.dsn` | unset |
| `BILI_NATIVE_ATTACH_EXTERNAL` | `native.attachExternal` | false |
| `BILI_NATIVE_ATTACH_POLICY` | `native.attachPolicy` | own-lane |
| `BILI_NON_HTTP_PROVIDERS` | `compactionOptIn` | false |
| `BILI_NO_CACHE_CONTROL` | `compat.noCacheControl` | false |
| `BILI_OPENCODE_INLINE` | `opencode.inline` | false |
| `BILI_OUTBOUND_BODY_BYTES` | `network.outboundBodyBytes` | 5368709120 |
| `BILI_PERSIST` | `persist.enabled` | true |
| `BILI_PERSIST_DEBOUNCE_MS` | `persist.debounceMs` | 500 |
| `BILI_PERSIST_EPERM_ALERT_REPEAT_MS` | `persist.epermAlertRepeatMs` | 0 (no repeats) |
| `BILI_PERSIST_EPERM_ALERT_THRESHOLD` | `persist.epermAlertThreshold` | 5 |
| `BILI_PERSIST_MAX_DELAY_MS` | `persist.maxDelayMs` | 5000 |
| `BILI_PERSIST_TAIL_TOKENS` | `persist.tailTokens` | 16384 (0 disables message persistence) |
| `BILI_PERSIST_ZSTD` | `persist.zstd` | false |
| `BILI_PERSONA_SPLIT` | `personaSplit` | true |
| `BILI_PI_INLINE` | `pi.inline` | true (unset env+file runs inline) |
| `BILI_POST_RESPONSE_LINGER_MS` | `network.postResponseLingerMs` | 5000 |
| `BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS` | `network.preflightDeadEndCooldownMs` | 300000 |
| `BILI_PREFLIGHT_HOLD_MS` | `network.preflightHoldMs` | 30000 |
| `BILI_PROXY_KEEPALIVE_MAX_MS` | `network.proxyKeepAliveMaxMs` | 55000 (0 = one-shot connections) |
| `BILI_PUBLIC_SNAPSHOT_CAP_BYTES` | `plugin.snapshotCapBytes` | 104857600 (0 disables snapshots) |
| `BILI_RECEIVE_BODY_BYTES` | `network.receiveBodyBytes` | 5368709120 |
| `BILI_RELEASE_NOTES_CHECK` | `releaseNotesCheck` | true |
| `BILI_RELEASE_NOTES_URL` | `releaseNotesUrl` | unset (built-in feed) |
| `BILI_REPLAY_RETRY_BASE_MS` | `network.replayRetryBaseMs` | 1500 (0 disables the delay) |
| `BILI_REPLAY_RETRY_MAX` | `network.replayRetryMax` | 3 (1 disables replays) |
| `BILI_REQUEST_WATCHDOG_MS` | `network.requestWatchdogMs` | 2× upstreamTimeoutMs |
| `BILI_RESIGN` | `resign` | {} (armed; built-in scheme sdk-hmac-sha256) |
| `BILI_RESIGN_BENEFIT` | `resign` | {} (armed; built-in scheme sdk-hmac-sha256) |
| `BILI_RESIGN_PASSTHROUGH` | `resign` | {} (armed; built-in scheme sdk-hmac-sha256) |
| `BILI_RESUME_INHERITANCE` | `resumeInheritance` | true |
| `BILI_ROLLOUT_<FEATURE>` | `rollout.features.enabled` | unset (bucket math decides) |
| `BILI_ROLLOUT_IDENTITY_CHANNEL_HARVEST` | `rollout.features.identityChannelHarvest` | 0 (off) |
| `BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK` | `rollout.features.pluginFullResendWatermark` | 5 (experimental grey) |
| `BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY` | `rollout.features.pluginLaneServerHistory` | 0 (off) |
| `BILI_SESSION_CONTENT_STORE_PIN` | `sessions.contentStorePin` | false |
| `BILI_SESSION_GC` | `sessions.gc.enabled` | false |
| `BILI_SESSION_GC_INTERVAL_MS` | `sessions.gc.intervalMs` | 3600000 |
| `BILI_SESSION_GC_MAX_AGE_DAYS` | `sessions.gc.maxAgeDays` | 7 |
| `BILI_SESSION_GC_MAX_TOKENS` | `sessions.gc.maxTokens` | 1000000 |
| `BILI_SESSION_RESIDENT_HARD_MAX_BYTES` | `sessions.hardMaxBytes` | (same as `sessions.residentMaxBytes`) |
| `BILI_SESSION_RESIDENT_MAX_BYTES` | `sessions.residentMaxBytes` | 4294967296 |
| `BILI_SESSION_WARM_MAX` | `sessions.warmMax` | 0 |
| `BILI_SESSION_WARM_MAX_BYTES` | `sessions.warmMaxBytes` | 67108864 |
| `BILI_SQLITE_AUTO_DOWNLOAD` | `storage.sqliteAutoDownload` | true |
| `BILI_STABLE_SYSTEM_ANCHOR` | `stableSystemAnchor` | false |
| `BILI_STORAGE_ARCHIVE_AFTER_DAYS` | `storage.archiveAfterDays` | 365 |
| `BILI_STORAGE_BACKEND` | `storage.backend` | unset (sqlite) |
| `BILI_STORAGE_JSON_WRITER` | `storage.jsonWriter` | on |
| `BILI_STORAGE_UNIFIED` | `storage.unified` | unset (full) |
| `BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES` | `storage.walJournalSizeLimitBytes` | 8388608 |
| `BILI_STREAM_ERROR_SHAPE` | `compat.streamErrorShape` | protocol |
| `BILI_STREAM_KEEPALIVE_MS` | `network.streamKeepAliveMs` | 15000 (0 disables) |
| `BILI_SUBAGENT_SPLIT` | `subagentSplit` | true |
| `BILI_THROTTLE_429` | `network.throttle429Enabled` | true |
| `BILI_THROTTLE_429_BASE_DELAY_MS` | `network.throttle429BaseDelayMs` | 2000 |
| `BILI_THROTTLE_429_MAX_CONSECUTIVE` | `network.throttle429MaxConsecutive` | 5 |
| `BILI_THROTTLE_429_MAX_DELAY_MS` | `network.throttle429MaxDelayMs` | 30000 |
| `BILI_THROTTLE_429_SCOPE` | `network.throttle429Scope` | credential |
| `BILI_UPDATE_CHECK_INTERVAL_MS` | `update.checkIntervalMs` | 180000 |
| `BILI_UPDATE_POLICY_URL` | `update.policyUrl` | official repo raw URL |
| `BILI_UPDATE_REGISTRY` | `update.registry` | "npmjs" (registry.npmjs.org) |
| `BILI_UPDATE_STAGGER_MAX_MS` | `update.staggerMaxDelayMs` | 172800000 (built-in 48 h) |
| `BILI_UPDATE_STAGGER_MIN_MS` | `update.staggerMinDelayMs` | 900000 (built-in 15 min) |
| `BILI_UPSTREAM_FIRST_BYTE_MS` | `network.upstreamFirstByteMs` | = upstreamTimeoutMs (resolved; 720000 when unset) |
| `BILI_UPSTREAM_PROXY` | `proxy` | unset (direct) |
| `BILI_UPSTREAM_PROXY_MODE` | `upstreamProxyMode` | auto (unset behaves as direct) |
| `BILI_UPSTREAM_TIMEOUT_MS` | `network.upstreamTimeoutMs` | 720000 |
| `BILI_WS_OUTBOUND_BYTES` | `network.wsOutboundBytes` | 10485760 |
| `PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES` | `pi.subagents` | {} (acp_delegate enabled with package defaults) |
| `PI_ACP_DELEGATE_FORCE_ENABLE` | `pi.subagents` | {} (acp_delegate enabled with package defaults) |
| `PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES` | `pi.subagents` | {} (acp_delegate enabled with package defaults) |
| `PI_ACP_DELEGATE_MAX_CONCURRENT` | `pi.subagents` | {} (acp_delegate enabled with package defaults) |
| `PI_ACP_DELEGATE_MAX_DEPTH` | `pi.subagents` | {} (acp_delegate enabled with package defaults) |
| `PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES` | `pi.subagents` | {} (acp_delegate enabled with package defaults) |
| `PORT` | `port` | 8787 |
| `— (file-only)` | `guardrails.repetition.abort` | 5 |
| `— (file-only)` | `guardrails.repetition.enabled` | true |
| `— (file-only)` | `guardrails.repetition.recovery` | false |
| `— (file-only)` | `guardrails.repetition.warn` | 3 |
<!-- /bili:gen -->

| 変数 | 効果 |
|----------|--------|
| `ACP_DEBUG` | `1` に設定すると詳細ログが有効になります（`"debug": true` と同じ）。 |
| `ACP_PASSTHROUGH` | `1` に設定すると、圧縮なしで転送します（`"passthrough": true` と同じ）。 |
| `ACP_COMPRESS_TOOL` | `0` に設定すると、ツール注入を無効にします（`"compress.injectTool": false` と同じ）。 |
| `ACP_COMPRESS_NUDGE` | `0` に設定すると、ナッジ注入を無効にします（`"compress.injectNudge": false` と同じ）。 |
| `ACP_MODEL_CONTEXT_LIMIT` | グローバルなデフォルトのコンテキスト上限（絶対トークン数）— 最終手段のウィンドウソース: ルート/モデルごとの宣言、レジストリエントリ、組み込みテーブルの値がモデルに対して解決されない場合のみ参照されます。ネイティブに解決されたウィンドウを制限することはありません (#5908)。特定のモデルのウィンドウを固定するには `compress.modelContextLimit` を使用してください。 |
| `BILLION_CONTEXT_NODE` | Node ホストプロセスでないホストプロセスがプロキシを起動する際に使用される Node 実行可能ファイルへの明示的なパス (#819/#1429)。Node 自身ではないホスト内部での解決順序: このオーバーライド → PATH 検索および GUI の PATH に含まれない既知のインストール場所 (`/opt/homebrew/bin`, `/usr/local/bin`, Volta など) → Electron ホスト自身のバイナリをプレーンな Node として実行 (`ELECTRON_RUN_AS_NODE=1`、最終手段 — deepseek-harness desktop などのデスクトップアプリはゼロ設定で動作します)。発見されたすべての候補は `--version` で検証され、メジャーバージョンが 20 以上である `vX.Y.Z` を報告する必要があります (#3383): 単に `node(.exe)` と*名前*が付けられた外部プログラム（引数を無視して終了コード 0 で終了する Microsoft HPC Pack のクラスタ CLI など）は、起動される代わりに警告とともにスキップされます — このようなプログラムが PATH 上で本物の Node より前にある場合は、この変数を明示的に設定してください。特定の Node（例: ホストにバンドルされたランタイムより新しいもの）を強制するために設定できます。常にフォールバックより優先されます。 |
| `BILI_CCR_RETRIEVAL_TTL_MS` | キューに入れられたが未配信の `acp_retrieve` 注入の有効期限 (ms) (#1343): 完全なテキストがこの間ずっとキューに残り、上流リクエストに乗る機会が一度もなかった場合、**明確に**破棄されます — 参照情報と理由付きの警告ログ、`stats.retrieveDropped` の増加、そして次のリクエストでモデルに `acp_retrieve` の再発行を促す補正ノート。デフォルトは `600000` (10分); `0` で有効期限を無効にします。プラグインレーンのキュー項目のみ対象です。範囲復元ライダー (#1207) は対象外です。 |
| `BILI_IMAGE_TOKEN_CAP` | プリフライトサイズゲート、出力クランプ、画像圧縮統計で使用される画像ごとのトークン推定値の上限 (#488/#496/#1843)。解決された課金モードの上に適用されます — 実際のエンコーダがピクセル事前確率よりも低い課金を行うルートに対する包括的な上限です。両方の設定レベル ([`imageTokenCap`](#imagetokencap)) より優先されます。リクエストごとにライブ読み込み (再起動不要)。未設定 = 設定へのフォールバック (`providers.<url>.imageTokenCap`、次にグローバル)、デフォルトは上限なし。 |
| `BILI_IMAGE_BILLING` | プリフライトサイズゲートと出力クランプで使用される画像課金モードのオーバーライド (#767/#1843): `pixels` または `bytes`。リクエストごとにライブ読み込み (再起動不要); グローバルの `imageBilling` およびすべてのプロバイダーごとの `providers.<url>.imageBilling` より優先されます。#1843 以降、デフォルトはすべてのホストに対して `pixels` に解決されるため、プロセス全体で保守的なバイト課金を強制するには `bytes` を使用してください (例: バイトカウントリレー) — ルートごとの設定はより狭い範囲のツールとして残ります。[`imageBilling`](#imagebilling) を参照してください。 |
| `BILI_IMAGE_RESCALE` | 送信画像のダウンスケールパス (#3400) を無効 (`"0"` または `"false"`) にするか、有効のまま (それ以外) にするか: 大きな送信画像は縮小されて送信され、オリジナルはセッションストレージ内でバイト単位で正確に保持されます。リクエストごとにライブ読み込み (再起動不要); 設定ファイルのキー [`imageRescale`](#imagerescale) より優先され、そのデフォルトはオンです。 |
| `BILI_IMAGE_RESCALE_MAX_DIM` | 送信ダウンスケールパスの最長辺トリガー閾値 (px) (#3400): 画像の最長辺がこの値を超えた場合、または base64 ボディが 100 KB を超えた場合に、リサイズ候補となります。fit-inside リサイズはアップスケールしません。デフォルトは `1600`; 数値でない場合や `128` 未満の値は無視されます (デフォルトが適用されます)。設計上、環境変数のみです — 設定ファイルへのミラーはありません。[`imageRescale`](#imagerescale) を参照してください。 |
| `BILI_PLUGIN_BYPASS` | x-bili-plugin-bypass パススルー判定のオペレーターオーバーライド (#6220)、リクエストごとに読み取り (再起動不要)。3 状態: **未設定**/`auto` = 現状 (受信ヘッダーがリクエストごとに判定); **`1`/`on`/`true`** = 強制バイパス (すべてのリクエストをそのまま転送 — ツール注入なし、nudge なし、セッションバインドなし); **`0`/`off`/`false`** = 常にバイパスしない (受信 x-bili-plugin-bypass ヘッダーをすべて無視); 識別できない値は `auto` として扱われます。#6220 の owner 承認により環境変数のみです — 設定ファイルへのミラーはありません。 |
| `BILI_PREFLIGHT_HOLD_MS` | 長時間のプリフライト圧縮が keep-alive バイトでクライアントを保持し始めるまでの猶予期間 (ms) (デフォルト `30000`; #568 を参照)。 |
| `BILI_STREAM_KEEPALIVE_MS` | ストリーミングフェーズのクライアント保持 (#1647): SSE レスポンスがこのミリ秒数にわたってクライアントにゼロバイトしか書き込んでいない場合、bili は 1 行の SSE コメント行 (`: bili-keepalive`、仕様レベルの no-op) を発行し、クライアントの undici `bodyTimeout` (デフォルト 300秒; Node 組み込み fetch はリクエストごとにオーバーライドできません) が、上流がリライター/ストリップパイプを飲み込むピンポンで応答している長時間プリフィルを殺すのを防ぎます。デフォルトは `15000`; `0` で無効にします。`BILI_PREFLIGHT_HOLD_MS` の兄弟で、後者は圧縮プリフライトの沈黙をカバーし、これはストリーミング中の上流起因の沈黙をカバーします。 |
| `BILI_RECLAIM_FETCH_PATCH` | `0` に設定すると、ネイティブモードの fetch 自己修復リアームを無効にします (#1158)。デフォルトでは、ネイティブ fetch インターセプトは `globalThis.fetch` をガード付きアクセサとしてインストールするため、`globalThis.fetch` を再インストールするサードパーティのパッチ (例: dsh-http-proxy の設定リフレッシュが凍結された pre-bili `originalFetch` を書き込む場合) は下流として再チェーンされ、モデルトラフィックは bili を通ってルーティングされ続けます。`0` の場合、従来の直接インストールが残ります: サードパーティのリアームが勝つため、そのセッションで bili はモデルトラフィックを見なくなります。**送信メモ:** ガードが保持されている間、クレームされたモデルトラフィックは bili プロキシ自身によってディスパッチされます — サードパーティチェーンの送信 (例: dsh-http-proxy で設定された SOCKS5 プロキシ; bili 自身のアップストリームプロキシングは HTTP プロキシのみサポート) に乗らなくなります。サードパーティの送信を復元する必要がある場合は、`0` を設定し、bili レベルで送信を設定してください (`"proxy": "http://…"` )。**共存メモ (#3528):** デフォルトのアクセサ形式は、`globalThis.fetch` がプレーンな書き込み可能データプロパティであることを要求するサードパーティコンポーネントと互換性がありません — 彼らはプロパティディスクリプタを読み取り、`value` を見つけず、ロード時に fetch 観測者を中断します (報告済み: DSH Desktop の Developer Tools / NodeJS 診断プラグイン、`@deepseek-ai/dsh-experimental-inspector`)。そのような観測者が従来の直接インストール経由でロードされるように `0` を設定してください (その後ホストを完全に再起動); 上記のトレードオフを受け入れます。#3528 を参照してください。 |
| `BILI_RESIGN` | `0` に設定すると、#1884 の再署名アームをエンドツーエンドで展開解除します (修正前の動作: 署名されたボディは通常の書き換えパスに乗って上流で 401 で失敗します)。デフォルト: アーム済み — 再署名可能な (解決可能なクレデンシャルを持つ SDK-HMAC-SHA256) 署名されたモデルリクエストは、すべての送信ボディが再署名されてトンネルされます; このアームは dsh での設定を必要としません (クレデンシャルサービス経由のアカウントプール検出)。再署名できない (解決可能なクレデンシャルがない) BUILT-IN スキームのリクエストは、実行可能なメッセージとともにローカルで 403 で拒否されます — その修正 (クレデンシャルの提供) は実行可能です。検出されたその他のすべてのスキーム (SigV4、`x-ofm-signature` のようなゲートウェイ発明ヘッダー — 検出は形状ベース、#2090) は bili のどこにもクレデンシャルソースがないため、常に拒否されます (バイナリ契約: 再署名+圧縮、または拒否、署名なしでのパススルーは決してない): スキーム名を特定した 403、`resign-pending.json` に記憶され、bili がそのスキームの再署名機能をリリースするまで、すべての起動時に再警告されます (Web UI でも表示)。`BILI_RESIGN_PASSTHROUGH=1` は BUILT-IN スキームのみに対して、圧縮なしの逐語転送をオンにします — その他のすべてのスキームに対しては無効です。`enabled` / `passthrough` / `credentialRef` は [`resign`](#resign) ブロックの下に設定ファイルの双子を持ち、署名スキームをキーとします (`resign["sdk-hmac-sha256"]`; `providers.<url>.resign["<scheme>"]` はレベル 2 のオーバーライド) — 環境変数はファイルより優先されます。スキームキーはパススルーのオプトインを固定します: そのキーが設定されたスキームのみがトンネルされます。関連: `BILI_RESIGN_BENEFIT` (署名付き `maas_type: benefit` ヘッダーが付与される CodeArts ベネフィットモデルのコンマ区切りリスト — 3 層ツリー全体より優先; ファイル側の双子はレベル 3 の `models.<name>.benefit` ブール値で、未設定の場合は組み込みの `glm-5.3-flash,deepseek-v4.1-flash` にフォールバックし、dsh codearts プラグインの `CODEARTS_BENEFIT_FALLBACK` を反映) および `BILI_CODEARTS_REF` (有効な `codearts` アカウントを `$DSH_HOME/jet-hub/state.json` から検出する代わりに、再署名に使用される dsh クレデンシャルサービス ref を強制)。 |
| `BILI_CONFIG_FILE` | 設定ファイルのパスをオーバーライド (任意の JSON ファイルを指定)。 |
| `ACP_PORT` / `PORT` | リスニングポートをオーバーライド。 |
| `ACP_HOST` | リスニングホストをオーバーライド。 |
| `ACP_UPSTREAM` | デフォルトのアップストリームベース URL をオーバーライド。 |
| `ACP_LOG` | `0` に設定すると、リクエストログを無効にします。 |
| `ACP_AUTO_UPDATE` | `0` に設定すると、自動更新チェックを無効にします。ファイル設定キー: `autoUpdate`。 |
| `ACP_AUTO_RESTART_ON_UPDATE` | `1` (任意の `0` 以外の値) に設定すると、自動更新インストール後の自己再起動を有効にします (#811): 再起動には進行中のリクエストがゼロであること、インストール健全性チェックをパスすること、10 分間のクールダウンマーカーを尊重すること、失敗時に元のリスナーを再開することが必要です。ファイル設定キー: `autoRestartOnUpdate`。 |
| `ACP_UPDATE_TAG` | 自動更新プログラムが追跡する dist-tag チャンネル (デフォルト `latest`、例: `dev`)。ファイル設定キー: `updateTag`。ローリング `pr` タグはすべての PR にわたる最新の PR テストビルドを追跡します; レガシーな PR 別 `pr-N` タグはその PR の最後のビルドで凍結され、明示的に設定された場合のみ追跡されます。ローリング `master` タグは master にマージされた最新のビルドを追跡します — すべての非リリースマージが 1 つ公開します (#2049); マージ済み但未リリースの状態を追跡するにはこれを設定してください。 |
| `BILI_UPDATE_REGISTRY` | 自動更新プログラムと `bili update` が使用する npm レジストリのベース URL のオーバーライド (デフォルト `https://registry.npmjs.org`)。ループバックレジストリ (e2e スイートの `ACP_TEST_REGISTRY` 内の verdaccio インスタンス) に対する密閉テストを想定しています; 本番環境では未設定のままにしてください (#1153)。 |
| `BILI_UPDATE_CHECK_INTERVAL_MS` | 自動更新チェックの間隔 (ミリ秒) (デフォルト `180000`、つまり 3 分; 0 以下の値は無視されデフォルトが適用されます)。密閉 e2e スイートでは短縮され、完全なサイクルを待たないようにしています (#1153)。 |
| `BILI_UPDATE_STAGGER_MIN_MS` | ランダムなアップグレード遅延ウィンドウの下限 (#3619): 新しいバージョンを発見した後、自動アップグレードは [min, max] 内の抽選された時刻まで待機します — 未設定の場合は組み込み 15 分。リモートポリシーの `default` より優先されます; `0` でこのマシンの遅延を無効にします (レガシーの即時アップグレード)。ここでは生の ms; ファイルの双子は期間文字列 (`"15m"`) も受け入れます。 |
| `BILI_UPDATE_STAGGER_MAX_MS` | ランダムなアップグレード遅延ウィンドウの上限 (#3619) — 未設定の場合は組み込み 48 時間。両方の境界が `0` に設定されている場合、アップグレードは #3619 以前と同様に即時に行われます。ここでは生の ms; ファイルの双子は期間文字列 (`"2d"`) も受け入れます。 |
| `BILI_UPDATE_POLICY_URL` | リモート更新ポリシー JSON URL のオーバーライド (#3619)。デフォルト: 公式リポジトリの raw アドレスにある `auto-update-policy.json` — 設計上固定されています。ポリシーはタイミング/スキップ/ピンを誘導できますが、インストールソースは決して変更できないためです; オーバーライドは密閉テストのために存在します。ファイルの双子: `update.policyUrl`。 |
| `BILI_MODEL_INFO_RETRY_MS` | dsh ネイティブプラグインが、解決に失敗したかウィンドウを返さなかった現在のモデルのコンテキストウィンドウを再解決するまでのクールダウン (ms) (#1812/#1836): ウィンドウのないキャッシュエントリは最終的ではありません — プロセスの生存期間中ヘッダーなしに固定する代わりに、このクールダウン後の次のリクエストがリトライをトリガーします。デフォルトは `30000`; 数値でない場合や負の値は `30000` にフォールバックします。テストフック — dsh-native ユニットテストでは壁時計を待たないように短縮されています; 本番環境では未設定のままにしてください。 |
| `BILI_DSH_RETRY_INTERVAL_MS` | dsh ネイティブプラグインのツール登録リトライ間のバックオフ (ms) (#2082): マニフェスト取得またはツール登録が一時的に失敗した後、次のリトライはこのクールダウンより早く行われません。デフォルトは `10000`; 数値でない場合や非正の値は `10000` にフォールバックします。テストフック — dsh-native ユニットテストでは壁時計を待たないように短縮されています; 本番環境では未設定のままにしてください。 |
| `BILI_DSH_RECOVERY_INTERVAL_MS` | dsh ネイティブプラグインのデタッチされたリカバリータイマーの間隔 (ms) (#2082): ツールがダウンしている間、モデルトラフィックがゼロでも登録リトライを駆動し続けます — モデルが欠落ツールを諦め、他の何ものもループを再アームしない場合です。デフォルトでは `BILI_DSH_RETRY_INTERVAL_MS` (`10000`) に従います。テストフック — NODE_TEST_CONTEXT 下では、この変数が明示的に設定されない限りタイマーは開始されません; 本番環境では未設定のままにしてください。 |
| `BILI_DSH_MAX_TESTED_VERSION` | テスト済みより新しい dsh ブートノートの上限 (dsh ネイティブレーン): 実行中の dsh ビルド — 注入されたバンドルの上にある最も近い `node_modules/@deepseek-ai/dsh/package.json` から解決 — はこの最新テスト済みバージョンと比較され (semver、プレリリース対応)、厳密に新しい場合、サポートが実装されるまで上限バージョンへのロールバックを助言する 1 つの永続的なブート時ノート (dsh セッション内) を得ます。片方向のみ: 上限以下または等しいビルドは沈黙します。既知の旧ビルドの破損モードには独自のオーバーレイラッチ検出器があるためです (#3806 ブート警告 + #2474 フォールバック)。設計上ソフトです: 警告のみで、トラフィックをゲートまたはブロックしません (誤った推測が動作しているセッションを停止させてはならないため)。デフォルト = `0.2.0-rc.2`、CI e2e アンカー (.github/workflows/ci-e2e-dsh-native.yml); ビルドが検証されるにつれて上限を上げてください; 空文字列はこのレーンでのチェックをオフにします。解決不能/解析不能なバージョンは沈黙にフェイルオープンします (証拠の欠如 ≠ 破損ビルド)。 |
| `BILI_ADVISORY_CHECK` | `0` に設定すると、重大欠陥アドバイザリーウォッチャーを無効にします (#1481)。デフォルトはオン — `ACP_AUTO_UPDATE` に独立して実行されるため、自動更新をオフにしたインストールでも、既知の破損バージョン範囲から強制更新されます。フェイルオープン: 到達不能/不正なソースは警告のみで、モデルトラフィックをブロックしません。ファイル設定キー: `advisoryCheck`。 |
| `BILI_ADVISORY_URL` | アドバイザリー文書 URL のオーバーライド。デフォルト: 設定されたレジストリ (`BILI_UPDATE_REGISTRY` 対応) 上のコンパニオンパッケージ `billion-context-advisories`。ファイル設定キー: `advisoryUrl`。 |
| `BILI_RELEASE_NOTES_CHECK` | `0` に設定すると、リリースノート可視性ウォッチャーを無効にします (#1870)。デフォルトはオン — 純粋な可視性、デフォルトでは沈黙 (#1977): コンパニオンリリースノート文書をフェッチし、保留スパンに `critical` ティアのエントリを含む場合のみ、`acp_status` と `/acp` パネルで "CRITICAL update ready — restart to finish" (ディスクが実行中より新しい) または "critical update available" を表示します; 常時/推奨リリースは決して表示されません。決してインストールせず、再起動しません; フェイルオープン。ファイル設定キー: `releaseNotesCheck`。 |
| `BILI_RELEASE_NOTES_URL` | リリースノート文書 URL のオーバーライド。デフォルト: 設定されたレジストリ (`BILI_UPDATE_REGISTRY` 対応) 上のコンパニオンパッケージ `billion-context-release-notes`。ファイル設定キー: `releaseNotesUrl`。 |
| ~~`BILI_HOST_USAGE_CREDIT`~~ / ~~`hostUsageCredit`~~ | **#660 で削除。** ホスト向けの使用量モードを選択するために使用されていました。#408 の非圧縮ベースラインバックフィルは完全に削除されました — すべてのホストは実際に転送された (折り畳み後) リクエストをプロバイダー測定として報告します (`[acp-usage] input=` に一致)。環境変数または設定ファイルに残された古い値は無視されます; 削除してください。PR #691 の "Bug history lesson" セクションを参照してください。 |
| `ACP_PROVIDERS` | 外部 `providers.json` へのパス (レガシー / 共有ファイル)。 |
| `BILI_REPLAY_RETRY_BASE_MS` | 一時的な上流拒否後のリプレイリトライのベースバックオフ遅延 (ms) (デフォルト `1500`; `0` で遅延を無効にします)。#189 を参照。また、メインパスのトランスポートリトライバックオフも駆動します (#1688)。 |
| `BILI_REPLAY_RETRY_MAX` | リプレイリトライの総試行回数 (デフォルト `3`; `1` でリトライを完全に無効にします — レガシーの単一試行動作)。#189 を参照。acp-loop/preflight/compress ループでは、一時的な HTTP 失敗と #1263 のフェイルファストネットワーク失敗 (レスポンス前のリセット/拒否 — プロキシリサイクルクラス) の両方に適用されますが、タイムアウト/中断タイプには適用されません。メインモデルリクエストパス (#1688) では、フェイルファストのレスポンス前ネットワーク失敗のみがリプレイされます; HTTP 判定 (4xx/5xx) は常に逐語通り、再試行されません。 |
| `BILI_PROXY_KEEPALIVE_MAX_MS` | アップストリームプロキシを介した接続の keep-alive 再利用上限 (ms) (デフォルト `55000`)。一般的なプロキシは約 60 秒の周期でアイドルトンネルをリサイクルします; 再利用ウィンドウをそれより低く制限することで、いくつかの再接続と引き換えに、典型的な "アイドル後の最初のリクエストが ECONNRESET で死ぬ" 失敗 (#1263) を回避します。`0` = 上限なし (undici デフォルト)。直接 (プロキシなし) 接続には影響しません。 |
| `BILI_UPSTREAM_TIMEOUT_MS` | アップストリームリクエストのアイドル予算 (ms): 最初のバイトまでの時間とボディチャンク間の時間 (デフォルト `720000` = 12 分)。チャンクを生成し続ける健全なストリームは飛行中に切断されることはありません; 沈黙しているものは切断されます。同じ値が基礎となる HTTP クライアントのトランスポートタイムアウトを駆動するため、この単一のノブがローカルモデルの長時間プリフィルをエンドツーエンドで制限します (#551)。 |
| `BILI_CA_FILE` | bili 自身のアップストリーム TLS 信頼用の追加ルート CA を含む PEM ファイルへのパス (#3776)。HTTPS/暗号化接続スキャンを行うセキュリティソフトウェア (Kaspersky、エンタープライズ DLP) または企業 MITM プロキシは、独自の CA でアップストリームを再署名します: ブラウザは OS 証明書ストア経由でそれを信頼しますが、Node の fetch は組み込みルートと `NODE_EXTRA_CA_CERTS` のみを読み取ります — したがって、マシンの他の部分が正常に接続している間に bili は `SELF_SIGNED_CERT_IN_CHAIN` で失敗します。スキャナ/ベンダーのルートを PEM にエクスポートし、これ (または `NODE_EXTRA_CA_CERTS`) を設定してください; あるいは、ソフトウェアの HTTPS 検査から node.exe を除外してください。ファイルは Node の組み込みルートと `NODE_EXTRA_CA_CERTS` エントリと Merged され、決して置き換えられません。未設定 = 今日のデフォルトの信頼、バイト単位で一致。ファイル設定キー: `network.caFile`。 |
| ~~`BILI_STREAM_STALL_MS`~~ | **#1714 で削除** (#1452 のオプトインストリーミングフェーズストールガードは廃止)。#1706 で、古い `400` エクスポートがすべての思考フェーズの沈黙を偽の切り詰めに変えました; ローカルモデルデプロイメントはストリーム中 (思考フェーズ、長時間プリフィル) に正しく数分間沈黙するため、すべての人にとって安全な有限なサブ予算はありませんでした。上流の沈黙 — プリフィルとストリーム中を問わず — は現在、常にオンである `BILI_UPSTREAM_TIMEOUT_MS` のアイドル予算 (デフォルト 12 分、調整可能) によってのみ制限されます。古い値は無視されます; bili は起動時に一度だけ古いエクスポートを特定します (`no longer read`) — シェルプロファイルから削除してください。 |
| `BILI_KEEP_ALIVE_TIMEOUT_MS` | クライアント向けソケットの keep-alive タイムアウト (ms) (デフォルト `5000`、Node の暗黙のデフォルトに一致; #1452)。アイドルのクライアント接続は Node の組み込みリーパーによってクリーンな FIN で刈り取られます; これにより、以前は暗黙的だった値を明示的かつ設定可能にし、刈り取りは接続ライフサイクル台帳 (デバッグログ) で `reason=idle-timeout` として分類されます。数値でない場合や非正の値は `5000` にフォールバックします。 |
| `BILI_EXPOSURE_LOG_INTERVAL_MS` | 周期的な長期間露出テレメトリ行 `[exposure] uptime=… liveConns=… tcpHandles=… handles=… sessions=… blindTunnels=… inFlight=…` の間隔 (ms) (デフォルト `3600000` = 毎時; #1452)。`0` で無効にします。ソケットハンドルのリークとゾンビ接続が、事後の法医学ではなく、長時間実行ログに表示されるように存在します。 |
| `BILI_CLIENT_ERROR_BACKSTOP_MS` | clientError ドレインパスのターミナルバックストップ (ms) (#1529、#1452 アイテム 1 のフォローアップ): 300ms のドレイン bailout が FIN を決して送信しないピアを持つ接続を `end()` した後、ソケットはそれ以外の場合、私たちの側で半開き状態で無限に座り続けます — keep-alive リーパーは完了したレスポンスをキーとし、Node はデフォルトで SO_KEEPALIVE を有効にしません。この bailout 後の沈黙が経過した後、プロキシはソケットを破棄し、接続ライフサイクル台帳で独自の警告マーカーとともに `reason=clienterror-backstop` として分類します。#1452 の RST シグネチャに対して安全です: ソケットはウィンドウ全体で `resume()` ドレインされているため、破棄には未読の残存バイトがありません。デフォルトは `30000`; `0` でピアの死まで保持する現状を復元します。数値でない場合や負の値は `30000` にフォールバックします。 |
| `BILI_POST_RESPONSE_LINGER_MS` | 完了したレスポンス後のグレースフルクローズ予算 (ms) (#1982): プロキシが最後のレスポンス直後にクライアント接続のクローズを開始する場合 (例: `Connection: close`)、ピアのクローズシグナル — TCP FIN または TLS close_notify、これは私たちの最終バイトが受信+ACK された後にのみ到着可能 — を待ってソケットを開いたままにします — その後クリーンにクローズします; 予算内にシグナルが到着しない場合、ソケットはそれでも破棄され、`reason=linger-backstop` (警告行) として分類されます。これにより、クライアント側で未 ACK のバイトを RST に競合させる可能性のある中断的な破棄が除去されます (nginx `lingering_time` と同等)。デフォルトは `5000`; 数値でない場合や非正の値は `5000` にフォールバックします。エラー駆動のクローズ、ハンドシェイク前の破棄、clientError ドレイン (#1529)、アイドルリーパーは意図的に影響を受けません。 |
| `BILI_ALLOW_PRIVATE_HTTP_PROVIDERS` | オプトインスイッチ (#2984): プライベートネットワーク (RFC1918, 127/8, リンクローカル、IPv6 ULA/リンクローカル、`*.local`/`.lan`/`.internal`) 上のプレーン HTTP プロバイダー baseURL が、エージェントレジストリの受入とサマリーエンドポイントガードを通過できるようにするには `1`/`true` に設定します。それ以外の場合は、ループバックのプレーンテキストのみを信頼します。パブリック IP/ドメインと CGNAT (100.64/10) は常に拒否されます。デフォルトはオフ — #2984 以前と動作が同一です。設定された環境変数の値は `network.allowPrivateHttpProviders` より優先されます。 |
| `ACP_SESSION_HEADER` | 会話 ID ヘッダー名 (デフォルト `x-acp-session`)。 |
| `ACP_REASONING_KEEP` | Responses API のみ: `none` に設定すると、すべての推論アイテムを破棄します。デフォルトでは、推論は圧縮パイプラインを通過し、そのターンが要約されると自動的に隠されます (Codex のプロンプトキャッシュプレフィックスを破った無制限な蓄積を防ぎます)。 |
| `ACP_RENDER_NONE` | `1` に設定すると、送信リクエスト履歴へのメッセージごとのレンダリングタグ ( `mNNNNN` 参照を持つ `` `<acp>` `` マーカー) の注入を停止します — すべてのワイヤ形式 (OpenAI chat, Anthropic, Responses) およびコンパクト再構築に適用されます (#933)。デフォルトは `text-only`: モデルはこれらの参照を読み取り、`compress` 呼び出しでメッセージを引用するため、参照ベースの圧縮を必要としないワークフローであることが確認できた場合のみ無効にしてください (例: タグの反響がクライアント可視出力に漏れる)。以前は、この変数は Responses パスとコンパクトでのみ尊重されていました; #933 ですべてのパスに拡張されました。 |
| `ACP_LOG_FILE` | ログファイルのパス (デフォルト XDG state パス; `off` でファイルを無効にし、stderr を保持)。10 MB で自動ローテーション。 |
| `ACP_DUMP_SSE` | デバッグ用に生の SSE フレームをダンプするディレクトリ — ループ起因の上流レスポンス (compress 再リクエストと切り詰めリトライ、`<ts>-<sid>-loop<N>-raw.sse` と命名) を含む。これらは外部の forward tee では見えない (#1455)。 |
| `BILI_STREAM_ERROR_SHAPE` | `"completion"` に設定すると、anthropic/openai ワイヤ上のレガシーの失敗形状を復元します (合成された成功完了内の失敗テキスト); デフォルト `"protocol"` = プロトコルネイティブのエラーフレーム (#1455)。`compat.streamErrorShape` と同じノブです; この環境変数が優先されます。 |
| `BILI_LOG_MASK_HOSTS` | `0` に設定すると、プロキシログのホストマスキングをオフにします (#897): 非パブリックのターゲットホスト (プライベートリレー、内部ドメイン) は `<private-host>` ではなく逐語で記録されます。デフォルトはオン (#255 — ログがパブリックな issue に貼り付けられる); クレデンシャルヘッダーのマスキングは独立しており、常にオンです。実際のターゲットホストは、このフラグに触れずに常に利用可能です: `GET /__bili/stats` → `blindTunnels`、`GET /__bili/health` (どちらもループバックのみ)、および `acp_status` の出力。 |
| `BILI_SUBAGENT_SPLIT` | `0` に設定すると、Claude Code サブエージェントセッション分割をオフにします (#970): デフォルトでは、anthropic ワイヤのリクエストが `x-claude-code-agent-id` + `x-claude-code-parent-agent-id` ペア (バックグラウンドサブエージェント) を運ぶ場合、メインセッションのロックの後ろにキューを積む代わりに、独自の `<session>\|sub:<agent-id>` セッション — 独自のロックチェーンと圧縮状態 — を得ます。デフォルトはオンです。設定ファイルの `"subagentSplit": false` は同じことをします; 環境変数が優先されます。Responses ワイヤ: no-op — `subagentSplit` / BOTH-mechanisms スコープノートを参照してください。 |
| `BILI_FORK_ADOPTION` | `1` に設定すると、フォークブロック採用をオンにします (#629): 匿名 (プレフィックスアフィニティ) クライアントが会話中に履歴をフォークする場合 (編集して再送信 / 以前のターンを再生成)、新しいセッションは、フォークされたリクエストに完全に存在するソースコンテンツを持つ親の圧縮ブロックを継承します — 圧縮状態ゼロで開始し、共有プレフィックスを最初から再折り畳む代わりに。デフォルトはオフです。識別されたリサマフォークはこのスイッチの対象ではありません — `BILI_RESUME_INHERITANCE` (#1834) と一緒にブロックを採用します。設定ファイルの `"forkAdoption": true` は同じことをします; 環境変数が優先されます。採用可能なインベントリは、無効化中であってもすべての匿名フォークで記録されるため、オンにする前に利益の規模を把握できます。 |
| `BILI_AFFINITY_SIMHASH` | `0` に設定すると、simhash チェーンアライメント採用をオフにします (#2265): クライアント側の普遍的な装飾的書き換え (例: Trae がすべてのアシスタントメッセージにモデルタグを再スタンプする) によって正確なハッシュチェーンが壊れた匿名リクエストは、新しく発行してゼロから再折り畳む代わりに、圧縮状態を持つ既存のセッションに再接続します。ガード: ハミング距離 10 以内で ≥90% カバレッジ、変異したが類似の位置 ≥20% (ポイント編集はそれでもフォーク、#629)、バイト同一のユーザーメッセージ ≥1、候補は一意のみ。デフォルトはオン。設定ファイルの `"affinitySimhash": false` は同じことをします; 環境変数が優先されます。 |
| `BILI_RESUME_INHERITANCE` | `0` に設定すると、リサマ継承をオフにします (デフォルトはオン) (#1486): 識別されたクライアント (独自のセッション ID を送信、例: Claude Code の `x-claude-code-session-id`) が完全なトランスクリプトをリプレイしながら新しいセッション ID で会話を再開する場合 (`cc --resume` は新しい UUID をフォーク)、bili は受信履歴をそのクライアントの追跡チェーンとバイト単位で正確に照合し (≥8 メッセージ、追記のみ追跡)、再開セッションの最初のリクエストで、親の参照割り当てを継承します — 古いモデル引用は、番号付けが変更されたものに誤ってヒットするのではなく、元のメッセージに解決されます — 完全に存在する圧縮ブロックを採用します (この継承とともに、#1834: リサマでそれらを失うと、折り畳まれたオリジナルがワイヤに戻り、上流リクエストが膨張しました; 古い `forkAdoption` 共ゲートは現在匿名フォークのみに適用、#629)、そして `derivedFrom` 系譜を記録します。親は決して変更されず、新しいメッセージは親の参照空間の上で番号付けされます。リサマは親の履歴を厳密に拡張する必要があります — 他の ID での等深度バイト正確なリプレイは重複であり、リサマではありません。匿名セッションには影響しません (独自の pfa-* ワールドを保持、#309)。設定ファイルの `"resumeInheritance": false` は同じことをします; 環境変数が優先されます。 |
| `BILI_STABLE_SYSTEM_ANCHOR` | `1` に設定すると、安定システムアンカリングを有効にします (#1085) — プレフィックスキャッシュのための**ベストエフォートのワイヤレイヤーフォールバック**: ルート修正はクライアント側に属します (クライアントは自身の履歴を所有し、指示変更をどのように提示するかを決定する)、これはプロキシが変更されたヘッドがキャッシュされたプレフィックス全体を無効にするのを防ぐだけです。**プレーンプロキシモードのみ**: プラグインモードのエージェント (`x-bili-plugin`) は自身のコンテキスト管理を所有し、決してアンカーされないため、すでにキャッシュフレンドリーな更新を注入するクライアント (例: claude-code スタイルのシステムリマインダー) は二重処理されません。有効化されると、bili は各セッションの最初に見たヘッドシステム/指示ブロックを記憶し、クライアントのシステムプロンプトが後に変更されても、それらの正確なバイトを再送信し続けます。**局所的な**変更 (これまで有効だったバージョンと ≥70% の行を共有するファイルスタイルの編集) は、コンパクトな行差分 (`-` 削除 / `+` 追加; 各ノートは前のものの上に順次構成される) を運ぶ末尾の `[System context update] …` ユーザーノートを追加します。**非局所的な**変更 (構造的な並べ替え、ツール定義の流動、タイムスタンプ付きバナー、400 行を超えるヘッド) はそのまま採用されます — 1 つの意図的なキャッシュミスは、モデルに指示について誤解させるノイズを追加するより優れています。流動ガード: 累積ノートが 8 を超えると、アンカーを最新のテキストで置き換え、ログをクリアします。アンカーとノートログはセッションとともに永続化され、圧縮/コンパクト化を生き残ります (セッションメタデータ、カーネル状態ではない)。既知の残存制限: クライアント配置の `cache_control` ブレークポイントは、ヘッド交換後もまだ不一致になる可能性があります。アンカリングから除外: タイトル生成マイクロリクエスト (OpenAI/Google)、Responses コンパクト化トリガーリクエスト、オートモード分類器リクエスト。独自のバリアント (安定プロンプト + 履歴内更新) を実装するクライアントは、追加の注入をゼロにします —そのような更新は通常の履歴として通過します。デフォルトはオフです。設定ファイルの `"stableSystemAnchor": true` は同じことをします; 環境変数が優先されます。 |
| `BILI_ALLOW_DSH_COMPACTION` | **#3666 で削除** (#2028 を代替)。以前のスイッチは、ワイヤレベルの拒否 (#1729) を解除することで、dsh の組み込みオートコンパクト化が bili を通って実行されることを許可していました; dsh チェックポイントが着地すると生会話履歴を永続的に影隠しするため — 不可逆的であり、プロキシの圧縮基盤を破壊する — エスケープハッチは完全に削除されました: dsh ネイティブコンパクト化呼び出しは現在、bili が提供するすべてのレーン、すべてのビルドで無条件にインターセプトされ、デフォルトでは拒否 (422) されます、または `BILI_DSH_AUTHORED_COMPACTION` が設定されている場合、bili 自身によってローカルで応答されます (下の行)。残された値 — `"dsh": { "allowDshCompaction": true }`、古いファイルのトップレベルの単独 `"allowDshCompaction"`、または古い環境変数 — は、それを特定する一度限りの非推奨警告とともに無視されます。dsh 側のチェックポイントを完全に排除する必要がある場合は、代わりにホスト側の抑制を適用してください: 非 Web プロファイルでの出荷バンドルパッチ (`auto: false`)、または Web プロファイルでの #3354 ロード時オーバーレイ / #2474 プリセット標準の完全スナップショットオーバーライド。 |
| `BILI_DSH_CONTEXT_TAB` | `0` に設定すると、DSH トップバーの「上下文」/「Context」会話タブを削除します (#4237) — 名前は同機に併装されている dsh-context の同名タブと衝突し、このノブ以前はユーザー側のスイッチが存在しませんでした。非表示はタブのみを削除します: 圧縮、設定セクション (会話サブページ)、プラグインバンドル設定フェイス、Web UI、/acp コマンドはすべて影響を受けません — 台帳はそこで到達可能のままです。他の任意の値 (`1`, `true`, …) はファイルティアを無視してタブを強制オンにします; 未設定の場合、設定ファイルの `dsh.contextTab` ブール値が適用されます (デフォルト true = 今日の動作)。設定は既存のスナップショット + `/bili/origin` キャリアを通じて DSH ページに配信され、ページロード時に読み取られるため、プロキシ再起動なしに次のページロード / dsh 再起動で有効になります。タブの表示名は別のファイルのみティアです: `dsh.contextTabLabel`。 |
| `BILI_DSH_AUTHORED_COMPACTION` | `1` に設定すると、dsh のコンパクト化サマライズ呼び出しを拒否する代わりに、bili 自身がローカルで応答するようにします (#3733)。呼び出しごとの前提条件: #1729 ガードが発火 (マーカー決定; #3651 以降は無条件) し、セッションが少なくとも 1 つのアクティブな折り畳みブロックを保持していること。応答はゼロ送信で偽造されます (autoModeForge #2740 の規律): アイデンティティヘッダー `<bili-snapshot v1 conv="…" seq="…" blocks="…" />` と、カーネルレンダリング形式でのすべてのアクティブブロックのサマリー — モデルがすでに上流で読み取っている正確なバイトであり、クライアント表示、上流コンテキスト、サーバー状態が初めて一致し、dsh のチェックポイントファイルが縮小します (#3723 の無制限成長ループ)。オリジナルは CCR/エクスポート経由で復元可能であり、着地したチェックポイントはリプレイ時に同じ #2432 リベースを通じて外部のものとして認識されますが、`dshAuthoredCheckpointLanded` (info、warn ではない) として記録されます。ロールアウトウィンドウのために環境変数のみ; リクエストごとに読み取られ、再起動は不要です。 |
| `BILI_NO_CACHE_CONTROL` | `1` に設定すると、bili の Anthropic レーンの `cache_control` ブレークポイントスタンプを無効にします (#1637、#1639 で出荷)。デフォルトはオン: Anthropic スタイルの上流は明示的にブレークポイントされたもののみをキャッシュします (リクエストごとに最大 4 つ、system + tools + message ブロックを合計してカウント)、そのため bili はシステムブロックに加えて最大 3 つの累積メッセージマークをマークします — マークされたメッセージはマークされたまま (バイト安定プレフィックス)、マークは折り畳みによってのみ消え、最後の 3 つの安定メッセージが前進するフロンティアを運びます。クライアント設定の `cache_control` (メッセージブロック、tools エントリ) は bili のスタンプを完全に抑制します — クライアント管理のキャッシュが優先されます。マークはセッションとともに永続化されます。このスイッチは、フィールドを拒否する上流や独自のブレークポイントポリシーを持つリレーのためのエスケープハッチです。プレーンプロキシ Anthropic レーンのみ; OpenAI/Responses レーンは暗黙にキャッシュされ、決してスタンプされません。設定ファイルの双子: [`compat.noCacheControl`](#compat) — 環境変数が優先されます。 |
| `BILI_CACHE_KEEPALIVE` | `1` に設定すると、Anthropic ワイヤのアイドルプロンプトキャッシュ keepalive をオンにします (#3376) — 完全なメカニズム、停止ルール、コストノートを [`cacheKeepalive`](#cachekeepalive) を参照してください。ファイルの双子: `"cacheKeepalive": { "enabled": true }`; 環境変数が優先されます。デフォルトはオフ。 |
| `BILI_CACHE_KEEPALIVE_TTL_FACTOR` | 検出/推定されたキャッシュ TTL ティアに適用される頻度係数 (デフォルト `0.9` → 5 分ティアで約 4.5 分、1 時間ティアで約 54 分にピンポン)。`(0, 1]` の範囲でなければなりません。ファイルの双子: `cacheKeepalive.ttlFactor`。 |
| `BILI_CACHE_KEEPALIVE_MAX_DURATION_MS` | セッションごとの最大 keepalive 寿命、最後の REAL リクエストから測定 (デフォルト `86400000` = 24 時間); それを超えると、アームされたセッションはヒットし続けていても解除されます。ファイルの双子: `cacheKeepalive.maxDurationMs`。 |
| `BILI_CACHE_KEEPALIVE_MAX_PINGS` | 同時にアームされたセッションの最大数 (デフォルト `4`); オーバーフローは最も長いアイドルセッションの keepalive を追い出します。ファイルの双子: `cacheKeepalive.maxConcurrentPings`。 |
| `BILI_CACHE_KEEPALIVE_ASSUME_TTL` | `"5m"` または `"1h"`: ボディのブレークポイント検出をスキップし、代わりにこのティアから頻度を実行します — bili の下流で `cache_control` TTL を注入または書き換えるリレー/プロキシのために、転送されたボディに (または誤った) ブレークポイントティアが表示されない場合。ファイルの双子: `cacheKeepalive.assumeTtl`。 |
| `BILI_CACHE_KEEPALIVE_ARM_WITHOUT_BREAKPOINTS` | `1` に設定すると、転送されたボディに `cache_control` ブレークポイントがない場合でも keepalive をアームします (デフォルトはオフ — ブレークポイントなしでは明示的にブレークポイントされたものをリフレッシュするものがありません; リレーがブレークポイントを所有している場合は `assumeTtl`/`intervalMs` と組み合わせる)。ファイルの双子: `cacheKeepalive.armWithoutBreakpoints`。 |
| `BILI_CACHE_KEEPALIVE_INTERVAL_MS` | ミリ秒単位の絶対ピンポン間隔; `ttlFactor`、`assumeTtl`、検出されたティアより優先されます。上流の TTL ポリシーに関係なく固定頻度を使用する場合に使用します。ファイルの双子: `cacheKeepalive.intervalMs`。 |
| `BILI_CHAIN_CONTENT` | `1` に設定すると、bili→bili チェーン認識の ACP 成果物 / `<bili-chain …/>` チェックポイント**ボディコンテンツ**検出をオンにします (#1086/#1421): 受信リクエストがそのボディに圧縮成果物 (レンダリングタグ / 歴史的な `acp_status`+`search_context` ツール呼び出し) またはダイジェストを持つチェックポイントを運ぶが、`x-bili-hop` ヘッダーもそのセッションのローカル圧縮状態もない場合、bili はアドバイザリー観測を記録し、/または first-processor-wins パススルーを適用します。**デフォルトはオフ** (#1683 フォローアップ): デフォルトでは `x-bili-hop` ヘッダーのみがチェーン認識を駆動します。リクエスト BODY のスキャンは、CCR/ファイル導入テキストやモデル反響タグのような実際のマーカーに見えるものに偽陽性になる可能性があるためです。中間ボックスが `x-bili-hop` をストリップする狭いマルチ bili リレーケースで、その偽陽性リスクを受け入れる場合のみ有効にしてください。設定ファイルの `"chainContentDetection": true` は同じことをします; 環境変数が優先されます。`x-bili-hop` シグナル自体はこのスイッチの影響を受けません。 |
| `BILI_CHAIN_STAMP` | `1` に設定すると、**モデル可視**の `<bili-chain …/>` チェーン完全性チェックポイントキャリアの送信出力をオンにします (#1683、デフォルトオフ): 有効化されると、このインスタンスが実際に処理するすべてのリクエストは、`x-bili-hop` ヘッダーが転送中にストリップされた場合でも、下流の bili が first-processor-wins を適用できるように、ダイジェストを持つスタンプを付けて離れます (#1421)。キャリアは終端モデルも読み取るスロット (OpenAI/Responses では末尾の `user` メッセージ、Anthropic/Google では末尾のテキストパート) に着地するため、モデルはそれを幽霊ユーザー入力として扱い、コメントするためにトークンを消費します — これがデフォルトでオフである理由です。中間ボックスによって `x-bili-hop` がストリップされ、ダイジェスト検証済みボディスタンプが二重処理に対する唯一のガードである狭いマルチ bili リレーケースでのみ有効にしてください。`BILI_CHAIN_CONTENT` (受信ボディ検出もデフォルトオフ) およびどちらの方向でも動作する `x-bili-hop` パススルーとは独立しています。設定ファイルの `"chainEgressStamp": true` は同じことをします; 環境変数が優先されます。 |
| `BILI_CHAIN_MAX_FUTURE_SKEW_MS` | チェーンチェックポイントの `issued-at` タイムスタンプを検証する際に許容される最大未来スキュー (ms) (#1395 ステップ 2): この値より未来にスタンプされたチェックポイントは、ダイジェストが検証されていても `stale` (リプレイ / クロックスキュー) と判定されます。デフォルトは `120000` (2 分); 数値でない場合や非正の値はデフォルトにフォールバックします。ステップ 2 はシャドウのみです — これらのノブは判定ログを調整し、決して転送をしません。 |
| `BILI_CHAIN_RECENT_WINDOW_MS` | チェーンチェックポイント検証の新規性ウィンドウ (ms) (#1395 ステップ 2): これより古いチェックポイントは `stale` と判定されます。デフォルトは `600000` (10 分); 数値でない場合や非正の値はデフォルトにフォールバックします。ステップ 2 はシャドウのみです — これらのノブは判定ログを調整し、決して転送をしません。 |
| `BILI_CONFLICT_SCAN` | `0` に設定すると、サードパーティ圧縮プラグイン検出を無効にします (#1206)。デフォルトはオン: bili はクライアント自身のプラグイン/拡張レジストリ — opencode グローバル + プロジェクト `plugin` 配列、pi グローバル + プロジェクト `.pi/settings.json` `packages`、omp `config.yml` `extensions`、claude 設定 `enabledPlugins`/`plugins` + そのプラグインディレクトリ、kimi `plugins/installed.json`、hermes プラグインディレクトリ、dsh プロファイル依存関係 — をスキャンし、bili と同居する別の圧縮機を探します。2 つのティア: **既知の競合** (`opencode-acp`、レガシー `billion-context-pi`、および dsh の `dsh-live-compact`、#5984) と**キーワード疑わしい**エントリ (compress / compact / acp / summar* / context* に一致する名前; bili 自身のエントリは常にスキップされ、`context7` のような非圧縮ツールは一致しません)。発見は、クライアント開始前のランチャー stderr 行、各セッションの最初のリクエストでの一度限りのプロキシ警告ログ、セッションの競合台帳として表示されます — `acp_status` の `COMPRESSION CONFLICTS` セクション、`GET /__bili/stats` → `conflicts` で集計され、Web UI バナーとして表示されます。バナーはインターセプト**失敗**の警報です (#3235): 着地但未回復の証拠が存在する場合のみポップアップします (確認されたサードパーティ圧縮機、推定されたクライアントネイティブ着地、または説明のつかない履歴書き換えシグナル) — 回復 (インターセプト+リベース) された着地と疑わしい/兄弟在庫は記録されますが静かに保たれます。永続的な非表示 (新しいイベントで自動的に再アームされる localStorage ウォーターマーク) と、一般的な #3040 診断施設に乗る診断コピー / GitHub 報告ボタンを提供します。ランタイム干渉証拠 (告知なしの履歴書き換え #1001、孤立ブロックの無効化) は同じ台帳に供給されます。スキャンは読み取り専用、ベストエフォート、5 分キャッシュ、クライアント設定をブロックまたは変更しません。 |
| `BILI_UPSTREAM_PROXY` | プロキシ自身の送信接続用のアップストリームプロキシ — *グローバル* ソースの中で最優先 (Web UI 手動プロキシと設定ファイルの `proxy` より上)。URL ごとの `providers.<url>.proxy` は、一致するプロバイダー URL に対してはそれでも優先されます。完全な解決順序、ループ防止、例については、Server Settings の [`proxy`](#server-settings) を参照してください。 |
| `BILI_INHERITED_HTTP_PROXY` / `BILI_INHERITED_HTTPS_PROXY` / `BILI_INHERITED_ALL_PROXY` / `BILI_INHERITED_NO_PROXY` | ユーザー向けではありません — ランチャーがプロキシを起動する際に自動的に設定されます (#1012)。ランチャーはクライアントとプロキシ子プロセスの両方からシェルプロキシ変数をストリップします (クライアントは bili に送信する必要があり、プロキシはシェルプロキシによってモデル送信がハイジャックされてはならない)、しかしユーザーのストリップ前プロキシをこれらの名前で転送し、プロキシの**補助送信** (MITM 盲目トンネル — クライアント側の MCP/Web トラフィック) がユーザーの VPN に乗れるようにします。これらは盲目トンネルフォールバックティアのみを供給します: 明示的なルート / グローバル `proxy` / `BILI_UPSTREAM_PROXY` / 明示的な `"upstreamProxyMode": "direct"` はそれでも優先され、bili 自身のポートを指す値は破棄されます。モデル送信には影響しません (明示的に設定されない限り直接のまま)。 |
| `BILI_ATTACH_HEALTH_DEADLINE_MS` | アタッチターゲットがダウンしているが、このプロセスのモデルチャネルがそれに**ピン留め**されている場合 (ルーティングされた `/bili/…` モデルトラフィックがそれに対して観察された) の dsh/opencode アタッチ検証のヘルスウェイト期限 (ms): bili は第二のインスタンスを起動する代わりに、ターゲットが戻るのを待ちます — 起動はセッションを分割します (モデルトラフィックはピン留めされ、bili ツールは他のインスタンスに対して 404 になります)。期限が経過すると、ターゲットが戻るまで、すべてのモデルリクエストで再チェックしながら明確に失敗します (デフォルト `15000`)。#1365 を参照。 |
| `BILI_ATTACH_EVIDENCE_GRACE_MS` | dsh/opencode アタッチ検証が死んだターゲットをプローブする間、レガシー起動パスにフォールバックする前にルーティングチャネル証拠の出現を待つ猶予ウィンドウ (ms) (決定と最初のリクエストの競合をカバー: 最初のモデルリクエストが t≈1s で着地する間に、プローブは t≈0 で失敗する) (デフォルト `5000`)。#1365 を参照。 |
| `BILI_SILENT_DIRECT_MAX_MB` | プラグインのライブ状態スロットが欠落しているかリクエスト帰属が失われた場合、ローカルで 422 を返して直接モデルリクエストを拒否する生ボディバイトガードの上限 (MiB、> 0; 小数可) (#5405/#5408)。ガードは生バイトをカウントします — base64 膨張メディアを含む — したがって、画像中心のセッションは正しく 2 MiB を超える可能性があります; デフォルトは `8`。無効な値はデフォルトにフォールバックします。#5405、#5826 を参照。 |
| `BILI_SPAWN_WAIT_MS` | 新しく起動されたプロキシ子プロセスの初期ヘルスウェイトウィンドウ (ms)、ランチャーが `still starting up` をログに記録してウェイトを延長する前に (デフォルト `20000`)。プロキシの pre-bind オープンパスが長時間実行される場合は拡張してください: 大きな `index.db` は bind 前に完全な DB を開きます (整合性チェック、WAL 復旧 — #4939 を参照)、そして 1 つのストアを共有する 2 つのレーンが同時にコールドスタートすると SQLite 書き込みロックを競合します (Windows で 1.7 GiB ストアの場合、最初のログ行まで 28 秒以上、出力ゼロで 60 秒以上観察)。数値でない場合や非正の値はデフォルトにフォールバックします (#1365 と同じ `envMillis` 契約)。 |
| `BILI_SLOW_START_GRACE_MS` | まだ生存していて起動中の起動子プロセスの `BILI_SPAWN_WAIT_MS` を超えるスロースタート猶予 (ms) (#2187: AV / 初回実行ディスクアクティビティによる Windows 起動ウィンドウ 26-45 秒; 大きくまたは競合している共有ストアは、pre-bind 総時間を 60 秒以上押し上げる可能性があります)。起動総予算は 2 つのノブの合計です; 終了した子プロセスはそれでもフェイルファストします (デフォルト `40000`)。 |
| `BILI_PERSIST` | `0` に設定すると、セッション永続化を無効にします (メモリ内のみ、再起動で失われる)。 |
| `BILI_PERSIST_DEBOUNCE_MS` | ディスクへの永続化書き込みのデバウンスウィンドウ (ms) (デフォルト `500`)。 |
| `BILI_PERSIST_MAX_DELAY_MS` | 変更が到着し続ける間、保留中の永続化書き込みが待てる最大時間 (ms) — デバウンスウィンドウはすべての変更で再起動されるため、この予算が持続トラフィック下でファイルが着地することを保証します (デフォルト `5000`; 以前はセッション順序 / プレフィックスアフィニティライターでハードコード、#6058)。 |
| `BILI_PERSIST_TAIL_TOKENS` | 永続化された会話スナップショットのトークン予算 (#401)。ディスクレコードは、この予算内の最新のメッセージに切り詰められた**折り畳みビュー** (圧縮範囲の代わりにブロックサマリー) を保存します — 生の完全な履歴ではありません。デフォルトは `16384`; `0` でメッセージ永続化を完全に無効にします (ブロックサマリーと圧縮オリジナルはそれでも永続化; `bili export` はブロックのみレンダリングにフォールバック)。ライブメモリ内セッションには影響しません — ライブセッションの `bili export` は常に完全です。 |
| `BILI_PERSIST_ZSTD` | `1`/`true` に設定すると、セッションファイルの zstd 圧縮を有効にします (#1080、オーナー決定: **デフォルトオフ** — プレーン JSON は復元可能性を最大化します: jq/grep でデバッグ可能、ダウングレードテールリスクに免疫)。有効化されると、実際に縮小されるすべてのセッションファイルは `BILIZSTD1` として書き込まれます — JSON ボディの上に小さなヘッダー (マジック + 形式バージョン + モードバイト)、Node ≥ 22.15 では zstd 圧縮、古いランタイムでは生で保存; リーダーは両方のボディを受け入れます (ネイティブ zstd、それ以外はバンドルされた WASM フォールバック)、したがってファイルはランタイムとバージョン間で読み取り可能のままです。フレーミングで縮小できないペイロード (小さなセッション) とキーのない生ボディはディスク上でプレーン JSON のままです。`BILI_ENCRYPTION_KEY` と独立 — 両方がアクティブの場合、圧縮選択は `BILIENC1` 内のモードバイトに記録されます。既存のプレーン JSON ファイルは起動時に決して書き換えられません (ダウングレード安全性 — 大量の再エンコードは、古い bili にロールバックすると、その自身の書き込みを "破損" として読み取らせる); 次の保存で有機的に変換されます。注: セッションが `BILIZSTD1` として保存された後、古い bili (< 0.1.135) はそれを読み取れません — この注意はオプトインしたデプロイメントにのみ適用されます; 未設定または他の任意の値はプレーン JSON を保持します。 |
| `BILI_STORAGE_UNIFIED` | 階層型ストレージ移行スイッチ (#2671)。設定ファイルティア: `{"storage":{"unified":"legacy|shadow|full"}}` は同じモード (厳密なスペル) を選択し、環境変数が未設定の場合に常に適用されます; `BILI_STORAGE_UNIFIED` (`1`/`true` = shadow および `unified` = full も受け入れる) は常にファイルより優先されます。モードはレーン起動ごとに一度解決されます — ファイルへのホット編集は次の再起動で有効になります。`1`/`true` に設定すると、**統一 SQLite ストレージドライラン** (Phase 1) を有効にします。すべてのセッション書き込みは `<sessions-dir>/index.db` に二重取り込まれます (エンジン解決順序 #2833 以降: ランタイムが提供する場合は組み込み `node:sqlite` (Node >= 22.5) -> すでにインストールされたホスト `better-sqlite3` ネイティブモジュール -> 以前に自己ダウンロードされたキャッシュコピー -> npm レジストリからのピン留めされた `better-sqlite3` プリビルトタールボールの一度限りの自己ダウンロード (~11 MB、sha512 検証、`storage.sqliteAutoDownload` でゲート、サポートされていないプラットフォームは決してダウンロードしない; エンジン成果物は Node メジャーごとにピン留め (Node >= 22: better-sqlite3 v13; Node 20: v12.9.0 とその ABI キー付きプリビルド)、そしてピン留めされた成果物が提供しないランタイムはロード前に拒否され、ダウンロードもキャッシュコピーも登録されません。そのようなバインディングをロードするとプロセスがクラッシュするため (#3341, #3894)) -> なし、その場合サイドカーは #2825 ダウングレード契約に従ってレガシーのみのまま; エンジンの取得はホストのインストール時ビルドスクリプト承認に決して依存しない) かつ統一リプレイはレガシーロードビューとダイジェスト照合されます — 不一致は `[storage] unified shadow DIGEST DRIFT …` をログに記録し、決して書き込みパスをブロックまたは変更しません (レガシーファイルは真の単一ソースのまま)。`full`/`unified` に設定すると、**ドロップイン読み取りパス** (Phase 1.5) を有効にします: `loadSync`/`boot`/`loadAll`/`loadStateForSearch` は統一優先 — レガシーファイルセッションは最初のオープン時にインデックスに有機的にインポートされ (`[storage] unified import on first open: …`)、後のロードは `index.db` から提供され、統一失敗時にはレガシーファイルへの自動フォールバックがあります。レガシーファイルは二重書き込みされ続けるため、**ロールバック = ノブを未設定にする** (環境変数および/またはファイル値)。ハード暗号化オプトアウト: `BILI_ENCRYPTION_KEY` がアクティブの間、サイドカー全体は開くことを拒否します (index.db は平文インジェストペイロードを保持する; `unified sidecar DISABLED` 警告がログに記録され、ストアはレガシーのみのまま)。列挙/GC と Web セッションリストはファイルベースのままです; `removeLegacyFile` は現在インデックス行を削除し、CAS refcount を解放します。ダイジェストは最後の書き込み者 `biliVersion` スタンプと壁時計タイムスタンプを環境 (`__VER__`/`__TS__`) として扱い、他のすべてはバイト単位で一致する必要があります。インデックス書き込みパスは決して諦めません: 失敗したインジェストはログに記録されます (最初の失敗時にファイル + エラー詳細)、そしてすべての後続の保存は実際の書き込みを再試行します — 自己無効化なし、クールダウンなし、フォールバックモードなし (2026-10-30 オーナーポリシー)、その間 JSON エンベロープは読み取りを提供し続けます。**レプリカ/チェックポイント REST (Phase 2)**: 統一レーン (shadow または full) で、`POST /__bili/replicas {sessionId, label?, pinned?}` はセッションの永続化状態を 1 つのコンテンツアドレス付きチェックポイントブロブ + 行として凍結します (常駐セッションは最初にフラッシュされる)、`GET /__bili/replicas[?sessionId=]` はそれらをリストし、`GET /__bili/replicas/<cpId>` は詳細 + バイト長を返し、`POST /__bili/replicas/<cpId>/restore {sessionId?}` はチェックポイントを通常の二重書き込みパス (JSON + 統一インジェスト; `meta.restoredFrom`/`restoredCheckpoint` が出所を記録) を通って新しい第一級セッションとして具現化し、`DELETE /__bili/replicas/<cpId>` はそれを破棄します。ピン留めされたチェックポイントは CAS refcount を保持し、`deleteSession` GC を生き残ります (ポイント: 破壊的実験前に取られたコピーはそれより長く生きる); 明示的な DELETE はピン留めされたものでも削除します。ディスク期待: shadow/full は一意コンテンツバイトをほぼ倍にします (すべてのセッションは JSON ファイルと index.db 行を持ち、2 つのストア間で重複排除のないコンテンツ CAS を共有) かつ自動 VACUUM はありません — 移行実行中はセッションディレクトリのサイズを適切に設定してください。レガシーのみのレーンはノブヒントとともに 501 を返します。ルートは `__bili` の残りの部分と同様にループバックのみです。未設定の場合はデフォルトで `full` (#3818)。 |
| `BILI_PERSIST_EPERM_ALERT_THRESHOLD` | 一度限りの "このディレクトリをウイルス対策の除外に追加" アラートが発火する前に、1 つのセッションでの連続永続化書き込み失敗 (`EPERM`/`EBUSY`/`EACCES`) の N 回 (デフォルト `5`)。Windows のみ。[Windows: exclude the sessions dir](#windows-exclude-the-sessions-dir-from-antivirus-362) を参照。 |
| `BILI_PERSIST_EPERM_ALERT_REPEAT_MS` | 永続化 EPERM アラートの再アラートウィンドウ (ms)。`0` (デフォルト) = 一度アラートしてその後沈黙; `>0` = 失敗が続く間、最大でそのミリ秒ごとに再アラート。 |
| `BILI_TUNNEL_ALLOWED_HOSTS` | **リモートクライアント**の `/bili/<absolute-url>` トンネル受入 (#409): ループバック/プライベート宛先 (例: LAN リレーやマシンの自身の sglang) を非ループバッククライアントに対してアンロックするコンマ区切りの `host` または `host:port` エントリ。プロキシ自身とリンクローカル/メタデータアドレスは常に拒否されます; ローカル (ループバック) クライアントは常に通過します。 |
| `BILI_MAX_SESSIONS` | メモリ内で保持される最大セッション数 (デフォルト `256`; LRU 追い出し — ディスクが真のソース)。 |
| `BILI_ROLLOUT_SNAPSHOT_RENDER` | スナップショットレンダリング (#3756): `1` に設定すると、クライアント再送信バイトではなく、サーバー側の統一ストレージトランスクリプトから送信履歴プレフィックスをレンダリングします。セッションにライブ折り畳みブロックがあり、統一ストレージが読み取り可能な場合のみアクティブです; それ以外の場合はすべてのリクエストが変更なしでレガシーパスにフォールバックします。#3752/#3751 の ID 流動クラスを殺します: アンカーカバレッジはブロック seq + コンテンツシグネチャに従うため、コーデック/アイデンティティアップグレード、クライアントチェックポイント、ホストコンパクト化はもはや折り畳まれた履歴をドロップまたは重複させません。`BILI_ROLLOUT_<FEATURE>` の機能別形式 (デフォルト 0% ロールアウト)。 |
| `BILI_SESSION_WARM_MAX` | 有界起動 (#2803): リスニング前にブート時に水化される最近保存されたセッションの最大数 (デフォルト `0` = 水化なし、`sessions.max` で上限); 古い状態はオンデマンドで再読み込みされます。例: `8` に設定すると、最近のセットのイージアワーミングを復元します。ファイルの双子: `sessions.warmMax`。 |
| `BILI_SESSION_WARM_MAX_BYTES` | ブートウォームセットのデコードバイト予算 (#2803; デフォルト `67108864` = 64 MiB)。ディスク上の圧縮バイトではなく、DECODED サイズをカウントするため、zstd アーカイブは RAM 境界をすり抜けることができません。予算を超える単一ファイルは決してウォームされません。ファイルの双子: `sessions.warmMaxBytes`。 |
| `BILI_SESSION_RESIDENT_MAX_BYTES` | 推定常駐セッションバイトのソフトターゲット (#2803; デフォルト `4294967296` = 4 GiB、#5779 で 512 MiB から引き上げ)。アクティブ/進行中状態はそれより上にピン留めされます (バイト予算はアイドルキャッシュを制限し、アクティブワークロードを制限しない); ターゲット超過時、アイドル状態はリクエスト完了時にディスクへ排出されます。ファイルの双子: `sessions.residentMaxBytes`。 |
| `BILI_SESSION_RESIDENT_HARD_MAX_BYTES` | 推定常駐メモリに対するセッションごとのハード上限 (#4788、決定 #4792 D1-A)。なぜ存在するか: 上記のプールソフト上限は、予算内に留まるために他のアイドルセッションをメモリから引き出すことしかできません — 単一の長時間セッションでは追い出すものが何も残らないため、1 つの会話が 58 MiB の受信ストリームから約 2 GiB のワーキングセットを成長させました (#4788 ベースライン)。この上限は 1 つのセッションを単独で制限します: リクエストが完了し、ターンの保存がディスクに着地したことが証明された場合、セッション自身の常駐推定値 (`GET /__bili/memory` が報告する同じ数値) は上限と比較されます; 超過時、プール追い出しがセッションを免除しても、ドロップ可能なフィールド — 折り畳みブロックのオリジナルコンテンツ、メタデータ簿記、生メッセージテールの無制限部分 — はディスクに強制戻され、セッションごとに 1 分ごとに警告がログに記録されます。何も失われません: 各ドロップされたフィールドは、NARROW ディスク読み取り (そのフィールドのみ、レコード全体ではない) から初回使用時に再具現化されるため、次のターンはメガバイトを常駐させる代わりに 1 つの小さな読み取りを支払います。着地した保存によってゲートされたドロップは、上限に関係なくすべてのリクエスト境界で実行されます; 上限は単一のセッションが自身の予算を超えたときに呼び出されるかを決定します。デフォルト: プールソフト上限と等しい (`4294967296` = 4 GiB; #5779 で 512 MiB から引き上げ); 1 つの忙しい長時間セッションを個人の上限以下に保つには低く設定 (例: `53687091` = 64 MiB)。`0` で上限チェックを無効にします。圧縮状態 (`state`) とメディアコンテンツストアは設計上ドロップ可能ではなく、このパスでは触れられません。ファイルの双子: `sessions.hardMaxBytes`。 |
| `BILI_PUBLIC_SNAPSHOT_CAP_BYTES` | パブリックフォーク API を提供するためにプラグインセッションごとに保持される生ワイヤ履歴スナップショットの保持上限 (バイト) (#2017)。シリアライズされたスナップショットが上限を超えるプラグインセッションはフォーク可能ではなくなります — `GET /__bili/plugin/snapshot` と `POST /__bili/plugin/fork` は上限理由とともに `409` でフェイルクローズします — 履歴の無制限な生コピーを永遠に保持する代わりに。上限はすべてのプラグインモデルリクエストで再評価されます: 上限以下に縮小されたセッション (フォークがトリムした後、またはホストが履歴を縮小した後) はフォーク可能になります。デフォルトは `104857600` (100 MiB); `0` で保持を完全に無効にします (セッションはフォーク可能ではなく、既存のスナップショットは次のリクエストで破棄されます)。ファイルの双子: `plugin.snapshotCapBytes`。 |
| `BILI_SESSIONS_DIR` | 永続化セッション状態のディレクトリ (デフォルト XDG data ディレクトリ)。 |
| `BILI_SESSION_GC` | 古いセッションファイルのクリーンアップ (#1082) は**オプトイン**です: 有効にするには `1`/`true`/`on` に設定します — デフォルトはオフです。セッションファイルはユーザーデータ (エクスポート可能、再開可能) であり、サイレント削除ポリシーがないためです。有効化されると、スウィープ (ブート + 毎時) は、両方の条件が成立する場合のみファイルを削除します: `BILI_SESSION_GC_MAX_AGE_DAYS` より古く、かつ無損失の意味で小さい — セッションは**決して圧縮されていない** (折り畳みブロックゼロ) かつ最新のリクエストボディが以下のトークン上限以下であり、再開するとクライアント自身の履歴からの 1 回のコールドリビルドのコストしかかからないためです。セーフティレール: 圧縮されたセッションは決して削除されません (そのサマリーは無損失で再構築できない); メモリ内でまだ保持されているセッションは、最後のディスク書き込み以来アイドルでない限りスキップされます; 読み取り不能/破損ファイルはその場に置かれます; すべての削除は個別に監査ログに記録されます (パス、サイズ、年齢) 加えて、空でないスウィープごとに 1 行のサマリー行; 触れるのはセッションディレクトリのみ; 空になったプロトコルサブディレクトリは削除されます。常駐ガードはプロセスごとであることに注意してください: `BILI_SESSIONS_DIR` を共有するが永続化しない (例: `BILI_PERSIST=0`) 他のプロキシインスタンスはファイル mtime を更新しないため、まだライブなセッションファイルは年齢を重ねてスウィープされる可能性があります — コストは同じ有界コールドリビルドであり、年齢ゲートでバックストップされています。CCR コンテンツストア (#1097) はセッションのライフサイクルを共有します (#1180): `<hash>.content-store.json` コンパニオンはセッションファイルとともに削除され、孤立したコンパニオン (セッションファイルはすでに消えた) は年齢ゲートを過ぎると一度スウィープされ、読み取り不能なコンパニオンはセッションファイルも保持します (決して推測しない)。 |
| `BILI_SESSION_GC_MAX_AGE_DAYS` | セッションファイルが GC 候補になるまでの最小年齢 (日) (デフォルト `7`)。あらゆる可能性のあるリサマウィンドウよりはるかに長く保ってください: 削除後、再開されたセッションは m00001 からメッセージ番号付けを再開しますが、再開エージェントのトランスクリプトは古い番号をまだ引用している可能性があります (カーネル契約: ID は決して再利用されない)。 |
| `BILI_SESSION_GC_MAX_TOKENS` | GC 適格性のサイズ上限 (トークン) (デフォルト `1000000` = 1M、#1082 でオーナー設定)。**デコードされた**コンテキストに対して判定され、決してファイルバイトではありません (暗号化/zstd ファイルはディスク上ではるかに小さい): 最新のリクエストボディのトークン推定値 (`rawInputTokens`、ターンごとに記録) が存在する場合に優先されます; 記録されていないレガシーファイルは `stats.contextTokens` を使用します; そしてコンパニオンコンテンツストアのフットプリント (#1097: カーネルの CJK 対応 `defaultCountTokens` による一意コンテンツ、`rawInputTokens` と同じ推定器、#1180) が上に追加されるため、巨大なストアを持つ小さなセッションは上限をすり抜けることができません。圧縮されたことのないセッションにのみ適用されます — 折り畳みブロックを持つファイルは、そのサマリーが再送信から無損失で再構築できないため、サイズに関係なく常に保持されます。 |
| `BILI_SESSION_GC_INTERVAL_MS` | バックグラウンド GC スウィープの間隔 (ms) (デフォルト `3600000` = 1 時間)。スウィープはブート時に一度実行されます。 |
| `BILI_ENCRYPTION_KEY` | 信頼できないノード上のデプロイメントのためにセッションファイルを静止状態で暗号化します (#708)。正確に 32 バイト、hex (64 文字) または base64; 未設定 = 暗号化されないプレーン JSON ファイル (または `BILI_PERSIST_ZSTD=1` 時の `BILIZSTD1` — `BILI_PERSIST_ZSTD` を参照)。設定された場合: すべてのセッションファイルは `BILIENC1` AES-256-GCM として JSON 上に書き込まれ、`BILI_PERSIST_ZSTD=1` の場合のみ zstd 圧縮されます (Node ≥ 22.15 では zstd、それ以外は生ボディ) — 圧縮を有効にするとファイルも約 5–10 倍縮小します。暗号化と圧縮は現在独立したノブです (#1080)。キーはこの環境変数のみから来ます — ディスクやログに決して書き込まれません — したがって、同じファイルシステムの到達範囲外に保ってください。無効な値は起動を中断します (フェイルファスト、決してサイレントに暗号化されない)。誤ったキーでブートすると、影響を受けたセッションは破損としてスキップされます (ログに記録、クラッシュなし)。キーを失うと、暗号化されたセッションは永久に読み取り不能になります。設計上対称です (同じプロセスが暗号化と復号化を行う)。既存のエンコードされていないファイルは起動時に決して書き換えられません — 次の保存で有機的に暗号化されます (ダウングレード安全性; `BILI_PERSIST_ZSTD` を参照)。脅威モデル (#708、オーナー確認済み): それは**オフライン/機械的**ファイル取得から防御します — プロバイダーディスク交換、ノードイメージドリフト後のオフラインディスクスナップショット、盗まれたボリューム、漏洩バックアップ、クラウド同期状態ディレクトリ — オフラインの第三者がキーなしにコンテンツを読み取れない場所です。ライブアクセスを持つ標的型敵対者からは防御しません; そのティアでは、プロキシ内で解決するのではなく、信頼ルートをプロキシの外 (KMS / TEE / 機密 VM、強化された権限) に移動してください — そのレベルではキーよりもはるかに多くのものが露出するため、プロキシレベルのキー処理は保持すべき境界ではありません (`BILI_PERSIST=0` は永続化を完全に無効にします)。同じプロセス/環境からの第二のキーでキーを二重暗号化しても何も得られません: すべてのオフライン盗難シナリオで、攻撃者は正確に 1 つの成果物 — あなたのディスク外シークレット — を欠いています — それがデータキーと呼ばれようがラッピングキーと呼ばれようが; 異なる信頼ドメイン (KMS/TPM/TEE) のラッピングキーのみがバーを上げ、それは上記のシナリオ 2 です。 |
| `BILLION_CONTEXT_PROXY` | ランチャーによってエクスポートされます; クライアント側の bili プラグイン/拡張はそれを検出し、自身の圧縮を自己無効にします (二重圧縮なし)。 |
| `PI_PROXY_ANTHROPIC` | `bili omp` ランチャーによってエクスポートされます (ユーザーの環境から `PI_PROXY` も `PI_PROXY_ANTHROPIC` も来ない場合のみ): OMP の Cowork anthropic トランスポートをプロキシに向かせ、それらのリクエストが node:https 直接ではなく圧縮可能レーンに乗るようにします (#2583/#3556)。ユーザー設定の値は常に優先されます。 |
| `BILLION_CONTEXT_PLUGIN` | `0` に設定すると、プラグインモードを完全に無効にします (ワイヤレベルのツール注入が再開)。 |
| `BILI_LAUNCHER_MODEL_WINDOWS` | 内部: ランチャーはクライアント自身のモデルごとのコンテキストウィンドウ (pi `models.json`、omp `models.yml`、opencode `models.<id>.limit`、codex `model_context_window`) を JSON として起動されたプロキシに渡し、セルフホストモデルに対してナッジの分母が実際のウィンドウと一致するようにします。ランチャーのみが設定します — ユーザー設定はありません。 |
| `BILI_LAUNCHER_LANE` | 内部: ランチャーはクライアントのレーン名 (pi / codex / claude / …) を起動されたプロキシに渡し、インスタンスファイルに記録します (#1225)。再利用はアイデンティティベースです: *異なる宣言された* レーンを持つ 2 つのインスタンスは決して互いにアタッチしません; 宣言されたレーンを持たないインスタンスは手動で開始されたユーザーゾーンデーモンです — デフォルトでアタッチ可能 (#1660)。ランチャーのみが設定します — ユーザー設定はありません。 |
| `BILI_LAUNCHER_PLUGIN` | `0` に設定すると、claude/codex に対するランチャーの bili MCP サーバー注入を無効にします (純粋なワイヤモード); `1` でプラグインモードを強制します。デフォルト: 注入 — ただしローカル/プライベートアップストリーム (sglang/vllm/ollama は codex の名前空間ツールタイプを解析できないため、bili はそこで自動的にワイヤツールにフォールバック) を持つ codex を除く。[Launcher Reference](#launcher-reference) を参照。 |
| `BILI_LAUNCHER_DIRECT` | `1` に設定すると、ランチャーでの直接 URL ルーティング (MITM/CA 信頼をドロップ) を行います。[Launcher Reference](#launcher-reference) を参照。 |
| `BILI_NATIVE_ATTACH_EXTERNAL` | アタッチゲートエスケープハッチ (#1335)。レーン付きネイティブフックは、アームされたセッションライフサイクルウォッチドッグ (`/__bili/health` で `watchdog.armed == true`) を報告する実行中プロキシにのみアタッチします — アームされていない*レーン付き*プロキシ (クラッシュしたセッションの孤立、またはライフサイクル状態を検証できないインスタンス) は、サイレントに乗る代わりに明確に拒否されます。#1660: **手動で開始された `bili start` デーモン** (レーンなし、起動トークンなし) は定義上ユーザーゾーンです — **アームされた**ユーザーゾーンデーモン (管理された共有プロキシ、#1225) はそれでも互換性のあるクライアントレーンによって乗られますが、**アームされていない**手動デーモンは、デフォルト (`attachPolicy: "own-lane"`, #2877) では、LANEd フックによって乗られず、代わりに自身のものを起動します; #2877 以前のネイティブフックが手動デーモンにデフォルトでアタッチする動作を復元するには `attachPolicy: "global-fallback"` を設定してください。`1`/`true` に設定すると、ウォッチドッグ状態に関係なく、*レーン付き*アームされていないリスナーにもアタッチします (コード/レーン互換のリスナーはすべてアタッチ可能になります。`watchdog` フィールドをまったく報告しない #1330 以前のビルドを含む)。設定ファイルの `"native": { "attachExternal": true }` は同じことをします; 環境変数はファイル値より優先されます。注: `attachExternal` は**レーン付き**デーモンの*ライフサイクルゲート*のみを管理します — ユーザーゾーン (手動) デーモンへのアタッチを開いたり閉じたりしません; その軸は `attachPolicy` / `attachUrl` です。デフォルトは閉じています (レーン付きインスタンスのために)。完全なメカニズム (再利用ルール、リスナートーブル、エスケープハッチ): [technical-notes.md](technical-notes.md#proxy-reuse-and-the-attach-gate-1225-1335-1232-1660)。 |
| `BILI_ZCODE_ROUTE` | zcode ネイティブプラグインルーティングスコープ (#1622): `all` (デフォルト — 使用可能な http(s) baseURL を持つすべてのプロバイダーエントリが圧縮に乗る、pi/dsh パリティ)、`plans` (#1622 以前の bigmodel コーディングプランホワイトリスト)、`none` (オプトアウト; ブートストラップはストアを直接のままにします)。互換性エスケープハッチ — ファイル同等物は**ありません**; ルーティングはデフォルトでオンです。 |
| `BILI_ZONE_PORT` | 自己管理ポートゾーンのベース (#1660、デフォルト `18787`): すべての*レーン起動*プロキシ (claude/zcode ネイティブフック、ポート 0 を乗るランチャーレーン) はまずレーンのスティッキーレコードを試み、それがない場合はこのベースを試みます; ポート競合は子の +1 階段によって解決されます — ただし保持者が異なるビルドを実行している同じレーンの先行者 (アップグレード再起動オーバーラップ) の場合を除き、子はそれを待機 (最大 5 秒) し、ドリフトする代わりに同じポートを再バインドします (#1723) — そして決定されたポートは `<state>/port-zone.json` 下にスティッキーとして記録され、後の起動が自動的にドリフトに従います。手動 `bili start` は独自のデフォルト (`8787`) を保持します — ユーザーゾーンはレーンによって決して触れられません。 |
| `BILI_ZCODE_PORT` | zcode ネイティブレーンのプロキシのために**正確な**ポートをピン留めします (#1660): 起動は厳密ポートになります — スクワッターはホッピングする代わりに明確に拒否されます — そして共有ストアに書き込まれたラッパーはハンドオフなしでもセッション再起動を生き残ります。それがない場合、レーンは自己管理ゾーン (`BILI_ZONE_PORT` ベース + スティッキードリフトフォロー) を乗ります。 |
| `BILI_ZCODE_SIGNING_FIXED` | `1`/`true` = ZCode ビルドが ClientRequestSigningV4 を固定したと仮定します (#1621): v3.14+ パーソナルストアでのコーディングプランアカウントのエントリごとのスキップがオフに切り替わり、再びルーティングされます。一時的なエスケープハッチ — ファイル同等物は**ありません**。 |
| `BILI_CLAUDE_UPSTREAM` | claude 直接モード: `ANTHROPIC_BASE_URL` がすでにランチャーがバイパスするリレーを指している場合のリレーエンドポイント。 |
| `BILI_CLAUDE_NATIVE_PORT` | claude ネイティブレーンのフック起動プロキシのために**正確な**ポートをピン留めします (#964/#1660): 厳密ポートセマンティクス — ポート上のスクワッターはホッピングする代わりに明確に拒否されます — そして焼き込まれた管理 `ANTHROPIC_BASE_URL` はそれを指します。それがない場合、フックは自己管理ゾーン (`BILI_ZONE_PORT` ベース + レーンごとのスティッキー) を乗り、セッションごとに管理 URL をライブオリジンに再ピン留めするため、ポートドリフトは自己修復します (#1660)。 |
| `BILI_CODEX_COMPACT` | Codex ネイティブコンパクト化処理。デフォルト `intercept`: bili は codex のコンパクト化リクエストをインターセプトし、セーフティゲートがパスした場合 (transform ok + 定常状態使用量 < ウィンドウの 90% + アクティブな圧縮ブロック少なくとも 1 つ) ACP 状態へのローカルハンドオフを偽造します — トリガー形式は 2 フレーム SSE を偽造し、エンドポイント形式は `{output}` を偽造 — そして決して上流に連絡しません。スコープ (#3008): 明示的な形式 (compaction_trigger + /responses/compact) と、SUMMARIZATION_PROMPT テンプレートによって検出される通常のターンとして通過するインラインオートコンパクト化をカバーします — ユーザーオーバーライドされた compact_prompt は検出から落ち、逐語通り通過します; bili が観察したのみ (pass/gate) のコンパクト化は事後にリベースされます (#2372)。偽造された ACP サマリーは履歴運搬ハンドオフメッセージ (developer-message フォールバック) として再注入され、codex が履歴を切り詰めた後も圧縮コンテンツが可視のままになります。`pass` に設定するとオプトアウトし、codex のコンパクト化リクエストを上流に転送します (ネイティブコンパクト化バックストップ)。ゲート失敗時には、リクエストは変更なしで通過します。Codex クライアント検出 (これが適用されるトラフィック、ウィンドウクランプとセッションアイデンティティフィンガープリンティングにも使用): User-Agent は登録されたプレフィックス (`codex_cli_rs/`, `codex_exec/`, `codex desktop/` — 大文字小文字を区別せず一致、Codex Desktop のようなバリアントが最初の文字を大文字で送信するため #1169) で始まるか、小文字 `codex` で始まる空白区切りコンポーネントを含む必要があります (未知のバリアント、例: `codex_sdk_ts/…`、#645 — #1641 で素の部分文字列からトークンレベルプレフィックスに狭められ、トークン中や括弧内で "codex" を単に言及する非 codex クライアントはもはや誤分類されません; フォールバックは意図的に大文字小文字を区別するため、"Codex" 形状のリレーは除外されます、#1106)。 |
| `BILI_CODEX_STATE_MODE` | codex 状態処理 (#2222, #3203)。デフォルト `auto`: codex バイナリが `CODEX_SQLITE_HOME` を尊重する場合 (codex-cli ≥ 0.147.0、キャッシュされた `--version` 呼び出しでプローブ)、bili はそれを REAL `$CODEX_HOME` に向けます — codex は WAL モード状態 db を REAL ホームの単一の物理パスに保持し、bili とネイティブ実行の間でライブ共有します。各起動は有界プール (`<CODEX_HOME>-bili-s1..s16`) から独自のセッション別オーバーレイスロットを取得します: 生成ファイル (.env, config.toml) とプロキシバインディングはスロットごとであるため、1 つの `$CODEX_HOME` で最大 16 つの独立したセッションが並行して実行され、それぞれが独自のレーン (`codex-s<N>` — 同じビルドの 2 つの起動が 1 つのレーンを共有するとポート層で互いを拒否する、#3044) で実行される独自のプロキシを介してルーティングされます。スロットは永続化され再利用されます — コールドスタートスレッドレコードがそれらを通じて解決されるため、決して自動削除されません (#43bf59fc9) — したがって、クラッシュしたセッションのスロットは次の起動によって単に回収されます。起動ごとの db コピーがないため、終了時のマージバックも `.bili-conflict` 世代もありません (#381/#1917/#1918/#1919/#1951/#1965/#2195 パッチファミリーはこのモードで退役)。#3203 以前の固定名 `<CODEX_HOME>-bili` オーバーレイは、同じ出所裁定の下で、最初の共有モード起動時に REAL ホームに一度だけ移行されます; ライブなレガシー時代の起動がそれを保持している間は、起動は拒否されます。`shared` はこのモードを強制します (バイナリが古すぎる場合はレガシーに明確にダウングレード); `legacy` は単一の排他オーバーレイ (一度に 1 つの起動) を持つ古い起動ごとのコピー / マージバックメカニズムを強制します。環境変数のみのエスケープハッチ — ファイル同等物は**ありません**。ユーザー設定の `CODEX_SQLITE_HOME` はそのまま尊重されます (ネイティブと bili の実行は 1 つの論理 db を共有する必要がある); 管理 requirements.toml `sqlite_home` は両方より優先されます。 |
## 上流障害の診断（プロキシ経由の上流）

すべての上流トランスポート障害は、ログ行の先頭（およびクライアント/ステータスが参照する `error:` 文字列）に付与される `kind=` に分類され、それぞれに修復ヒント（`hint=...`）が添えられている。分類体系（#1263）:

| kind | 意味 | bili の挙動 |
|------|---------|---------------|
| `client-abort` | 下流クライアントが切断した | なし（定義上、リクエストは既に死んでいる） |
| `upstream-timeout` | アイドル予算の期限切れ（ヘッダー/ボディ）またはリクエストウォッチドッグによる中断 | **リトライされない** — 待機予算を積み重ねない |
| `connect-timeout` | TCP ハンドシェイクが完了しなかった（エンドポイントに到達不能/ブラックホール化） | 透明なリプレイ、`BILI_REPLAY_RETRY_MAX` で上限設定 |
| `proxy-reset` | **プロキシ経由**でレスポンス前に接続が切断された（主な疑い先: プロキシのアイドルリサイクル / ペイロード上限 / ノード変動） | 透明なリプレイ、`BILI_REPLAY_RETRY_MAX` で上限設定（デフォルトは合計 3 回の試行） |
| `upstream-reset` | 同上、直接接続の場合（上流/ローカルネットワークを疑う） | 同上（`BILI_REPLAY_RETRY_MAX` で上限設定） |
| `connect-refused` | TCP が拒否された（設定されている場合はプロキシ、それ以外は上流） | 同上（`BILI_REPLAY_RETRY_MAX` で上限設定） |
| `upstream-unreachable` | ホストへのルートがない（ICMP `EHOSTUNREACH` / `ENETUNREACH` / `EHOSTDOWN`）— ルーティング / ACL / ファイアウォールの `REJECT`; macOS ではローカルネットワークのプライバシー拒否も含む（#5663） | 同上（`BILI_REPLAY_RETRY_MAX` で上限設定） |
| `dns` | 名前解決に失敗（DNS サーバー / ホスト名のタイプミス） | 透明なリプレイ、`BILI_REPLAY_RETRY_MAX` で上限設定 |
| `tls` / `unknown` | TLS/ハンドシェイク失敗（CA/MITM）/ 分類不能なトランスポート障害 | リトライされない |

ハンドシェイククラスのレジリエンスは、プロキシ経由の接続に対するキープアライブ上限（`BILI_PROXY_KEEPALIVE_MAX_MS`、デフォルト 55 秒）と組み合わされ、bili はまもなくリサイクルされるプロキシのソケットを提供することを停止する。

長時間セッションで周期的な接続障害が発生した場合の**4 ステップのチェックリスト**（#1249 より）:
1. `bili.log` を `kind=` で grep する — `proxy-reset` のクラスタは外部プロキシを指し示し、`upstream-timeout` は上流の健全性を指し示す。
2. 失敗したリクエストのタイムスタンプを、外部プロキシ自身のアクセスログ（同じホストクロック）と照合する — 同じミリ秒にリサイクルエントリがあれば、原因が確定する。
3. どのホップかを特定する: 同じ行内の `proxy=<url>` と `proxy=direct` を確認し、転送されたリクエストの `content-length` をプロキシの文書化されたペイロード上限と比較する。
4. プロキシがリサイクラーである場合、そのアイドルタイムアウトを引き上げるか、bili の 55 秒再利用上限 + 1 回リプレイのセーフティネットに吸収させる。

**ホスト側のリトライ階層化（#2568 の項目 4）。** プラグインホストが bili の背後で実行されている場合（例: `bili pi`）、レスポンス前のトランスポート障害は、互いのカウンターを見ることができない 2 つの独立したレイヤーによってリトライされうる:

1. bili→上流レグにおける、上記の bili トランスポートリプレイ（`BILI_REPLAY_RETRY_MAX` 試行以内、`BILI_REPLAY_RETRY_BASE_MS`×2ⁿ バックオフ）;
2. ホスト→bili レグにおける、ホスト自身のターンレベルのリトライ予算（pi: `retry.maxRetries`、デフォルト 3、ベース遅延 2 秒の指数バックオフ; 表面化されたエラーテキストが一時的パターンテーブルに一致した場合に発火）。

これらのレイヤーは、一方が他方に譲るのではなく、接続クラスの障害に対して意図的に重複している: bili の高速なローカルリプレイは、ホストがターンパイプライン全体を再実行する前にミリ秒単位のブリップを吸収し、ホストレイヤーは `BILI_REPLAY_RETRY_MAX=1`（フェイルファスト）の場合でもターンを保護する。完全に死んだ上流に対する結果: ユーザーに見える 1 ターンあたりの最悪ケース = (ホスト試行数) × (bili 試行数) の接続 — デフォルトでは 4 × 3 = **12**、エラーが表面化する前に約 30–35 秒のネストバックオフが発生する。両方の予算は有限の固定カウントであるため、最悪ケースは有界に保たれる。

デバッグ中に 2 つのログを相関させる場合: 各 bili トランスポートリプレイは `[<session>] [acp-proxy] upstream <kind> (pre-response network failure): <error>; retrying in <ms>ms (attempt n/m)` をログに記録する（warn レベル、`bili.log`）; pi はターンリトライごとに `auto_retry_start` / `auto_retry_end` イベントを発行する（インタラクティブ TUI のステータス行）。セッション ID + タイムスタンプウィンドウでそれらを一致させること — レイヤー間の共有相関 ID は存在しない。
## CLI リファレンス

完全なコマンド一覧（`bili --help` は省略版を表示する）。すべての優先順位: **CLI フラグ > 環境変数 > 設定ファイル > ビルトインのデフォルト**。

| コマンド | 機能 |
|---|---|
| `bili [start] [options]` | プロキシを起動する（デフォルトでは XDG 設定ファイルを読み込む） |
| `bili pi [opts --] [args]` | プロキシを起動し、それに対して **pi** を起動する |
| `bili pi-test [opts --] [args]` | `bili pi` と同じだが、`--no-extensions` を追加する（クリーンルームテスト — プロキシが圧縮を管理する） |
| `bili codex [opts --] [args]` | プロキシ + **codex** |
| `bili claude [opts --] [args]` | プロキシ + **claude** (Claude Code CLI) |
| `bili omp [opts --] [args]` | プロキシ + **omp** (pi ベース) — opencode zen モデルはデフォルトの `opencode.ai` MITM ホワイトリストに乗る (#1405) |
| `bili opencode [opts --] [args]` | プロキシ + **opencode** — ビルトインの zen ゲートウェイ (`opencode.ai`) はデフォルトで cert-MITM される (#1405); `~/.config/opencode/opencode.json` / `~/.omp/omp.json` の `providers[].baseURL` に宣言されたホストは自動的に MITM ホワイトリストに参加する (#1411), また `~/.aider.conf.yml` / `~/.config/opencode/.aider.conf.yml` も同様の目的で監視される |
| `bili hermes [opts --] [args]` | プロキシ + **hermes-agent** (`/bili/` リライト) |
| `bili dsh [opts --] [args]` | プロキシ + **deepseek-harness** (ループバック以外のアップストリームはプロキシ環境変数経由、ループバックは `/bili/` リライト経由 — #535; `--profile web "task"` のような引数はそのままパススルーされる) |
| `bili codebuddy [opts --] [args]` | プロキシ + **codebuddy** (Tencent CodeBuddy Code CLI) — `CODEBUDDY_BASE_URL` の `/bili/` リライト、OpenAI chat-completions ワイヤプロトコル; バジェットは `CODEBUDDY_AUTO_COMPACT_WINDOW` で制御 (#640) |
| `bili qoder [opts --] [args]` | プロキシ + **qoder CLI** (`qoder`/`qodercli`) — `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` による cert-MITM; モデルエンドポイントは https がハードコードされているため `/bili/` リライトは不要（デフォルトのホストマップがホワイトリスト化済み）(#653)。Qoder **Desktop** は別個の BYOK/カスタムチャネルであり、`/bili/` プレフィックス付きのプレーンテキスト OpenAI を話す — bili を通常のカスタムプロバイダーとして指定する（この MITM レーンではない）; 公式サブスクリプションのトラフィックは暗号化されており、対象外 (#764) |
| `bili trae [opts --] [args]` | プロキシ + **Trae CLI** (ByteDance、クローズドソースの Go バイナリ) — `HTTPS_PROXY` + `SSL_CERT_FILE` による cert-MITM; モデルホストは `TRAE_CLI_API_HOST` またはデフォルトのエントレプライズゲートウェイから取得 (#655) |
| `bili jcode [opts --] [args]` | プロキシ + **jcode** (Rust 製エージェントハーネス) — `HTTPS_PROXY` + `SSL_CERT_FILE` による環境変数専用の cert-MITM 起動; ホスティングモデルホスト (`api.z.ai`) はホワイトリスト化、ローカルループバックプロバイダーは `NO_PROXY` 経由で直接接続のまま |
| `bili kimi [opts --] [args]` | プロキシ + **Kimi Code** (Moonshot CLI) — `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` による cert-MITM; プロバイダー/モデルホストは `~/.kimi-code/config.toml` (`KIMI_CODE_HOME` を尊重) または宣言がない場合の管理 OAuth エンドポイントから取得; ループバックエンドポイントは手動 `/bili/` プレフィックスのヒント付きでインベントリ化される (#757) |
| `bili test pi` | pi パスの非汚染エンドツーエンドスモークテスト |
| `bili export [session] [--full] [--jsonl] [--output FILE]` | 永続化されたセッションの一覧表示 / 1 つを Markdown ハンドオフとしてエクスポート（または `--jsonl`: 存在する場合統一インデックスからレンダリングされた行区切り JSON ダンプ、それ以外はレガシーレコード — 生成された相互運用成果物であり、真実のソースではない）— [Sessions & Migration](#sessions--migration) を参照 |
| `bili acp-cache diff <dump-dir> [--json] [--log FILE] [--no-log] [--session SID]` | `ACP_DUMP_BODY` ダンプからのキャッシュミス要因を特定 — セッションごとに隣接リクエストのプレフィックス差分を計算 (#1266) |
| `bili update` | 今すぐ新しいバージョンを確認してインストール（3 分間のスロットルをバイパス） |
| `bili plugin install <agent>` | ネイティブツールプラグイン / MCP ブリッジをホストにインストール — [Plugin Mode](#plugin-mode-native-tools) を参照 |
| `bili plugin remove <agent>` | 再度削除する |
| `bili plugin list` | すべてのホストのインストール状態を表示 |
| `bili mcp` | bili MCP サーバーを stdio で単独実行 |
| `bili plugin-register <id> [--origin URL] [--agent name]` | 会話 ID をプラグインモードに事前バインド（高度な機能） |
| `bili --version` / `bili --help` | バージョン / ヘルプを表示 |

ランチャーコマンドの `--` の後のものは、クライアントにそのままパススルーされる（`bili pi -- print "hi"`）。

### オプション

| フラグ | 効果 |
|---|---|
| `--port <N>` | リスニングポート（デフォルト `8787`） |
| `--host <ADDR>` | リスニングホスト（デフォルト `127.0.0.1`） |
| `--config <FILE>` | 設定 JSON のパス（デフォルト: XDG 場所） |
| `--debug` | 詳細ログ出力 |
| `--passthrough` | 圧縮なしで転送 |
| `--no-passthrough` | 圧縮を強制オン（設定を上書き） |
| `--no-auto-update` | この実行でのバックグラウンド自己更新を無効化 |
| `--mitm-domain <domain>` | 追加の MITM ホワイトリストエントリ（繰り返し指定可能; ランチャーのみ） |

---

## クライアント統合

ランチャーを使わずにクライアントをプロキシに向ける 2 つの方法: **`/bili/` プレフィックス**（API キー使用クライアント）と **MITM トランスパレントモード**（エンドポイントがハードコードされたログイン使用クライアント）。

### `/bili/` プレフィックス (API キー使用クライアント)

**API キー**（ログインではなく）で設定するクライアントでは、アップストリーム URL を変更できる。プロキシオリジン + `/bili/` を先頭に付けるだけでよい — これが唯一の変更点である。API キーはクライアント設定に残り、そのままパススルーされる。

**OpenCode** — `~/.config/opencode/opencode.json` を編集し、プロバイダーの `baseURL` を変更する:

```jsonc
// before:
"baseURL": "https://open.bigmodel.cn/api/coding/paas/v4"
// after (prepend the proxy origin + /bili/):
"baseURL": "http://localhost:8787/bili/https://open.bigmodel.cn/api/coding/paas/v4"
```

**OpenCode に関する注記.** これは OpenCode の**プラグインなし**パスである。そのような設定に対してネイティブプラグインもインストールされている場合、ランタイムはセッションごとに 1 回、修正ガイド（プレフィックスの削除またはプラグインの削除）付きで警告を発する; リクエスト自体はプレーンプロキシパスを維持する。相互に排他的な 3 つの OpenCode アクセスパスは [clients.md](clients.md#opencode) に文書化されている。

**その他のクライアント.** 同じ 1 行プレフィックスは、モデルベース URL を編集できる任意のクライアント（Cline / Roo Code / Kilo Code, Continue, OpenHands, Zed, Void, Cursor の単一モデルオーバーライド、…）で動作する — 検証済みのエントリポイントは [clients.md → Adopting unlisted clients](clients.md#adopting-unlisted-clients-any-client-with-a-configurable-model-base-url-2340) にリストされている。
**Codex (API キー)** — `~/.codex/config.toml` を編集し、プロバイダーの `base_url` を変更する:

```toml
# before:
base_url = "https://api.openai.com/v1"
# after:
base_url = "http://localhost:8787/bili/https://api.openai.com/v1"
```

**Codex (ChatGPT ログイン)** — トップレベルの `openai_base_url` フィールドを設定する（`model_provider = "openai"` と OAuth ログインを維持）:

```toml
# ~/.codex/config.toml (top-level field, not a section)
model_provider = "openai"
openai_base_url = "http://localhost:8787/bili/https://chatgpt.com/backend-api/codex"
```

通常通り `codex login` を実行する; OAuth トークンは `Authorization` ヘッダーに含まれ、プロキシはそれをそのまま転送する。

**Pi** — `~/.pi/agent/models.json` を編集し、プロバイダーの `baseUrl` を変更する:

```jsonc
// before:
"baseUrl": "https://api.anthropic.com"
// after:
"baseUrl": "http://localhost:8787/bili/https://api.anthropic.com"
```

**Claude Code** — `ANTHROPIC_BASE_URL` 環境変数を `/bili/` URL に設定する。（`/bili/` 形式は手動オプションである: 古い claude ビルドはプロキシ環境変数を完全に無視していたが、新しいビルド（例: 2.1.301）は `HTTPS_PROXY` を尊重する — 環境がループバックトラフィックをプロキシ経由でルーティングする場合、この URL が直接接続されるよう `NO_PROXY` にループバックホストを含めること (#3446).）

```bash
export ANTHROPIC_BASE_URL="http://localhost:8787/bili/https://api.anthropic.com"
```

**Vertex AI 上の Claude Code** (`CLAUDE_CODE_USE_VERTEX=1`) — Vertex 下ではプレーンキーは無効である: Claude Code は `ANTHROPIC_BASE_URL` を無視し、`<ANTHROPIC_VERTEX_BASE_URL>/projects/<p>/locations/<loc>/publishers/anthropic/models/<id>:rawPredict|streamRawPredict` をダイヤルし、そのパスをベース URL に**そのまま**（末尾のパスも含めて）追加する。代わりに `ANTHROPIC_VERTEX_BASE_URL` をルーティングする:

```bash
export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_PROJECT_ID=<gcp-project>
export CLOUD_ML_REGION=global
export ANTHROPIC_VERTEX_BASE_URL="http://localhost:8787/bili/anthropic/https://aiplatform.googleapis.com/v1"
```

この URL が正しくなければならない 3 つのポイント（各々が欠けるとサイレントに 404 になる）:

- **`/v1` はベース URL に含まれる。** クライアント自身のパスは `/projects/…` から始まる; Vertex は `/v1/projects/…:rawPredict` を提供し、バージョンなしの形式は 404 になる。
- **`anthropic` セグメントは必須である。** `/bili/<url>` だけでは、プロキシはパスサフィックスで分類し、`:rawPredict` は既知のサフィックスにマッチしない — 明示的なプロトコルマーカーが anthropic レーンを選択する。
- **ホストと `locations/<loc>` は一致しなければならず**、ホストはリージョンに従う: `global` → `https://aiplatform.googleapis.com`, `us`/`eu` → `https://aiplatform.<loc>.rep.googleapis.com`, その他のリージョン → `https://<loc>-aiplatform.googleapis.com`。

このレーンでは認証は変更されない: Claude Code は独自の ADC アクセストークンを発行し、bili はそれのために認証を発行しない。`bili claude` は上記すべてを自動的に実行する — `ANTHROPIC_VERTEX_BASE_URL` を同じルーティング形式に設定し、プレーンキーはそのまま残す（Vertex 下では無効なので、プロバイダーがオフに切り替わっても 1 回の起動で動作する）。

> **Auto-compact の整合性（手動モードのみ）.** `bili claude` ランチャーは、モデルに対する bili の有効ウィンドウに `CLAUDE_CODE_AUTO_COMPACT_WINDOW` を自動的に設定するため、claude 自身の auto-compact しきい値が bili の圧縮バジェットと一致する。手動 `/bili/` モードではこれを手動で行う必要がある — さもないと、claude は bili のウィンドウと一致しないしきい値で独自のローカル auto-compact（「会話を要約する」ターン）を実行する可能性がある。これは通常は無害である（同じセッション ID なので、bili は切り詰めから状態を再導出する）が、必要以上にノイズが多い。モデルに対する bili の有効ウィンドウに設定すること:
>
> ```bash
> export CLAUDE_CODE_AUTO_COMPACT_WINDOW=<bili effective window in tokens>
> ```
>
> claude はこの値をモデルに対して認識しているウィンドウに**下方向に**クランプする（上方向にはしない）ため、過剰設定は安全である。claude の設定（`autoCompactWindow`）経由で永続的に設定することもできる。

**その他の API キー使用クライアント** (Cursor / Aider / Continue …) — アップストリーム URL が設定されている場所に関係なく、`http://localhost:8787/bili/` を先頭に付ける。それ以外の変更はない。

`/bili/` プレフィックスは**自己検出シグナル**としても機能する: 10 億コンテキストクライアント拡張（billion-context-pi / opencode-acp）は自身の baseUrl でこれを認識し、自己無効化するため、二重圧縮が発生することはない。
### MITM 透明プロキシ（ログインクライアント）

**アカウントにログイン**するクライアント（ChatGPT Plus/Pro、Claude、ZCode コーディングプランなど）は、OAuth 経由で認証を行い、多くの場合**エンドポイントをハードコード**している。baseURL を変更できない場合、プレフィックスのトリックは機能しない。これらのクライアントには代わりに MITM モードを使用する。

動作原理: クライアントが提供する設定は**HTTP プロキシ**のみであるため、`CONNECT <host>:443` を送信する。billion-context はローカルで TLS を終了処理し（ローカルで生成されたルート CA を使用）、プレーンテキストに圧縮を注入し、再暗号化して転送する。OAuth トークンはクライアントの `Authorization` ヘッダーに含まれており、そのまま転送されるため、サブスクリプションの割引は維持される。

対応する MITM クライアント:

| クライアント | ログイン | エンドポイントのハードコード | ステータス |
|---|---|---|---|
| **ZCode** | bigmodel コーディングプラン (OAuth) | `open.bigmodel.cn` (組み込みプロバイダー) | ✅ テスト済み |
| **Claude Code** | Claude サブスクリプション (OAuth) | `api.anthropic.com` | ❓ 未テスト（動作しない可能性がある — 確認が必要） |
| **CodeBuddy** (VS Code IDE) | IDE アカウントログイン | `copilot.tencent.com` (`http.proxy` 経由で到達) | ✅ ユーザー確認済み (#897) |

> **Codex の例外:** Codex はトップレベルの `openai_base_url` 設定フィールドを公開しているため、ChatGPT ログイン版は `/bili/` プレフィックスを使用できる（上記参照）。Codex には MITM は不要である。

> **ZCode ネイティブモード (#1145):** ZCode はこのリストの中で唯一、**ネイティブプラグインモード**も備えているクライアントである — `bili plugin install zcode` はモデルトラフィックをプロバイダーストア（`~/.zcode/v2/config.json`、または v3.14 以降では `provider_config.json`）経由でルーティングする。v3.14 以降のビルドでは、ZCode のクライアント署名がコーディングプランアカウントの http ループバックオリジンを拒否するため、それらのアカウントは記録された理由付きで直接接続のままとなり、他のすべてのプロバイダーはルーティングされる — これらのアカウントでの圧縮には GUI の証明書 MITM 設定を使用すること、#1621。それ以外の場合、GUI のプロキシ/CA 設定は全く不要である。ネイティブモードは MITM サーフェスには影響しない: 両方を実行する場合、ログイントラフィックのために GUI のプロキシ設定（および `"mitm://zcode.z.ai": { "passthrough": true }` ルート、#661）を維持すること。詳細な仕組み: [clients.md](clients.md) (*ZCode*)。

MITM はモデルホストの**ホワイトリスト**（`open.bigmodel.cn`、`api.anthropic.com`、`api.openai.com`、`chatgpt.com`）にスコープが限定され、さらにレーンの設定が存在する場合、ディスカバリーが自動シードするレーンごとの標準ゲートウェイのデフォルト（例: `opencode.ai` — `opencode auth login` からの opencode の組み込み zen ゲートウェイ、#1405）が含まれる。その他のすべての HTTPS ホストはブラインドトンネル化される — billion-context はモデル以外のトラフィックを復号化しない。

> **CONNECT のみクライアント (`http.proxy`):** 多くの IDE クラスのクライアント（CodeBuddy、Cursor、Windsurf など）はモデル base-URL 設定を提供しない — すべてトラフィックを `CONNECT` を介した HTTP プロキシ経由でルーティングする。そのようなクライアントは、そのモデルホストが上記でホワイトリストに登録されている場合（またはランチャーによって発見/自動ホワイトリスト化されている場合）にのみ復号化される。それ以外の場合、そのトンネルは**ブラインド**である: エラーは出ないが、billion-context がプレーンテキストを見ることができないため、**圧縮もされない**。この設定ミスは明示的に表面化される (#897): ホストごとの最初のブラインドトンネルは修正手順付きの一度限りの `BLIND TUNNEL WARNING` をログに記録する; `GET /__bili/health` と `/__bili/stats` は `blindTunnels`（カウント + 正確なターゲットホスト、ループバックのみ）を報告する; そしてそのようなトンネルが存在する間、`acp_status` には `UNDECRYPTED TRAFFIC (instance-level)` セクションが追加される。修正方法: クライアントのモデルドメインを `"mitm".domains`（または `BILI_MITM_DOMAINS`）に追加し、再起動し、以下の手順に従ってルート CA を信頼する。なお、プロキシログはデフォルトで非パブリックなターゲットホストをマスクする（`<private-host>`、#255）— ローカルログでそれらをそのまま見るには `BILI_LOG_MASK_HOSTS=0` を設定すること。

ワンタイムセットアップ（クライアントでルート CA を信頼する）:

1. ルート CA を生成するために一度だけプロキシを起動する:

   ```bash
   bili start
   ls ~/.local/share/billion-context/ca/root-ca.pem   # 現在存在する
   ```

2. クライアントの**設定 → ネットワーク / プロキシ**で以下を設定する:
   - **HTTP プロキシ**: `http://127.0.0.1:8787`
   - **プロキシ CA 証明書パス**: このマシンで bili が実際に生成した CA ファイル — Linux/macOS では `~/.local/share/billion-context/ca/root-ca.pem`、Windows では `%USERPROFILE%\.local\share\billion-context\ca\root-ca.pem`。Web UI のルーティングページの ZCode カードには、このマシン上の実際のパスがコピーボタン付きで表示される — それを貼り付けるだけでよい。
   - （任意）**プロキシ除外リスト**: `localhost,127.0.0.1`
   - （ZCode の場合のみ: **設定 → ネットワーク**。Claude Code にはこれらは不要である: ランチャーが `ANTHROPIC_BASE_URL` 経由でルーティングし、そのモデルトラフィックはループバック上のプレーン http であり、その子プロセス環境変数にはもはや `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` が含まれない — それらを自分で設定しても、セッション内のツールが不要なプロキシを指すだけである。）

   > **Windows に関する注記:** Windows 上の ZCode は `~` を展開**しない** — `~/...` パスは見つからない（現在の作業ディレクトリとは無関係）。完全な絶対パスを入力すること、例: `C:\Users\<user>\.local\share\billion-context\ca\root-ca.pem` (#342)。

3. クライアントを再起動する。そのモデルトラフィックは現在、圧縮が注入されて billion-context 経由で流れる。メッセージを送信し、プロキシログ（`~/.local/state/billion-context/bili.log`）で `mitm <host>:443 tunnel established` を確認すること。

> ルート CA はローカルで生成され、このマシン上にのみ存在する; それは**システム全体のインストールではない**。設定したクライアントのみ（その CA パス設定を介して）がそれを信頼するため、他のアプリには影響しない。CA ファイルを削除してプロキシを再起動すると、それらは再生成される。

MITM ログインクライアントに**独自のアップストリームプロキシ**（ファイアウォール/GFW）を、同じホスト上の API キークライアントに影響を与えずに与えるには、`mitm://` スキームキーを使用すること — [MITM vs `/bili/` キースキーム](#mitm-vs-bili-key-schemes) を参照。

---
## ランチャー参照

`bili <client>` は独立したポートでプロキシを起動し（**起動のたびに新しいインスタンス** — 既に実行中の `bili start` は再利用されません、#216）、そのプロキシを指すようにクライアントを実行します。**設定ファイルの編集は不要**です：クライアント自身の設定は**読み取り専用**で参照され、どのアップストリームホストと通信しているかを特定するために使用されます。これらのホストは MITM 用に自動ホワイトリスト化され、プロキシはクライアントが使用するホストに対してのみ TLS を終端します。クライアントが終了すると、ランチャーが起動したプロキシは停止されます。

両方のアップストリーム方式は設定編集なしで自動的にカバーされます：

- **HTTPS アップストリーム → 証明書による MITM。** クライアントは `HTTPS_PROXY` 経由でプロキシに接続され、プロキシの MITM ルート CA（`~/.local/share/billion-context/ca/root-ca.pem`、遅延生成）を信頼します。圧縮は傍受された TLS ストリームに注入されます。
- **HTTP / ローカルホスト アップストリーム → `/bili/` baseURL の書き換え**（プレーンテキストは MITM できないため）。ランチャーは、クライアント自身のメカニズムを通じて、設定の分離された一時コピーを使用してクライアントのベース URL を書き換えます — 実際の設定ファイルには一切触れません（詳細は下記参照）。

各クライアントがどのようにプロキシに接続されるか（子プロセスの環境変数に自動設定）：

| クライアント | リダイレクト | CA 信頼 |
|---|---|---|
| pi | `HTTPS_PROXY` + `BILI_PROVIDER_REWRITES` 環境マニフェスト（拡張機能 `registerProvider`） | `NODE_EXTRA_CA_CERTS` |
| omp | `HTTPS_PROXY` + `BILI_PROVIDER_REWRITES` 環境マニフェスト（拡張機能 `registerProvider`）+ `PI_PROXY` も `PI_PROXY_ANTHROPIC` もユーザーが設定していない場合の `PI_PROXY_ANTHROPIC=<proxy>`（OMP の Cowork anthropic レーンを node:https 直接接続ではなくプロキシ経由にルーティング、#2583/#3556） | `NODE_EXTRA_CA_CERTS` |
| codex | `HTTPS_PROXY` + `-c key=value` オーバーライド | `SSL_CERT_FILE` → `combined-ca.pem` |
| claude | `ANTHROPIC_BASE_URL` = `/bili/` URL（Vertex の場合：`CLAUDE_CODE_USE_VERTEX=1` 時の `ANTHROPIC_VERTEX_BASE_URL`；+ `NO_PROXY`/`no_proxy` のループバックマージ、#3446） | 不要 |
| opencode | `HTTPS_PROXY` + 分離された `OPENCODE_CONFIG` | `NODE_EXTRA_CA_CERTS` |
| hermes | `HTTPS_PROXY`（プレーン HTTP は絶対形式のフォワードプロキシリクエストに乗る） | `SSL_CERT_FILE` → `combined-ca.pem`（+ レガシー `HERMES_CA_BUNDLE` → `root-ca.pem`） |
| dsh | `HTTPS_PROXY`（プレーン HTTP の場合は `HTTP_PROXY` も）+ `DEEPSEEK_BASE_URL`；**ループバック専用**の分離された `DSH_HOME` | `SSL_CERT_FILE` → `combined-ca.pem` |

`NODE_EXTRA_CA_CERTS` は組み込みの信頼ストアに*追加*するため、MITM ルート単独（`root-ca.pem`）を指します。一方、`SSL_CERT_FILE` はデフォルトの CA バンドルを*置き換える*ため、codex/dsh/hermes では `combined-ca.pem` を指します — これは MITM ルート**および** OS 信頼ストアと Node の公開ルートを含むバンドルであり、CA 証明書にのみ絞り込まれています（#5802: darwin の `security(1)` キーチェーンエクスポートには `com.apple.kerberos.kdc` のような非 CA のリーフアイデンティティが含まれ、codex の rustls スタックのような厳密な置き換えセマンティクスのクライアントは、エントリが 1 つでも解析に失敗するとファイル全体を拒否するため）。OS ストアのマージが重要なのは、起動された一部のクライアントがこのファイルを*完全な*信頼プールとして扱うためです（codex の rustls HTTP スタックは追加ではなく置き換える、#1807）：それらの直接接続（プロキシを経由しない）はこのファイル単独に対して検証される必要があるため、このファイルは OS 自身が信頼するもののスーパーセットでなければなりません（Windows 証明書ストアは PowerShell 経由、macOS キーチェーンは `security(1)` 経由；Linux はすでにファイルシステムバンドルを読み取っています；最大 24 時間ごとに 1 回再構築）。pip/git/curl スタイルの TLS（ブラインドトンネル化、実際の証明書）を子プロセス環境内で動作させることが、このバンドルの元の理由です（#152；hermes は #1375 以降、現在の hermes は `SSL_CERT_FILE` 経由でのみ環境信頼を解決するため；OS ストアのマージは #1807 以降）。

Claude Code は、証明書による MITM ではなく、独自のベース URL 変数を通じて `/bili/` URL 形式にルーティングされます — すべてのアップストリーム、事前設定された `ANTHROPIC_BASE_URL` リレーや `CLAUDE_CODE_USE_VERTEX=1` 下の Vertex エンドポイントを含みます；CA 信頼は不要です。古いビルドはプロキシ環境変数を完全に無視していましたが、新しいビルド（例：2.1.301）は `HTTPS_PROXY` を尊重するため、ランチャーはループバックホストを `NO_PROXY`/`no_proxy` にマージします（既存の値を保持しつつ）、子プロセスがどの挙動を持つかに関係なく `/bili/` 経路を直接に保つためです（#3446）。

アップストリームがどこから検出されるか（読み取り専用）：

| クライアント | 読み取り元 |
|---|---|
| Pi | `~/.pi/agent/models.json` — 各プロバイダーの `baseUrl` |
| omp | `~/.omp/agent/models.yml` — 各プロバイダーの `baseUrl` |
| Codex | `~/.codex/config.toml` — 各 `[model_providers.<name>]` の `base_url`（+ トップレベルの `openai_base_url`） |
| Claude Code | `ANTHROPIC_BASE_URL` 環境変数；`CLAUDE_CODE_USE_VERTEX=1` の場合は `ANTHROPIC_VERTEX_BASE_URL` / `CLOUD_ML_REGION` から導出される Vertex ホスト、それ以外はハードコードされた `api.anthropic.com` |
| OpenCode | `~/.config/opencode/opencode.json` — 各プロバイダーの `baseURL` |
| hermes | `~/.hermes/config.yaml` — 各プロバイダーのエンドポイント行 |
| dsh | `~/.dsh/settings.yaml` — すべての `baseURL`/`baseUrl`/`base_url` 値、目的地別に分割（ループバック → `/bili/` 書き換え；非ループバック https → MITM ホワイトリスト；非ループバック http → `HTTP_PROXY`）；+ `$DEEPSEEK_BASE_URL` 経由の組み込み `deepseek-official` ルート |

### 生成ファイル（書き込まれるもの — 最終手段のみ、#535）

ランチャーはファイルなしの注入を優先します（環境変数 > CLI フラグ/拡張機能 API > 生成ファイル；technical-notes.md の「注入優先順位」セクション参照）。ファイルが避けられない場合、それは**コピー**です — 実際の設定は決して編集されません：

- **pi / omp** — 何も書き込まれません（#535）：プロバイダーの baseUrl は、読み込み時に bili 拡張機能が消費する `BILI_PROVIDER_REWRITES` 環境マニフェスト（`registerProvider`）に乗ります。また、自動ネイティブコンパクトは拡張機能内でキャンセルされます（`session_before_compact`；omp は `auto_compaction_start` アナウンスにより自動と手動を区別、#851）— ただし、プロキシが実際に会話を保持しているという肯定的な証拠がある場合のみ（プラグインがこのセッション ID に対して `x-bili-plugin-conversation` をスタンプした、または omp のアイデンティティ登録が成功した、または `/__bili/plugin/status?conversationId=` が確認した場合）；非 http(s) のプロバイダー baseUrl（例：pi-claude-bridge のリテラル `"claude-bridge"`）はデフォルトではキャンセルされないため、それら自身のコンパクト引き継ぎが引き続き動作します（#1382）；プロバイダーは `providers` テーブルのエントリ（キー = プロバイダー ID（ルーティングに対して非 URL キーは無効）、フィールド `"compactionOptIn": true`）または `BILI_NON_HTTP_PROVIDERS`（環境変数、カンマ区切り）でオプトインできます — ただし、オプトインは候補セットを広げるだけであり、オプトインされたプロバイダーであっても、上記の同じ肯定的な保持証拠がある場合のみキャンセルされます（#1392）— 手動 `/compact` はいずれの場合もユーザー所有のままです。実際の `~/.pi` / `~/.omp` ホームには触れません。
- **opencode** — `OPENCODE_CONFIG` が指す一時 `opencode.json`（クライアント終了時に削除）、`/bili/` に書き換えられたプレーンテキスト baseURL **および薄いプラグインの追加**（`/acp` + `/acp-cache` コマンド）。OpenCode 1.x では、`opencode-acp` エントリはクローンから削除されます（ホストがそれを武装状態でロードしてはならないため）、代わりに薄いプラグインがそのパッケージをライブラリとしてインポートし、レガシーセッションにゲートされます；最初の削除されたスペックは `BILI_OPENCODE_ACP_SPEC` 経由で同梱され、ブリッジがホストがロードしたであろう正確なコピーをインポートできるようにします（#920）。相対的なローカルプラグインスペック（`./x`、`../x`）はクローン内で絶対パスに再アンカーされます — opencode はそれらを宣言した設定ファイルのディレクトリに対して解決しますが、クローンではそれがもはや該当しないためです（#826）。
- **hermes** — 何も書き込まれません（#535）：その httpx スタックは `HTTPS_PROXY`（+ `SSL_CERT_FILE` → `combined-ca.pem`；レガシー `HERMES_CA_BUNDLE` は古いビルドのために設定されたまま、#1375）に乗ります — https は CONNECT 証明書 MITM、プレーン HTTP は絶対形式のフォワードプロキシリクエスト。プロバイダーが設定されていない場合、ランチャーは警告を表示し、hermes は**プロキシなし**で実行されます（圧縮オフ）。
- **dsh** — 目的地別に分割（#535）：dsh の fetch スタックはプロキシ環境変数を尊重しますが、無条件のループバックバイパスを除きます。そのため、**非ループバック**のアップストリームは `HTTPS_PROXY`（証明書 MITM）/ `HTTP_PROXY`（絶対形式のフォワードプロキシリクエスト）に乗ります（`SSL_CERT_FILE` → `combined-ca.pem`）；**ループバック**のアップストリームのみが、`/bili/` 経由でルーティングする書き換えられた `settings.yaml` を持つ永続オーバーレイ `DSH_HOME`（`~/.dsh-bili`）を保持します。`profiles/`、認証情報、セッションはシンボリックリンクで通されます；実際の `~/.dsh` には決して触れません。ホームルートにある SQLite データベースは共有の唯一の例外です：各起動でオーバーレイ内にプライベートコピーが作成され、終了時に単位としてマージバックされます（ファイルリンクされたメイン DB は、1 つの inode 上で 2 つのパスが独立した WAL を成長させることを許してしまうため — #1917）。組み込みの `deepseek-official` ルートは `$DEEPSEEK_BASE_URL` 経由で別途キャプチャされます（dsh は `settings llm-deepseek.baseURL` ?? 環境変数 ?? デフォルトを解決するため、ユーザー設定が優先され、環境変数はゼロ設定フォールバックです）— カスタムプロバイダーがなくても、deepseek ルートはデフォルトでプロキシされます。
- **codex** — 永続オーバーレイ `CODEX_HOME`（`~/.codex-bili`、または `<CODEX_HOME>-bili`）、その他のエントリ（認証、セッション、モデル設定）は実際のホームへの共有リンクのままです。例外はホームルートにある SQLite データベース（`*.db` / `*.sqlite` / `*.sqlite3` — codex はそこにログ/状態を保持）です：各起動でオーバーレイ内にプライベートコピーが作成され、終了時に実際のホームへ**1 つの単位として**マージバックされます（新しいメイン DB ジェネレーションが勝つ；敗者は `<name>.bili-conflict` として保存されます）。これら DB を 2 つのホーム間でファイルリンクすると、1 つの inode 上で 2 つのパスが独立した WAL を成長させることが可能になり — コミットされた書き込みが失われたり、データベースが破損したりします（#1917）。2 つの生成ファイル：(a) MCP 注入がオンの場合、マージされた `config.toml` — 実際の内容に加えて、スポン時の `[mcp_servers.bili]` ブロック（インライン `-c` 値は Windows の cmd.exe 引用符で生き残れないため、#681）；(b) #1802 以降、生成された `.env`（モード 0600）が、**この**起動の `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` / `SSL_CERT_FILE` / `BILLION_CONTEXT_PROXY` を再ピン留めします：codex 自身の `load_dotenv()` は開始**後**に `$CODEX_HOME/.env` からランチャーのスポン環境を上書きするため、ユーザーの `.env` が例えば socks5h プロキシを指している場合、それ以外に codex が bili からサイレントにリルートされてしまいます（そして codex のカスタム CA rustls HTTP スタックは SOCKS を全く話せません）。他の `.env` 変数はそのまま引き継がれます；既存の共有 `.env` リンクは所有ファイルにマイグレーションされます；実際のホームの `.env` および他のすべての実際のホームファイルには決して触れません。Direct-URL モード（`BILI_LAUNCHER_DIRECT=1`）では `.env` は生成されません（保護すべき注入プロキシがないため）、MCP がなければオーバーレイ自体も生成されません。

### ランチャー内のネイティブツール

- **pi** — プラグインがインストールされていない場合、ランチャーは pi の `-e <file>` フラグを利用して、その実行のみに `dist/agent/pi.js` をロードします（何も書き込まれません）：ネイティブツール + `/acp`、`/acp-cache`、`/acp-rule` コマンドがデフォルトで利用可能（`/acp-cache` はサマリー台帳がデフォルト — 合計、判定、異常；`full`（または `--full`）を追加すると全行リストが表示され、`acp_cache` ツールに `detail: "full"` を渡すのと同じです）。インストールされている場合、シンボリックリンクされた `settings.json` がすでにそれをロードしているため — `-e` は追加されません。
- **omp** — プラグインは同梱されていません；ランチャーは設定に読み込み可能な bili エントリがない場合に `-e dist/agent/omp.js` を自動注入します（pi と同じゼロ設定ライド）。2 つの omp 固有のメカニズムにより、プラグインはそこで完全にネイティブになります：omp 17.x は `loadMode` を省略した拡張機能ツールを `xd://` デバイス URL 下にマウントします（モデルのメインターンからは見えない）、そのためプラグインはツールを `loadMode: "essential"` で登録します — モデルは 4 つの ACP ツールをネイティブで取得します；また、omp のフォークは `before_provider_headers` を発行しないため、プラグインはランチャーのアイデンティティ登録（`POST /__bili/plugin/register`、omp のセッション ID = `prompt_cache_key`/`x-session-id` をキー）を通じて会話をバインドします — バインドされたセッションはプラグインモード（ワイヤー注入抑制）で実行され、ネイティブの `/acp`、`/acp-cache`、`/acp-rule` コマンドが利用可能になります。
- **opencode** — 一時設定が薄いプラグインを自動的に追加します。
- **claude / codex** — デフォルトでオン：ランチャーは単一の `bili` MCP サーバーを注入します（claude には一時的な `--mcp-config` ファイル；codex には定義がオーバーレイの生成 `config.toml` に存在、[生成ファイル](#generated-files-what-gets-written---last-resort-only--535) 参照 — いずれの場合も実際のホスト設定には何も書き込まれません）、そのためホストはデフォルトでネイティブツールを取得します（claude 2.1.227 / codex 0.147.0 で検証済み）。`BILI_LAUNCHER_PLUGIN=0` はプレーンワイヤーモードにフォールバックします — 検証されたビルドより古く、注入フラグに対してテストされていないホスト向け。
- **codex + セルフホストアップストリーム自動フォールバック** — codex 0.147 は MCP ツールをモデルに `namespace` ツールタイプとして提供します；セルフホストサーバー（sglang/vllm/ollama/llama.cpp）はこれを解析せず、ツールがサイレントに見えなくなります。codex のアップストリームホストがループバック/プライベート（`127.0.0.1`、RFC1918、ULA、`.local`、…）であり、`BILI_LAUNCHER_PLUGIN` が未設定の場合、bili は自動的にワイヤーモード（すべてのサーバーが理解するフラットなツール）を使用し、stderr にそれを通知します。`BILI_LAUNCHER_PLUGIN=1` はプラグインモードを強制します。
- **hermes** — プラグイン API なし；常にワイヤーモード。
- **dsh** — ランチャーは常に dsh の argv に `--patch <file>` フラグをスパイスします（`~/.dsh-bili/.bili-acp.patch.yml` に書き込み）、プロファイルのローダーツリーに `dist/agent/dsh-acp.js` を挿入します：ネイティブの `/acp` と `/acp-cache` コマンド、dsh 自身の `/compact` と同じ形状（`/acp-cache` はデフォルトのサマリー台帳を表示 — dsh のコマンド API は引数を渡さないため、`full` はありません）。コマンドサービスを構成するすべてのプロファイルで動作します（web/tui インタラクティブサーフェス；`headless` ワンショットドライバーはタスクをモデルに直接送信し、コマンドを解析しない — `/compact` もそこで同じ挙動）。サブコマンド形式は処理されます：`dsh web` は `web` の後にフラグを取得し、`dsh plugin`/`--dump-default-config` は取得しません。

ランチャーモードマトリクス：

| モード | ツールサーフェス | セットアップ |
|---|---|---|
| ランチャー + MCP（claude/codex のデフォルト） | ネイティブ MCP ツール | なし — `bili claude` / `bili codex` のみ |
| ランチャーワイヤーモード（claude/codex、`BILI_LAUNCHER_PLUGIN=0`） | プロキシ注入ワイヤーツール | 環境変数 1 つ |
| ランチャー `-e` / 自動プラグイン（pi、opencode；omp は組み込み） | ネイティブプラグインツール | なし |
| 手動プラグイン（`bili plugin install`） | エージェント側プラグイン | インストール実行 |
| 手動 baseURL（`/bili/` プレフィックス） | プロキシ注入ワイヤーツール | クライアント設定の編集 |

### Direct-URL モード（オプトイン）

`BILI_LAUNCHER_DIRECT=1` は MITM/CA 信頼を完全に削除します — claude の `ANTHROPIC_BASE_URL` / codex のプロバイダー `base_url` が `/bili/` プレフィックスを直接指します。警告：

- **codex direct モード**：LLM トラフィックはプロキシを**通らない**ため、圧縮は適用されません — bili MCP ツール呼び出しのみが対象です。完全な圧縮にはデフォルトの MITM モードを使用してください（`BILI_LAUNCHER_DIRECT` を未設定に）。
- **claude direct モード**：`ANTHROPIC_BASE_URL` はプロキシにオーバーライドされます；`BILI_CLAUDE_UPSTREAM=<relay>` が設定されていない限り、事前設定されたリレーはバイパスされます。OAuth サブスクリプショントラフィックにはデフォルトの MITM モードが必要です。

`--mitm-domain <domain>`（繰り返し可）は、自動検出が見つけたものに加えて、MITM ホワイトリストに追加のドメインを追加します — クライアントが設定ファイルではなく実行時にフェッチするホストに有用です。デフォルトポートが使用中の場合、ランチャーは自動的に空きポートを選択します；`--passthrough` / `--debug` / `--no-auto-update` はプレーンな `bili` と同じように動作します。

---
## プラグインモード（ネイティブツール）

ネイティブプラグインの体験を得るために、エージェントはプロキシと並行して小さな協調型プラグインを実行できます。プラグインは4つのACPツール（`compress` / `decompress` / `search_context` / `acp_status`）をエージェントにネイティブで登録し、エージェント自身のツールループを駆動します。一方、プロキシは圧縮の権威（状態、履歴の折りたたみ、哲学プロンプト、ナッジ）として機能し続けます。ツールのスキーマはプロキシ自体が提供するため（`GET /__bili/plugin/manifest`）、プラグインとプロキシの間に乖離が生じることはありません。プロトコル仕様: [plugin-protocol.md](plugin-protocol.md)。

プラグインを備えたセッションはリクエストヘッダーを介して自動的に検出され、それらに対してはワイヤーレベルのツール注入が抑制されます（二重圧縮の防止、ネイティブツールのUX）。両方のプロキシモードで動作します：`/bili/` プレフィックス付きの baseURL **および** MITM透過モード。プラグインは、エージェント自身のモデルコンテキストウィンドウ（`x-bili-plugin-context-window`）を報告し、`GET /__bili/plugin/status` を介してライブのコンテキスト使用量を読み取ることができます。逆方向のヘッダーとして `x-bili-plugin-bypass: 1` があり、これによりプロキシはパイプライン処理（セッションバインディング、注入、圧縮）の前にリクエストをそのままパススルーします。これは、圧縮がプロセス内で実行されるレガシー acp セッションのために opencode ブリッジによってスタンプされます（#920）。

### インストール / 削除 / 一覧表示

```bash
bili plugin install pi      # add this billion-context install to pi's settings.json (packages)
                                  # npm installs write the pi-managed npm: spec; dev checkouts keep the abs path
bili plugin install omp     # same for omp (config.yml extensions)
bili plugin install claude  # register the bili MCP server (claude mcp add, user scope) + write
                                   # <configdir>/commands/acp-cache.md (model-mediated /acp-cache)
bili plugin install codex   # append [mcp_servers.bili] to ~/.codex/config.toml
bili plugin install opencode  # self-spawning native plugin (+ tools) in ~/.config/opencode/opencode.json
                                  # --with-mcp also adds the mcp.bili MCP face (no origin pin — live discovery)
bili plugin list            # install status for every supported host
bili plugin remove pi       # undo (original files backed up to *.bili-bak once)
```

`install pi` は、**レガシー** な billion-context エントリ（古い `npm:billion-context-pi` 参照、古い `npm:billion-context@x.y.z`、残った開発チェックアウトパス）を置き換え、正確に1つの bili プラグインのみがライブになるようにします。エントリを削除する場合、出力はまた、**プロジェクトスコープ** のエントリ（`pi install -l` で `<project>/.pi/settings.json` に書き込まれるもの）がこのグローバル設定の外にあり、手動で削除する必要があることを思い出させます。npm インストールされた bili の場合、書き込まれるエントリは pi 管理の仕様 `npm:billion-context` であり、pi はこれを自動的に `~/.pi/agent/npm/` にインストールします（起動時に欠落している場合も同様）、`pi update` でアップグレードされるため、エントリはマシン間の node プレフィックス移動後も生存します。開発/チェックアウトインストールでは、マシンローカルの絶対パスが保持されます（pi はローカルパッケージディレクトリを直接ロードするため）。どちらも `pi` マニフェスト → `dist/agent/pi-native.js`、つまり自己生成型のネイティブエントリをロードします。素の `pi` では、ランチャーなしで完全なプラグインモードの圧縮が利用可能になります（#519）。

**スタンドアロン `billion-context-pi` 拡張との共存。** 両者は排他的です — 両方がアクティブだと二重圧縮になります。3つの安全策があります：上記のインストーラーによる除去（グローバル設定）、ネイティブエントリがロード時に同期的に設定する `BILLION_CONTEXT_NATIVE=pi` マーカー（`billion-context-pi` **0.1.72以降** はすべてのイベントでこれを再読み込みし、拒否します。0.1.71以前はネイティブプロキシが存在する前にロード時のみ `BILLION_CONTEXT_PROXY` をチェックします）、そしてランタイムスキャン：プロキシが起動すると、pi-native エントリは両方の pi 設定ファイルを読み取り、インストーラーが見逃した同居するレガシーエントリ（プロジェクトスコープ、または事後インストール）について大きく警告します。

インストールされたプラグインは**薄い**ものです（約5 KB、ランタイム依存ゼロ）：プロキシを検出し（`/bili/` baseURL または `BILLION_CONTEXT_PROXY` から）、プロキシからツールスキーマを取得し、ネイティブツールを登録し、実行を転送します — プロキシは単一の圧縮権威であり続けるため、プラグインとプロキシは常にバージョンが一致します。プラグインAPIを持たないホスト（claude, codex）には代わりに MCP ブリッジがインストールされます — claude には `dist/claude-mcp-entry.js`（同じブリッジに加え、死んだレーンのプロキシを再生成するセッション中のプロキシウォッチドッグ、#1821）、codex にはプレーンな `dist/mcp.js` — 根本のプロトコルは同じですが、MCP にはスラッシュコマンドはありません（`/acp` パネルコマンドなし。claude はさらに、`<configdir>/commands/acp-cache.md` に書き込まれるモデル仲介の `/acp-cache` マークダウンコマンドを取得します。そのプロンプトは `acp_cache` MCP ツールを駆動し — モデルはレポートをそのまま貼り付けます）。opencode は独自のプラグインAPIを持つため、そのインストールはデフォルトでネイティブプラグインツールを追加し、MCP フェースは追加しません（`--with-mcp` でオプトイン。エントリには `BILI_MCP_PROXY` ピンなし — `dist/mcp.js` は呼び出し時にインスタンスファイル経由でライブプロキシを発見するため、ネイティブプラグインのエフェメラルポート再起動後も生存、#926）。

キルスイッチ：`BILLION_CONTEXT_PLUGIN=0` でプラグインモードを完全に無効化します（ワイヤーレベルの注入が再開）。

**そもそも `plugin install` が必要なのはいつか？** ランチャーユーザーはほとんど必要ありません（[ランチャーリファレンス](#launcher-reference) 参照 — pi/omp は `-e` が自動注入され、opencode は自動注入、claude/codex は MCP サーバーが自動注入、dsh は `--patch` 経由でネイティブの `/acp` と `/acp-cache` コマンドを取得、hermes はワイヤーのみ）。これは、ネイティブパネルを望む手動設定クライアント（`/bili/` プレフィックスまたは MITM）のためのものです：pi/omp/opencode はネイティブツール + `/acp` と `/acp-cache` を取得（pi/omp はさらに `/acp-rule` を取得。omp ではフォークが拡張ツールをモデルから隠すため、プラグインの価値はこれらのコマンドにあります）；claude/codex はネイティブ MCP ツールを取得（`/acp` なし。claude はモデル仲介の `/acp-cache` マークダウンコマンドを取得）；dsh はランチャーの `--patch` 経由で `/acp` と `/acp-cache` を取得（手動設定の dsh は同じパッチを自分で追加可能）；hermes は不可（ワイヤーのみ）。プラグインがなくてもすべて動作します — 圧縮はワイヤー注入ツール経由で実行され、モデルに `acp_status` を呼び出してライブ使用量を確認するように依頼できます。

### 他の圧縮プラグインの検出 (#1206)

1つの会話に2つの圧縮器があると二重圧縮となりメッセージ参照が破損するため、bili は自身と同居する他の圧縮器を能動的に探します：

- **スキャン**（読み取り専用、ベストエフォート、5分キャッシュ）：opencode グローバル + プロジェクト設定の `plugin` 配列；pi グローバル + プロジェクト `.pi/settings.json` の `packages`；omp `config.yml` の `extensions`；claude 設定の `enabledPlugins`/`plugins` キー + `~/.claude/plugins/` ディレクトリ；kimi `plugins/installed.json`；hermes `~/.hermes/plugins/` ディレクトリ；dsh プロファイル `package.json` の依存関係。2つの階層：**既知の競合**（`opencode-acp`、レガシー `billion-context-pi`、および dsh の `dsh-live-compact`（#5984） — 決定的）と**キーワードによる疑い**エントリ（compress* / compact* / acp / summar* に一致する名前。素の `context` は意図的に一致しません — それはドメインの名前であり、圧縮という行為の名前ではないため、`context7`/`dsh-context` のような読み取り専用ツールはフラグを立てません）；圧縮を行わないことが確認されたプラグインは、正確なパッケージ名によって完全に免除されます — 読み取り専用/表示専用ツール（例：`pi-compact-transcript`、`pi-context-inspector`）や、名前がキーワードと単に衝突するプロトコルアダプター（`@openma/deepseek-harness-acp`：その `acp` は Agent Client Protocol を意味し、acp-kernel エコシステムのマーカーではない；#2969） — 類似した名前は依然としてフラグを立てます。dsh の `dsh-live-compact` はキーワードによる疑いではなく既知の競合です：それは競合するコンパクト化エンジンであり、同梱の `cordis.patch.yml` は標準の `compaction-basic` 行を無効にし、独自のエンジン行を登録し、そのプリセット引き継ぎはプリセットのコンパクト化行を自分自身に名前変更するため、bili のロード時コンパクト化無効オーバーレイ（#3354）は標準行名のみを認識するため構造的にそれに対して盲目であり、そのチェックポイントは bili の知識の外に配置されます（#5984）。
- **検出結果が表示される場所：** クライアント起動前のランチャー stderr；各セッションの最初のリクエスト時のプロキシ警告ログ（クライアントは `x-bili-plugin` ヘッダーまたはワイヤーヘッダーから識別）；およびセッションの競合台帳 — `acp_status` の `COMPRESSION CONFLICTS` セクション、`GET /__bili/stats` → `conflicts`、Web UI バナー。
- **ランタイム証拠、表示用に階層化 (#2545)：** 通告のない履歴書き換え（#1001）と孤立 GC による無効化（要約された内容がクライアントの履歴から削除される）は、*疑わしい* 共存として同じ台帳に記録されます。重大度は証拠階層によって等級付けされます：**確認済み** = 検出されたクライアントネイティブコンパクト化の着地（bili はそれに基づいてリベース、#2372/#2432）または疑わしくないプラグイン検出 — これのみが「1つの圧縮器を残す」という命令形警告をトリガーします；**未確認シグナル** = 通告のない書き換え + 孤立 GC による無効化 — 原因が特定されていない観察された変更（「履歴が変更された、原因不明」）、ネイティブ自動コンパクト化や第2の圧縮器として提示されることは決してありません；名前だけの [suspected] マッチはソフトな「まず確認」階層（#1736）にとどまり、純粋な [suspected] 台帳は確認前アドバイスのみを受け取ります — 何も確認されていない間、クライアントごとの命令形修正フッター（「自動コンパクト化を無効化 / 新しいセッションを開始」）はありません（#2969）。検証済み非圧縮プラグイン（読み取り専用ビューア、または #2969 の ACP アダプターのようなプロトコルアダプター）を名指しする標準台帳レコードは、アラームとして永続化するのではなく、表示時に中和されます。また、未確認シグナルのセッション間集計数は、同じ会話での二重圧縮の主張にエスカレートすることは決してありません。
- **dsh の `auto: false` は自動トリガーのみを無効にします。** プロファイルバンドルパッチ（`dsh.bundle.patch.yml`）によってインストールされる `compaction-basic: { auto: false }` 行は、圧力/オーバーフロー自動コンパクト化をスキップします — 手動 `/compact`（およびアイドルセッションのコンパクト化）は依然として発火します。bili 経由でルーティングされた呼び出しはサーバーサイドガードによって拒否されます（#1729/#2360）；bili を経由せずにプロバイダーに到達する呼び出し（プラグインの引き継ぎゲートが帰属させないデスクトップレーンパス）は着地し、bili は次のリプレイでそれらを検出します — チェックポイントフレーミング + 間引かれた折りたたみカバレッジ — 永遠に後続のすべての compress が失敗するのではなく、1ターンで圧縮状態をリベースします（#2432）。dsh のコンパクト化を**完全に**オフにすること（手動 `/compact` を含む）が目的である場合、デルタは `auto: false` ではなく、同じ行に `disabled: true` として属します（以下のレシピ）。

 #### Web プロファイルで dsh ネイティブ自動コンパクト化を OFF にする (#1772/#3354, #3354以降は自動；#2474 レシピはフォールバック)
 
 **#3354以降は自動。** `@deepseek-ai/dsh-web-app` をバンドルするプロファイルでは、実行中の compaction-basic インスタンスはエージェントプリセット（`preset-standard.config.plugins`）内に存在し、パッチレイヤーはネストされた行を id でアドレス指定できません（#1772） — バンドルされた `- id: compaction-basic` 行は web-app のすでに無効化されたホストプレーン行に配置され、何も変更しません。bili は現在、LOAD TIME にそのギャップを閉じます：常時オンバンドルエントリ `bili-compaction-gate` — `bili-native` の横にある別の cordis エントリで、同じパッチレイヤーによってマウントされるため、`bili-native` が無効化またはキルスイッチされた後も生存します（#3662） — これは cordis `internal/config` オーバーレイを登録します（[deshark42/dsh-compaction-basic-disable](https://github.com/deshark42/dsh-compaction-basic-disable) からベンダー、MIT）が、bili がレーンを所有している間、プリセットの `compaction-basic` と `command-compact` 行を `disabled: true` にマークし、`dsh.bundle.patch.yml` / ランチャーオーバーレイのプリセットゲート行は、各 Web プリセットがそのオーバーレイのサービスを待ってから登録できるようにします。これらのプロファイルでは、ユーザーアクションなしでネイティブ自動コンパクト化がオフになります；ACP 圧縮には影響しません。
 
 オーバーレイは INTERNAL dsh フックに乗り、バージョンに敏感です。新しい/古い dsh ビルドで dsh コンパクト化チェックポイントが着地しているのがまだ見える場合、以下のフォールバックを使用してください。
 
 **無効化と削除 (#3662)。** `bili-native` の無効化（dsh プラグインマネージャーまたはパッチレイヤーの `disabled: true`）は、セッション作成を壊れなくなります：ゲートサービスは別の常時オン `bili-compaction-gate` エントリで生存するため、プリセットは永遠に保留になるのではなく、STOCK ネイティブコンパクト化にフォールバックします — 圧縮オフ、dsh は完全に使用可能。`bili-compaction-gate` 自体を無効化しないでください（それは壊れを再作成します）；完全にアンインストールするには、プロファイルの `dsh.profile.bundles` から `billion-context` を削除し、再起動してください。#3662以前のインストールで壊れたものはアップグレード時に自己修復します；手動では、`$DSH_HOME/cordis.patch.yml`（ホームレイヤー；デフォルト `~/.dsh/cordis.patch.yml`）に `- id: preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis` をそれぞれ `inject: null` 付きで追加します — トップレベルキーは完全に置き換えられ、保留ラッチがクリアされます。
 
 **フォールバックレシピ (#2474)**（dsh `0.2.1-alpha.1`、Windows 11、`@deepseek-ai/dsh-web-app` を含むプロファイルバンドルで検証済み）。プロファイルレイヤーパッチでオフにできます — プリセットはバンドルレイヤーによって挿入される通常のトップレベル行であり、プロファイルパッチレイヤーはその後で適用されます。機能しないのはネストされた行を id でアドレス指定することです；機能するのはプリセット行の `config` を完全にオーバーライドすることです。

```bash
# 1. Dump the composed profile and copy preset-standard's COMPLETE config block.
dsh --profile <name> --dump-config > /tmp/profile.yml
```

2. `$DSH_HOME/profiles/<name>/cordis.patch.yml` に `preset-standard` 行を追加し、その**完全な** `config` を含みます — すべての `plugins` エントリをバイト単位で — `compaction` グループ内で正確に1つの変更を行います。2つのバリアント：

    - **強（推奨、#3235）：コンポーネントを無効にする** — ネストされた `compaction-basic` 行に `disabled: true` を設定します。これは dsh 自体がホストプレーンで使用するのと同じメカニズムです；プラグインは完全にオフになります（运行状態 はもはや 运行中 ではないため）、圧力トリガーも手動トリガーもそこから発火できません。
    - **弱：ロードしたまま自動トリガーを止める** — 代わりに行の下に `config: { auto: false }` を追加します。自動圧力コンパクト化はオフですが、手動 `/compact` とツール結果プルーナーはオンに残り、コンポーネントは依然として実行されます。

```yaml
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # … every entry from the dump, unchanged …
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
            disabled: true          # ← strong variant: the only delta
            # config: { auto: false }  # ← weak variant instead, if you prefer
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config:
              thresholdChars: 8192
              headChars: 4096
              tailChars: 1024
      # … every remaining entry, unchanged …
```

3. 頼る前に確認：`dsh --profile <name> --dump-config | grep -A2 'id: compaction-basic'` — `preset-standard` のエントリ数は**不変**でなければならず、ネストされた行は現在 `disabled: true`（または `config.auto: false`）を保持していなければなりません。

自動圧力/オーバーフローコンパクト化はオフになります（強バリアントではコンポーネント全体が）；弱バリアントでは手動 `/compact` とツール結果プルーナーはオンに残ります。**`preset-ptc` と `preset-cordis` にも同じ形状を繰り返す** — セッションモードの切り替えはプリセットを再解決し、そこに有効のまま残されたコンパクト化行は、`preset-standard` がパッチされた後でもネイティブコンパクト化を復活させます（`preset-minimal` は `compaction` グループを同梱しません）。

**これを誤る3つの方法 — すべてサイレント**（同じダンプに対して測定）：

| パッチ形式 | 結果 |
|---|---|
| `- id: preset-standard.compaction.compaction-basic` | `patch: entry "…" not found`；**効果なし** |
| `- id: preset-standard` + 部分的な `config.plugins` | `config` は**マージではなく置き換え** — プリセットは書き込んだエントリのみ（測定例では 35 → 3）に収束：ペルソナなし、ツールなし |
| `id: preset-standard` 付きの `- insert:` | ツリーの末尾に**2番目の** `preset-standard` 行を追加；ライブプリセットは無傷 |
| 完全な `config` スナップショット + 1つの `disabled: true` | ✅ エントリ数不変、唯一のデルタは `disabled: true` |

**スナップショットはコピーした dsh バージョンで凍結されます。** バンドルレイヤーパッチとは異なり、プロファイルレイヤーの `config` は時点のコピーです：dsh アップグレードが同梱プリセット内の行を追加、削除、または再構成した後、このオーバーライドは古い名簿を提供し続けます — 新しいプラグインはサイレントにロードされません。ステップ1を再実行し、パッチ内のものに対して新しい `preset-standard` ブロックを差分比較し、そのセクションが変更されるたびに全体を再コピーしてください。スナップショットをメンテナンスしたくない場合は、ネイティブ自動コンパクト化をオンにし、代わりに #1729/#2432 リベースパスが相互作用を処理させることをお勧めします。

部分的なオーバーライドは診断なしで失敗するため、編集後は常に再ダンプしてエントリ数を比較してください。
- opencode ランチャー/ネイティブモード下では、存在する `opencode-acp` は設計上情報提供のみです（#920 がレガシーセッションのためにそれを吸収）；他の場所では警告します。
- 無効化：`BILI_CONFLICT_SCAN=0`。

---
## セッションとマイグレーション

### 圧縮状態はプロキシ側に存在する (#151)

圧縮状態（ブロック、サマリー、元のメッセージキャッシュ）はクライアント側ではなく**プロキシ側**に存在します。クライアント自身のローカル履歴は、圧縮されていない完全なビューです。これには2つの帰結があります。

- クライアントを元のアップストリーム（またはプロキシ停止時）に向き直すと、クライアントは各ターンごとに**完全なローカル履歴**をリプレイします。長い圧縮セッションの後、これはモデルのコンテキストウィンドウ（`context_window_exceeded`）を超える可能性があります。
- 圧縮ブロックをクライアントのローカル履歴に「展開」する方法はありません。クライアントは圧縮された形式を見たことがないためです。

### 起動時のストレージライフサイクル (#401)

プロキシはセッションストレージを**単一の**ディレクトリ走査とパース（ロードと、一度限りの #286 アイデンティティマイグレーションが同じパース済みマップ上で実行される）で起動します。セッションは永続的に保持されます。設計目標は、1年間の会話も失われないようにすることであり、そのため保持期間やサイズ予算によるプルーニング（削除）はありません。#286 マイグレーションは最初のパス後に `.bili-migration-286.done` マーカーを書き込むため、後の起動時に再スキャンや再ログ出力を行うことはありません。

### プロキシからの移行

セッションをエクスポートし、新しい会話に貼り付けて引き継ぎを行います。

```bash
bili export                      # list persisted sessions (id, label, blocks)
bili export <id|label>           # print a Markdown handoff (block summaries)
bili export <id> --full          # include the original messages per block
bili export <id> --jsonl         # line-delimited JSON dump (tables-first)
bili export <id> --full --output handoff.md
```

その後、クライアントで新しい会話を開始し（アップストリーム直接接続）、引き継ぎドキュメントを冒頭のコンテキストとして貼り付けます。

### Codex サブエージェントは独自の圧縮名前空間を持つ (#150)

Codex サブエージェント（例: `guardian_subagent` 承認レビュアー）はメイン会話の `session_id` を再利用するため、ワイヤー上では同じセッションのように見えます。注意を払わない場合、それらのリクエストはメイン会話の圧縮状態を継承してしまいます。これにより、サブエージェントのターンがコンテキストを折り畳まれ（読み戻す必要がある逐語的なユーザー承認を失う）、2つのロールの使用量推定が互いを汚染する可能性があります。

billion-context は `instructions` フィールドを通じてこれを検出します。サブエージェントのリクエストは独自のロールプロンプトを保持しています。**最初**に確認された instructions がメイン名前空間をアンカーします（メインプロンプトがドリフトしても安定）。それ以外の instructions 値は、独自の空の圧縮状態を持つ別の `|sub:` 名前空間にマッピングされます。サブエージェントのリクエストは自己完結型のリプレイであるため、新しい名前空間はロスレスです。また、Web UI のセッションリストでは、2つの名前空間が同じクライアントラベルを共有する別々のセッションとして表示されます。

このアンカーは Codex や Claude Code に固有のものではありませんが、分割は意図的なものであり、自動的ではありません。これは、トラフィックが複数のペルソナ間で1つの会話 ID を再利用していることが確認されたクライアントに適用されます（それぞれが同じ ID の下で独自のシステムプロンプトを送信する）。現在、これは Codex、Claude Code、DeepSeek Harness です。その他のすべてのクライアントにおいて、会話中のシステムプロンプトの変更は「同じ会話、進化したプロンプト」を意味し、メイン名前空間にとどまります。具体的な非 Claude の例としては、`@deepseek-ai/dsh-experimental-auto-review` を有効化した DeepSeek Harness があります。レビュアーは、各保留中のツール呼び出しの前に、独自の小さな固定システムプロンプト（約 1 KB。4つの `ENVIRONMENT` / `PROJECT_INSTRUCTIONS` / `FILTERED_HISTORY` / `PENDING_ACTION` セクションはそのユーザーターンに載る）の下で発火するため、その行はメイン会話の横に表示され、実行中としてもマークされます。

コードを読むことなく、そのようなレーンを区別するための4つの読み取り方法があります。

| 読み取り項目 | メイン会話 | レビュー / サブエージェントレーン |
| --- | --- | --- |
| システムプロンプト | 完全なプロンプト（数十 KB） | 非常に小さい（約 1 KB） |
| 圧縮回数 | 時間とともに増加 | 0 |
| リクエスト数 | ターンごとに約1回 | ツール呼び出しごとに約1回 |
| キャッシュヒット率 | 変動 | ≈99.9%（安定したプレフィックス、変更されるのは保留中のアクションのみ） |

### Windows: セッションディレクトリをアンチウイルスから除外する (#362)

billion-context は、セッションディレクトリ（デフォルトでは `%USERPROFILE%\.local\share\billion-context\`）の下にセッションごとに1つの JSON ファイルとして各セッションの圧縮状態を永続化し、長いセッションの各ターンでそのファイルを再書き込みします。Windows では、リアルタイムアンチウイルス（Windows Defender）、検索インデクサー、または同期ツール（OneDrive）が、書き込み中にそのディレクトリをロックする可能性があります。ロックが複数の書き込み間にわたって保持されると、リネームが `EPERM` で失敗し、ロックが解除されるまでそのセッションのすべての永続化が失敗します。

同じ環境の障害は、統合ストレージインデックス自体を開くことを拒否することもあります。SQLite が `%USERPROFILE%\.local\share\billion-context\sessions\index.db` を開けない場合（`unable to open database file` / SQLITE_CANTOPEN, #3823）、ストレージはレガシー専用モードにデグレードし、デグレード警告と診断ブロックはこの除外を最初の疑いとして特定します（他の2つは OneDrive のプレースホルダーファイルと 260 文字を超えるパスです）。

同じセッションが N 回連続で書き込み失敗した場合（デフォルトは `5`、`BILI_PERSIST_EPERM_ALERT_THRESHOLD` で調整可能）、プロキシは除外すべき正確なディレクトリを特定した**一度限りの、対応可能なアラート**をログに記録します。これは繰り返されません（`BILI_PERSIST_EPERM_ALERT_REPEAT_MS > 0` を設定すると、障害が続いている間、最大で M 分ごとに再アラートが発行されます）。

根本的に障害を止めるには、セッションディレクトリをアンチウイルスの除外リストに追加し、同期フォルダの外に保ってください。

1. **Windows Defender の除外設定:** 設定 → プライバシーとセキュリティ → Windows セキュリティ → ウィルスと脅威の保護 → 設定の管理 → **除外** → **除外の追加** → *フォルダー* → `%USERPROFILE%\.local\share\billion-context\` を選択。
2. **このディレクトリを同期しない。** OneDrive（または Dropbox / Google Drive / 類似サービス）が `%USERPROFILE%\.local\share\billion-context\` を同期していないことを確認してください。同期フォルダの下にある場合は、`BILI_SESSIONS_DIR` を使用して非同期パスに移動してください。

それ以外の場合、高頻度の永続化書き込みは各ターンでリアルタイムスキャンを再トリガーします。これが `EPERM` 書き込み失敗の原因です。ディレクトリが除外されると、アラートは停止します。

### Windows: Node ランタイムが Low とラベル付けされている（NTFS 必須整合性） (#5154)

上記すべては*ファイル*が問題であると仮定しています。#5154 では逆の形状が見つかりました。**Node ランタイム自体**（`node.exe`）が **Low 必須整合性ラベル**を保持しており、プロセスが Low 整合性であったため、*Medium ラベルのファイルへのすべての書き込み* — CA バンドルの再構築、`index.db`、セッションエンベロープ — が `EPERM` で失敗し、すべての ACL チェックは合格していました。ラベルは通常**継承**によって到着します。一度 `Low (OI)(CI)` とラベル付けされた親ディレクトリ（例えば、誤って実行された `icacls <dir> /setintegritylevel "(OI)(CI)Low" /T` によって）は、その中に配置されたすべてのファイルに Low ラベルを刻み込み、再起動後も残ります。これは、原因が見えない「クラッシュループ」の起動クラスの背後にあるメカニズムです（#5096）。

bili は起動時に自身のランタイムのラベルを一度プローブし（`process.execPath` に対する `icacls`）、Low/Untrusted を検出すると大きな `[integrity]` 警告をログに記録します。これはブロッキングではなく、プロキシは実行を続けます。

手動で確認および修正するには（管理者権限で実行；**絶対パス**を使用してください — 一部の PowerShell/cmd プロファイルでは `icacls` の PATH 解決が失敗します）：

```bat
:: look for a "Mandatory Label\Low Mandatory Level" line (no Mandatory Label line = no label = fine)
C:\Windows\System32\icacls.exe "C:\Program Files\nodejs\node.exe"

:: restore the runtime to Medium (this is the fix; verify with the command above)
C:\Windows\System32\icacls.exe "C:\Program Files\nodejs\node.exe" /setintegritylevel Medium
```

ラベルに `(I)`（継承）マーカーが表示される場合、**親ディレクトリ**がソースです：ディレクトリの**ルートのみを、非再帰的に**修正してください — `icacls "<dir>" /setintegritylevel Medium` を**`/T` なし**で実行します。新規および再作成された子要素はその後「（ラベルなし）」を継承し、収束します。`/T` を使用すると、何の意味もないのに数千のファイルに触れてしまいます。不明な場合は、まず `icacls "<dir>" /save acl.txt` で現在の ACL をバックアップしてください。

billion-context データディレクトリを Low に再ラベル付けしてこれを「修正する」ことは**しないでください** — その方向は状況を悪化させます（#3823 と #5154 を比較してください：Low プロセスのみが書き込めるファイル、どこにも整合性の天井がある）。
