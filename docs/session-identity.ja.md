# 匿名リクエストのセッションアイデンティティ

billion-context が**匿名**リクエスト（`session_id` ヘッダも body フィールドも
なし、`prompt_cache_key` もなし）がどのセッションに属するかをどう決めるのか、
その設計記録。tail-window reattach の撤去（#1115）と、wire-neutral canonical
projection（#2791）の後に将来参照として執筆。実装：`src/prefix-affinity.ts`、
`src/affinity-neutral.ts`；挙動テスト：`tests/truncation-fork.test.ts`、
`tests/prefix-affinity.test.ts`、`tests/affinity-neutral.test.ts`。

## 原理：content が唯一の不変アンカーである

クライアント提供の id は逐字で尊重される。クライアントが回転しうるもの —
credentials、中継、プロトコル変換 — でセッションを分割すると、ユーザーが話し
つづけているまさにその瞬間に状態が孤立する（#286 の教訓）。id をまったく持た
ないリクエストに対しては、メッセージ content が双方が共有する唯一の安定したも
のであり、アフィニティは再生された履歴から純粋に計算される。

二つの帰結が従う：

- **Environment はアイデンティティの外。** system プロンプト、tool 定義、モデ
  ル名は決してハッシュに入らない。サマリーは以前の environment の下での過去
  ターンを記述する；environment を含めると、ハーネスがプロンプトを回転させる
  （一般的な慣行）全セッションが孤立し、機構自体が台無しになる。
- **バイト完全一致が荷重を支えている。** kernel 内のメッセージ id は content
  ハッシュであり再利用されない。このパスでの near-match 許容は decompress で
  サイレントに誤帰属するため、マッチングは常にバイト完全一致。唯一の設計の自
  由は証拠を探しうる *場所* であり —— *どれだけ* あってはならない。

## フルプレフィックス一致 —— 唯一の採用パス

各追跡チェーンは漸進ハッシュ `h_i = sha256(h_{i-1} || canon(msg_i))` を保存す
る。受信リクエストは、その漸進ハッシュが保存済みチェーンの **head** と最も長
い厳密プレフィックスで等しいとき一致する（`via: "prefix"`）。これは健全だ：

- アイデンティティ証拠は位置 0 にアンカーされた共有 head 全体であり —— 別の会
  話はあなたの実際の冒頭ターンを持たずにあなたの位置 0 を引用できない。
- 分岐は自己修復する（フォークセマンティクス、#286）：クライアントが履歴を編
  集または分岐させると、次のリクエストは一致を止め新しいセッションを発行する
  のに対し、旧チェーンは編集されない系統を継続してサーブする。明示的な無効化
  は不要。
- 安全性：マッチングにはバイト同一の head を持つことを要求するため、折り畳ま
  れた状態は要求者がすでに持っていないものを何もしない。

## Tail-window reattach —— 歴史と撤去（#316 → #1072 → #1115）

### 解決した問題

再生履歴を切り捨て（drop-oldest、ローリングウィンドウ）るクライアントは、head
からではもはや一致しない。reattach なしでは最初の切り捨て以降毎ターン新しい
セッションを発行し、圧縮ラダーを構築できない。観察された対象クラス：20–30
アイテムのローリングウィンドウを保持する dsh 系 web クライアント。

### メカニズム（撤去済み）

リゾルバは受信の先頭 `w = min(8, depth)` 個のアイテムハッシュを、各追跡チェー
ンの**任意の中間オフセット**に対してスライドさせ、連続ヒットがちょうど 1 つな
ら保存済みセッションを採用した（`via: "tail-window"`）。

### なぜ構造的に弱かったか

中間連続一致は**対称証拠**である：それは区別できない

- 「同じ会話、切り捨てられた再生」（意図ケース）と
- 「共有 content を引用する別の会話」—— テンプレート化 tool 出力、標準ファイル
  内容、定型エラーメッセージ。

第二のケースには攻撃者は不要：同じコードベースで働く並列エージェントは中間ス
ライスを自然に同一にする（受動的テンプレート衝突）。そして採用はどちらの方向
でも有害だった：

- 採用側の再構築 wire が被害セッションの折り畳みサマリーブロックを受け取る
  （会話跨ぎの情報漏洩）；
- 採用側の新しいターンが被害セッションへ記録される（真の所有者へのコンテキ
  スト汚染）。

暫定緩和（#1072）は 3 ではなくフル 8 アイテムウィンドウを要求し、8 未満の作製
ウィンドウを閉じた —— しかし大きな閾値は対称性を壊さない：任意の 8 個の中間
連続アイテムを持つだけでは依然十分だった。

### 撤去前の測定

本デーモンのデプロイで 3 日間の本番ログ（2026-09-19 → 2026-09-22）、匿名解決
~11.5k 件：

| Outcome | Count |
|---|---|
| full-prefix match | 9,367 |
| new session | 2,106 |
| fork lineage recorded | 142 |
| **tail-window reattach** | **0** |
| ambiguous multi-candidate tail hit | 0 |

観測された使用はゼロ —— near-miss もゼロを含む。

### 決定：中間チェーン採用を全面的に捨てる（#1115 の方向 3）

切り捨てられた再生は今や新しいセッションへフォークする（`via: "new"`）。受け
入れたコスト：raw 再送 1 回+ラダー再起動 —— すでに instruction-drift フォー
クが接受しているのと同じコストクラス（#1106）。二つの緩和が損失を区切る：

- **Opt-in block adoption（#629）** は、ソースメッセージが受信再生に残ってい
  る圧縮ブロックを持ち渡る（raw-id SET セマンティクス、prefix 系統ではない）。
- **Kernel reconciliation は健全のまま**：切り捨てられた再生は影響ブロックを
  優雅に非活性化し、フル再生はそれを復活させる（`tests/truncation-fork.test.ts`
  でピン留め）。

切り捨てランのスキャンは帰属形態としてのみ生存する：先頭 `TRUNCATION_LINEAGE_
WINDOW = 8` ランが追跡チェーンの内部（offset ≥ 1）に厳密に含まれる NEW
セッションは `lineage: { reason: "truncated", parents }` を記録；共有先頭プレ
フィックス（LCP ≥ `MIN_FORK_PREFIX = 3`）があれば代わりに
`reason: "forked"` を記録し優先される。Lineage は UI/debug 用にログされて保存
されるが**マッチングには決して影響しない**。

## Wire-neutral canonical projection（#2791）

### 車線横断の盲点

上記の漸進ハッシュは各メッセージの **raw wire JSON** 上で計算されていた。*同
一会話* の異なるプロトコル上の 2 つのレンダリングは決してバイト等価でない —
— OpenAI wire は tool アクティビティを
`{role:"assistant", content:null, tool_calls:[{function:{name, arguments:"…json string…"}}]}`
と `{role:"tool", tool_call_id, content}` でレンダリングする一方、Anthropic
wire は assistant content ブロック `[{type:"thinking"}, {type:"tool_use", name,
input:{…}}]` と次の user メッセージ内にネストした `tool_result` ブロックでレン
ダリングする。したがって dsh セッションが `api` を切替えたとき
（`openai-completions` → `anthropic-messages`、同じ会話、同じ upstream
モデル）、何も一致せず、新しい匿名セッションを発行し、fold ledger を孤立さ
せ、切替ターンでフル再 fold（~182 s）+ キャッシュリセットを支払っていた —
— サイレントに（#2791）。

### Projection

ハッシングは protocol-neutral projection（`src/affinity-neutral.ts`）上で実行
されるようになった：各メッセージはハッシュに十分単射でありながら wire の装飾
を落とす規則の下で `NeutralTurn`（`{kind, text}` か `{kind, calls}`）に正規化
される：

- 先頭 system/developer ランを剥離（top-level `system` パラメータは projection
  に一切入らなかった）；
- text content：文字列 ↔ `[{type:"text"}]` ブロックを連結；
- tool アクティビティ：`tool_calls[].function.arguments`（JSON *文字列*）と
  `tool_use[].input`（オブジェクト）の両方を解析済み値へ正規化；
  `{role:"tool", tool_call_id}` ↔ user `tool_result` ブロックは合成
  `{kind:"tool"}` ターンになる（複数 `tool_result` の user メッセージは分割）；
- tool call を持つ assistant ターンは text を落とす（2 つの wire は thinking
  が tool call を伴うかで不一致）；
- 連続 assistant メッセージを結合（Anthropic は分割する）；
- クライアントの `[model changed: …]` マーカーターンと churn キー
  （`cache_control`、id、シグネチャ）を破棄；
- 未知形状はメッセージ全体の raw canonical にフォールバック —— マッチングは
  v1 挙動へ降格し、偽一致にはならない。

ターンごとの canonical 文字列は `canon({content, role})` —— 素の OpenAI text
メッセージの v1 canonical とバイト同一なので、#2265 の simhash hamming
較正が不変に引き継がれる（モデル再押印変異は採用可能バンド内に留まる；元の
fixture で `coverage ≥ 0.9` を検証済み）。

### ストレージとマイグレーション

`ChainEntry.hv` がドメインを区別する：`hv:2` エントリは neutral per-item
ハッシュと simhash sketch を持ち；アップグレード前の `hv:1` エントリは読み取り
可能かつマッチ可能のまま（raw-wire ドメイン、legacy churn 耐性 tail ハッシュ
込み）なので、アップグレードですべての追跡セッションを再発行しない —— 大量フ
ォークのコストは会話が実際に wire を横断する場所でしか支払われ
ず、それはちょうど以前すでにフォークしていたケースである。Simhash 採用と
lineage ランクはドメインごとに動作（採用は `hv:2` のみ）し、クライアント提供
の append-only ガードは `hv:1` エントリを無条件に再アンカーする（depth はドメ
イン内でのみ比較可能）。

### ライブエビデンス

新規 dsh セッション、`openai-completions` 車線で 45 KB 知識ファイルを読み取り
（fold 発火：~13.5k token 節約）、その後同じ dsh セッションが
`anthropic-messages` へ切替えて折り畳まれた content を質問：anthropic リクエ
ストは openai 車線セッションに prefix depth 9/11 で一致、新しい匿名セッション
なし、再 fold なし、回答は fold サマリーからサーブ、キャッシュヒット 2 ラウン
ド以内に 97 %。キャプチャとログは #2791 スレッドに。

## Snapshot render：session id がメッセージアイデンティティ全体になる（#3756）

上記の匿名採用ラダーが存在するのは、wire バイトが無認証会話の唯一の記録だか
らだ。バインド id を持つセッション（ホストネイティブ session ヘッダまたは
affinity key）かつ統一ストレージが利用可能なら、#3756 はループを閉じる：OUTBOUND
履歴プレフィックスはその session id でキー化されたサーバー自身の transcript
から描画される（`src/server/snapshot-render.ts`、rollout feature
`snapshotRender`、既定 0%）。描画プレフィックスのメッセージアイデンティティは
サーバー行 `seq` —— content ハッシュはクライアントの逐字 tail がサーバー
prefix に結びつく場所のみを特定するチェーンフォールバック証拠へ降格。クライア
ント編集、ホストチェックポイント、プロトコル切替はいずれも折り畳みカバレッジ
を移動・削除・重複できなくなった、なぜならカバレッジはクライアントがたまたま
再送するものではなくブロックの seq/signature セットから計算されるから。上記の
採用ラダーは機能がオフ、ストレージ不可用、またはチェーンがリンクできない車線
のためのフォールバックとして残る —— degrade、推測しない。完全な仕組みと誠実性
境界：`message-identity.md` §"The snapshot render engine"。

## 拒否された代替案

| Direction | 拒否理由 |
|---|---|
| サフィックスアンカー一致（一致は保存 tail で終わらねばならない） | クライアントがちょうどウィンドウ長（K = 8）を保持する場合のみ機能。文書化されたローリングウィンドウは 20–30 アイテムを保持 —— 支配的な正当ケースが壊れる。 |
| 深度スケーリング証拠（ウィンドウは保存チェーンの ≥ 50% をカバーしなければ） | 固定 8 アイテムウィンドウは 16 アイテムより深いチェーンの半分をカバーできない —— 長い会話を殺す、まさに保ちたいはずのもの。 |
| Kernel 検証採用（kernel 全 id チェーンとの突合） | Kernel id は content ハッシュ：より深い深度へ拡張された同じ対称証拠。精度は上がるが所有証明はなく、匿名ホットパスにセッション lookup を追加する。 |
| Tail アンカー最長ラン+底（dir 1+ 変種） | 健全で機能を保持する。測定使用がゼロだったため*当面*辞退；投機的 surface を出荷するのではなく、クライアント側アイデンティティ信号とともに再検討。 |

## 三層アイデンティティフレームワーク

変異下での連続性は三つの独立レイヤーに分解される。真の単位はセッションでなく
BLOCK —— 連続性は構造上部分的：

1. **Attach** —— リクエストがどの保存チェーンに属するか。証拠はクライアント
   が明らかに持っているものから来る；#1115 以降は head アンカーのフルプレフィ
   ックス一致のみが有効。
2. **Block validity** —— ブロックごと、kernel がメッセージ id の PRESENCE（位
   置ではない）から決定：カバー済みメッセージ欠落 ⇒ ブロック非活性；復帰 ⇒ 復
   活。「セッションの半分」はこのレイヤーの機械的帰結であってポリシーノブでは
   ない。
3. **Environment** —— system prompt / tools / model はアイデンティティの外（上
   記原理を参照）。変わった environment は未来のターンを変え、過去サマリーの
   真実を変えるのではない。

## 派生（子）セッション：誕生時の系統（#1333、#1362）

エージェントが子セッションを生んだとき —— 親の会話を再送するのではなく空歴
史から始める subagent またはフォーク —— その子は以前、親で折り畳まれて消えた
content を `decompress` や `search_context` できなかった。各車線は今や誕生時に
系統を報告する：そのアイデンティティ登録は親の会話 id（`parentConversationId`）
を持ち、プロキシは子セッションに読み取り専用リンク（`derivedFrom`）を記録す
る。それ以降：

- `decompress` / `search_context` は子が自身で見たことのない content について
  親チェーンに沿ってフォールバックする（resident または on-disk の親、サイクル
  ガード付き、depth cap 8）；
- 子の状態に何もコピーされず親は決して変更されない —— フォールバックヒットは
  読み取り専用なので、子は親がいまだ所有するものを上書きできない；
- リンク記録時に親がプロキシに知られていなければ、子は単に新しく始まる。

| Lane | Parent signal |
|---|---|
| **pi** RLM inline spawn | session ヘッダの `parentSession`（親セッションファイルへのパス、その session id に解決） |
| **omp** fork / newSession | session ヘッダの `parentSession`（裸の session id またはファイルパス —— 両方受理） |
| **OpenCode V1**（ネイティブプラグイン） | SDK session info の `parentID`（セッションごとに一度解決、キャッシュ） |
| **OpenCode V2**（ネイティブプラグイン） | `session.created` イベントの `data.parentID` |

claude/codex/dsh にはここには何も不要：subagent 間で一つの session id を共有
するか、子セッションの概念自体がない。

## 将来の方向

持続的な修正は**クライアント側アイデンティティ信号**である：クライアント自身
が供給する会話ごとの安定 id。クライアントがそれを提供するまで、バイト完全一
致の head アンカー一致が安全な床であり、suffix/中間チェーン採用のいかなる再導
入もまず本文書の脅威モデルに対して正当化されなければならない。

関連：#1148（OpenAI インライン `messages[0]` system プロンプトがアイデンティ
ティに焼き込まれ、他のプロトコルと非対称 —— 別 issue）。
