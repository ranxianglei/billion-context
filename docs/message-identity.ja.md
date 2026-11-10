# メッセージアイデンティティ：コンテンツハッシュをターン跨ぎの join キーとする

billion-context が個々のメッセージをターン跨ぎでどう識別するのか、そしてなぜ
アイデンティティは受入（ingress）時に割り当ててホストが永続化する id ではなく
メッセージの **content（内容）** から導出されるのか —— その設計記録である。
#1496 のレビュー後に執筆したもので、`session-identity.md`（同じ問いをセッション
粒度で決着させる文書）の姉妹文書。実装アンカー：
`acp-kernel/src/wire/message-id.ts`（`deriveMessageId`）、
`acp-kernel/src/refs.ts`（`assignRefs`）、`acp-kernel/src/prune.ts`
（`isCovered`/`baseIdOf`）。#2480 はこの問いを二つに分割した：下の
**kernel ledger（台帳）** は引き続き content-hash である一方、**fold-coverage
re-anchoring レイヤー**（`src/fold-reconcile.ts`）は自己保存正規コピー付きの
位置ベースになった —— 下「fold-coverage レイヤーは位置ベースになる」節を参照；
本ドキュメントの ledger 契約は何も変わっていない。#3641 はさらにその上に判定
レイヤーを追加した —— **どの**チャネルも検証できなかった場合になにが起きるか —
— 下「snapshot-as-session 教義」節を参照；ledger 契約はそのまま健在。

## 問いは id ではなく join キーである

「受入時にメッセージごとの自動採番 id を割り当てる」のは、このシステムに欠け
ている提案ではない —— kernel が既にやっていることだ。すべての受信メッセージに
セッションスコープ・単調増加・再利用されない台帳から `mNNNNN` ref が付く
（リポジトリ AGENTS.md：*Kernel Contract — message ids are never reused*）。

本当の問いは、ターン N+1 でステートレスなホストがその **private** ストレージ
から配列全体を再シリアライズしたとき、台帳を新しい配列に再ピン留めするのに
どのキーを使うか、ということ。位置/順序は本番のエビデンス（下記）によって嘘
だと証明されている。5 つのホストすべてと 4 つのプロトコル車線すべてで安定して
いる唯一のキーは、メッセージの **content バイト**である：

```
wire bytes  --sha256-->  h_<sha16>  --byRaw join-->  mNNNNN (ledger ref)
```

`deriveMessageId` は `role | contentType | toolCallId | toolName | text` を
ハッシュ化し；`assignRefs` は ref を first-wins で付ける（`if (map.byRaw[message.id])
continue`）。ハッシュは自動採番 id を *置き換える* ものでなく —— id を再結合さ
せる **join** である。

## handled ≠ authored ≠ stored

「全メッセージが我々を通るから id を押印できる、つまり 100% カバレッジ」という
誘惑的な推論は、三つの異なる性質を取り違えている。ホストごとに検証済み：

| Host | ターンごとに private storage から再シリアライズ | 我々が押印した id は往復できる？ |
|---|---|---|
| codex (Responses) | yes（rollout ファイル；environment_context アイテムが回転） | **partially** — response 側アイテムのみ（#242） |
| claude-code (anthropic chat) | yes（session JSONL） | no channel |
| pi (chat, MITM/plugin) | yes（`convertToLlm()` が配列を再構築；メッセージモデルに id フィールドなし） | no channel |
| omp | yes（pi 系プラグイン） | no channel |
| hermes plugin | yes（独自の store、`pre_api_request` フック） | no channel |

カバレッジは ingress ではなく **re-join ポイント**で測らなければならない。

## 車線調査：id はどこに置けるのか？

| Lane | メッセージレベルの id フィールド | 判定 |
|---|---|---|
| anthropic chat | なし（`tool_use.id`/`tool_use_id` のペアリングキーのみ） | no candidate |
| openai chat | なし（`tool_calls[].id` のみ） | no candidate |
| google | なし（`functionCall`/`functionResponse` のペアリング id のみ） | no candidate |
| responses | `input[].id` が存在する | **provider namespace**：#242 — 我々の 66 文字 id が 64 文字上限を超え毎ターン 400；#1474/#1475 — Copilot は `rs` プレフィックス形状を要求；修復は今や我々の `msg-proxy-*` namespace に限定 |

4 車線のうち 3 つにはそもそもフィールドがなく、存在する 1 つもローカル発行 id
を本番で 2 回拒否している。ingress は再生された `msg-proxy-*` id を削除する
（`src/loop/adapter-responses.ts:62-68`）—— まさにそれらがアイデンティティで
なくラウンドごとの副産だからである。

## msgid エンベロープ：ホスト保証の id が bili 車線を走る（#4491/#4834）

上記の車線調査は、見えてよりも狭い問いに答えている：それは **model wire**
を調査しているものだ。プラグイン車線は、メッセージ id が実際に存在する第二の
チャネルを加えた —— モデルプロバイダには一切転送されない bili 専用エンブロー
プ：

- `msgIds` — 増分ターンエンベロープ（`POST /__bili/plugin/turn`；
  `src/agent/incremental-client.ts` の `buildBody` で構築）における
  `messages` と並走する文字列配列。サーバーは組み立てた body に
  `biliMsgIds` として再押印し、パイプラインに再投入する（
  `src/incremental-lane.ts`）；さらに `src/server/prepare-anthropic.ts` は
  リクエストが upstream に向かう前にフィールドを剥がし pin を適用する
  （`src/msgid-pin.ts` の `applyMsgIdPin`）。
- セマンティクス：CLIENT がこれらの id が当該ホストの会話ビューに対して安定
  であることを保証する（dsh/omp/opencode/pi のストレージ id）。有効な id は
  `msg_id` として ledger 行にピン留めされ —— クライアントのアイデンティティ
  が ledger アイデンティティとなり、それらのメッセージでは content 由来 id を
  置き換える。
- 全有無（all-or-nothing）：長さ不一致、スクリーン失敗、すでに主張済みの id
  があれば `msgIds` フィールド**全体**を破棄する（部分的・ずれた配列は絶対に
  許さない）；増分車線ではそのターンは content 由来アイデンティティに降格す
  る。生存中の正規 id の再利用はサイレントな再紐付けではなく 400。
  `resync: true` はフルセットを一括再主張する。
- #4834：解決は id 優先（id-FIRST）—— コンテンツを再エンコードするモデル横断
  書き換え（pi `transformMessages` 系）でももはや id を拒否しない；id が
  content の変動より優位になる。ledger の主キーは三段組
  `(session_id, msg_id, content_hash)` のまま —— ハッシュは誤紐付けに対する
  安全帯であり続けるが、有効なクライアント id より上位ではなくなる。
- #4863：id の主張は計画済みターンが実際にディスパッチされたときだけ取得す
  る（claim-after-guard）ため、single-flight ガードに却下されたターンはその
  id を消費しなくなった。

これで変わらないこと：model wire には依然としてメッセージレベルの id がなく
て、tool-call id はこれまでどおり —— クライアントが返すモデル発行のペアリン
グキーであってアイデンティティではない（#2821 は projection 再構築時に再発行
する）。proxy-mode の全量再送は依然として下記の順序中心ラダー経由で調整され
る。エンベロープは bili プラグイン車線が存在し、ホストがフルセットを保証でき
るところ에만現れる。

## 「original bytes never change」が実際に意味すること

この主張は方向としては正しく、ただ必須の補足がある：**user/assistant が作成
したバイトは安定；environment が作成したスロットはその場で回転する。** codex
の `environment_context` は毎ターン書き換えられ；匿名 OpenAI ハーネスはイン
ライン system `messages[0]` を回転させる（#1148）；nudge テキストは毎ターン
再注入される（#728）。これが `session-identity.md` が environment をアイデン
ティティの外に置く理由であり、#1148 の修正がアフィニティハッシュから先頭
system ランを剥がす理由でもある。

プレフィックスはアイテムよりもさらに安定しない：ローリングウィンドウ切り捨て
（dsh 系クライアント、20–30 アイテム）、フォークとロールバック再生（#1148,
#1102）、1 メッセージのサイドリクエスト（#1307：`ctx==1` → 163/163 圧縮失敗、
`ctx>1` → 62/62 成功）、その場での書き換え（#1247）、ホスト側の自己圧縮
（codex `/compact`、claude-code `/compact`）。

## 失敗モードの非対称性：誤帰属 vs 非認識

- **位置/順序 join が失敗 → 誤帰属。** ref や圧縮ブロックが *間違った*
  メッセージに付く；decompress が誤った内容を返す；自己修復できないサイレン
  ト破壊。#1307 の元の ≤2 件数ガードはこの種の順序ヒューリスティックの失敗
  そのものだった。
- **Content-hash join が失敗 → 非認識。** 会話が新しいセッションに分岐して冷
  たキャッシュを再構築する。自己修復できる性能損失（#286 のフォークセマンテ
  イクス）。

公理は、安い方の失敗モードで選ばれるべきである。

## ホストは会話内で tool-call id をバイト単位で安定させなければならない

ハッシュは `toolCallId` を因子として含み、fold-reconcile レイヤー
（`src/fold-reconcile.ts`、#1921）はそれを第一の主張キーとして使う：
`tool_use.id` / `tool_call_id` は会話内でプロトコル的に一意であり、かつクライ
アントの再シリアライズを逐字で生き残る唯一のフィールド群である。この前提には
外部依存が一つある —— **ホスト自身**が一つの会話を別プロバイダへ投影する際、
それらの id を書き換えてはならない。#2396 が実際の違反を発見した：Prime
（pi 系ランタイム）が一つの会話を Codex からカスタム Responses プロバイダへ切
り替え、その foreign-provider 変換器が保存された複合 id を再サニタイズした —
— `call_switch_seed|fc_0_0` が Codex 車線では `call_switch_seed` とシリアライ
ズされるのに、foreign 車線では `call_switch_seed_fc_0_0` として出ていく、ペア
の両側で。両方の claim pass が id をキーにするため、すべての折畳み tool ペア
がマッチングを止めた：~66,525 input token で課金されていたコンテキストが
558,541/562,549 として 500,000-token ウィンドウに対して再投入された。

Bili の対応は上記の失敗モード公理に従う：old→new の対応関係を推測しない
（それは非認識を誤帰属に変える —— 見かけ上妥当な id 入れ替えの下で
decompress が誤った内容を返すことになる）。代わりに形を検出する：カバー済み
 id が欠落し、その正規アイデンティティ（toolCallId なし）が異なる toolCallId
 を持つ受信側の双子と一致すれば、書き換え疑いとして数えられ drift ログに名指
 しされる（#2396）、そのうえオリジナルは正直に fold 解いたまま wire へ再投入
 される。義務はホストにある —— plugin-protocol.md（"Obligations of a plugin"、
 item 5）を参照：ペイロードがプロキシに届く前にホスト境界で id を正規化せよ。
 #2396 の回避策（プロキシ処理前に権威ある保存履歴から `call_id` +
 `call_output.call_id` を一緒に書き換える）はその義務の参考実装である。

#2480 はこのクラスについて検出だけの姿勢を解消した：欠けていたピースは**ホス
トがバイトがかつて何だったかの知識**であり、fold-coverage レイヤーは今やまさ
にそれを保持する —— 自己保存正規コピー（次節を参照）。位置が対応関係を与え、
保存されたフィンガープリントがそれを検証するため、ホスト書き換え後の id シー
ム横断での主張はもはや推測ではない。drift ログと正直な再投入フォールバックは
コピーがカバーできないケース（構造的編集、ウィンドウ外の履歴）のために両方残
る。

## fold-coverage レイヤーは位置ベースになる（#2480）

kernel ledger と fold-coverage re-anchor は異なる問いに答えている：

- **Ledger join**（ターン N+1、再シリアライズされた配列に `mNNNNN` を再ピン
  留め）：content hash、上記すべて通り不変。
- **Fold-coverage re-anchor**（受信メッセージのうち、私の圧縮ブロックがすで
  にカバーしているのはどれか？）：`src/fold-reconcile.ts` は今これを**位置+
  自己保存正規コピー**で答える —— 以前から持っていた toolCallId pass と正規
  content pass よりも手前で。

仕組み：各 reconcile pass は `foldPositions` を滾らせる —— 位置ごとの
`role | toolName | canonical text` の `sha256-16`（JSON 形状のテキストはキーソ
ート+コンパクト化、散文は raw バイト保持；`toolCallId` と `contentType` リテ
ラルは除外、それらがまさに codec 横断で再エンコードされるトークンだから；
**reasoning は role 単独でフィンガープリント** —— responses アダプタは
provider アイテム id を core text として投影するので、それをハッシュすると
churn の最初の reasoning メッセージですべてのペアリングが壊れる）。Pass 0 は
churn 領域を head-first と tail-first で整列し、**フィンガープリントが整位列
合で一致した場合のみ**古いカバー済み id を新しい対応物に主張する；最初の不合
致でスキャン停止のため、履歴中段への挿入と削除は正直にブリッジを拒む。コピー
を持たないセッション（アップグレード時のインストールベース全体）は何も払わな
い：最初の定常 pass がコピーを保存し、*次の* drift が位置ベースで主張される —
— 「認識不能」自体が新しい数列なので、マイグレーションは無償である。

なぜこれが下の位置拒否と矛盾しないか：raw 位置は拒否された —— 旧バイトの記憶
がないとき、位置ベースの主張は**推測**であり誤帰属として失敗するから。コピー
は推測を、整列オフセットでの検証済み等価変換する —— 同じ公理を一段上で：
フィンガープリント不一致 → 正直な非認識（未マッチ、#1001/#1195 車線）、間違
った主張は絶対にない。検証マトリクスは `tests/identity-proof.test.ts` にある
（メカニズムレベル、judge 課金、`tests/cache-proof.test.ts` の後）：
4 wires × 3 phases（fold 確立 → id シーム+シリアライズ churn でもカバレッジ維
持 → 履歴中段編集は正直に再投入）、レイヤーなしでは churn が再課金することを
示す reconcile-off 対照、wire 横断クライアント交換（anthropic → chat）で端到端
カバレッジ維持、およびモデル切替フェーズ（#2636）：chat 車線が reasoning を
持つ assistant ターンと image を持つ user ターンを持ち、その後異形状モデル
（reasoning は pair→merged にインライン化、image はプレースホルダ化）へ履歴を
再生 —— カバレッジは形状 churn を生き残り、カバー済み thinking が再投入されな
いこと、churn 直後の最初の body で判定（新しいサーバー側 compress が失敗した
再生を再 fold しうる —— 修復された round-2 は保持証明の代役になってはならな
い）、加えてこの churn クラスがレイヤーなしで再課金することを示す独自の
reconcile-off 対照。

## snapshot-as-session 教義：id 上の判定クラス（#3641）

#2480 は fold coverage を検証付き位置ベースにした。#3641 は**どの**チャネルも
検証できなかった場合になにが起きるかを決着させた。反転：**(session id + fold
スナップショット) が会話本体**であり —— wire はそれの整列観測に過ぎない。
id・ハッシュ・形状はいずれもヒント；「私のブロックはどのメッセージを、どんな
順序でカバーしているか」が事実である。これを強いた本番クラスが三つ：語りは
そのままに全 id を再発行するプロトコル再シリアライズ（#3640）、テキストナシ
ファミリをプレースホルダへ書き換える image オフロード（#3588）、カバー済み
スライスを切り捨てるステートレスクライアント（#2695）—— 三者ともかつては
"substrate destroyed" と診断されていた。

仕組み（すべて `src/fold-reconcile.ts` 内+kernel の配置ルール 1 つ；証明テスト
は `tests/fold-anchor-doctrine.test.ts`）：

- **Shape tier**（順序保持）：カバー済み id の*大量*が一度に消えたとき
  （≥ `SHAPE_MASS_MIN`）、残存散文アンカーは編集誠実性ゲートの下で会話順に受
  信候補とペアリングする —— word-bag 等価 + simhash ≤ 8 + role + 長さガード
  （sim tier が gap に適用するのと同じゲートを、claim に適用）。テキストナシ
  アンカー（image ファミリ：構造上 sh/wh なし）は、両側で検証済み flank に挟ま
  れかつバケットごとの件数が厳密に一致する場合に第 k 対第 k でペアリングす
  る —— byImage 規律を bili 自身のプレースホルダ変種を超えて一般化したもの。
- **Residual census と判定クラス**：ラダーが主張できないものは*分類*され、破
  棄されたとは仮定されない。`shapeExplained`（変換：claim か near-dup の証拠
  が質量を持つ）—— info latch 1 つ、streak リセット。`truncationExplained`
  （無害な削除：残存物がどこにも不在、near-dup ゼロ、かつ **wire-continuity
  witness** —— 凍結された旧順サフィックスが依然として受信側を先頭に据える）
  —— reap ではなく snooze（#2695）。その他すべては drift として従来どおりエ
  スケレート。
- **Episode witness**：最初の drift pass で旧順の tail が凍結される
  （`foldEpisodeOrder`）；同一 session id 下の外国の会話にはそれとの連続性が
  ないため、一括置換が truncation を装えない。
- **Epoch-confirm ゲート**：全面崩壊は `foldEpochConfirmPending` を latch し、
  エラーを 1 回出し、preflight はリクエストを逐字通過させる —— folding は*一
  時的停止*；何も削除されず、何もサイレントにリセットされない。整列回復（ホ
  ストが真の履歴を再送）で latch は自動クリア。
- **Unresolved-anchor 配置**（kernel `prune.ts`）：アンカーがすべて解決失敗し
  たブロックは、tail ではなく最後の user メッセージに挿入される —— サマリー
  ブロックがユーザーの最新質問の *後* に乗ることがなくなった（#3640 の
  6 つの tail 乗りブロック）。

誠実性の境界は意図的なもの：shape tier は**厳密**な word-bag 等価を要求するた
め、系統的な content 変換 —— 例えばホストが履歴に末尾 `<system-reminder>` 接
尾辞を押印し直す —— は同じメッセージとして*主張されない*（曖昧な content
join は decompress で誤帰属する；下 拒否された代替案を参照）。そのようなイベ
ントは truncation か collapse として分類され、snooze/pause パスに乗る —— 何れ
もサイレントな再キー化はしない。一括同一接尾辞の再押印（N 個の順序安定ペアが
まったく同じ delta を共有）に独自の*検証済み*クラスを設ける価値があるかは未
解決の follow-up で、本番ログに対して規模を決める（#3640/#3588）。

互換性：教義はマッチング/判定レイヤーの変更 —— マイグレーションゼロ、新旧
セッションに一律適用、ストレージ非依存（legacy JSON、shadow と full モードは
挙動同一；簿記は session metadata に乗る）。kernel ledger の content-hash 契
約には触れていない。

## snapshot render エンジン：出站アイデンティティがサーバー側に移る（#3756）

#3641 はどのチャネルも検証できないときの判定を分類した。#3756 は出站パスに
おいて依存そのものを除去する：`snapshotRender` rollout 機能をオン（既定 0%、
`BILI_ROLLOUT_SNAPSHOT_RENDER`）にすると、prepare レイヤーはクライアントの再送
バイトから履歴を再構築しなくなり —— 出站プレフィックスをサーバー自身の統一
ストレージ transcript から描画する（`src/server/snapshot-render.ts`）：

- **Identity ladder、最終形。** 会話アイデンティティ = session バインディング
  （ネイティブ session id が存在するとき常にそれ —— §"Prefer native stable
  identifiers"）。ライブ会話内のメッセージアイデンティティ = サーバー
  スナップショット行（`seq`）、決して再発行されない。Content
  ハッシュ/シグネチャは**チェーンフォールバック証拠としてのみ**降格 ——
  クライアントの逐字 tail からサーバー prefix への引き継ぎ点（divergence
  point）を特定する（id fast path、`role|contentType|toolName|text` +
  image-length シグネチャフォールバック —— #3642 の正規形なので、全 id の再発
  行でもリンクされる）。
- **カバレッジはエンジンが自己所有。** カバー済み行はブロックの
  seq/signature カバレッジセットで抑制され；`acp_summary_*` アンカーはブロッ
  ク状態からその場で再描画される。エンジンはこれに reconcile ラダーの再キー化
  ブロック id を信頼しない —— reconcile は正当にブロックを新規発行クライアン
  ト id へ再キー化しうる（16384-anchor cap がその後それらを落とした #3752 の
  正確な失敗形状）。
- **Tail はクライアント逐字のまま。** join 点より上にあるものはすべてクライ
  エントが送ったままバイト単位で転送される —— 折り畳んでいない作業セットはク
  ライアント自身の言葉のまま、かつプレフィックスキャッシュ安定性がターン跨
  ぎで保たれる。巻き戻された行は join の下にあり決して描画されない。
- **Degrade、推測しない。** 機能オフ、アクティブブロックなし、ストレージ不可
  読、またはチェーンがリンクできない —— そのターン全体が legacy パスへ不変
  にフォールバックする。head のクライアント側チェックポイントは 1 ターン遅れで
  採用される（ビューは前ターンの観測）かつカバー済み行を復活させることは絶対
  にない。
- 構造的にこれで消滅するもの：#3752 anchor-cap 崖（MAX_ANCHORS × id 再発行 ×
  ステートレス再送）と #3751 image `_N` ファミリ churn —— いずれも折り畳まれ
  た履歴を落としたり重複させたりしなくなった、なぜなら描画プレフィックスは
  ブロック seq と content シグネチャに従い、クライアントバイトに従わないから。

#3641 の reconcile/判定レイヤーは残る：D がオフ・利用不可・降格している車線
のための安全網であり続け —— 観測チャネル（`reconcileFoldCoverage`）は依然とし
て CLIENT ビューを見ている（render と観測は意図的に別入力）。

## Image はペイロードアドレス指定であり、ファミリー番号ではない（#3751）

上記の `_N` インスタンス規律は、base id がすでに*これはどの content か*を区
別していると仮定している。Image は #3751 までその仮定を壊していた：全 image
core が同じ正規テキスト（`[image]`）を持ち、会話内の全 image が 1 つの共有
base にハッシュされ、`_N`  ordinal が位置ベースですべての区別をしていた。1
枚の image が変わった（オフロードプレースホルダ、再エンコード、削除）だけでそ
の全兄弟の ordinal がずれ、毎ターンファミリー全体が再発行された（#3748 の書
き込み増幅の供給源）。

修正は教義を維持しつつ隙間を閉じる：canonical seed に第 6 スロットが増えるが
media core のみ —— data image は `hash(imageBase64)`（両 codec と content CAS
がすでに保持するバイト）、URL 参照 image は URL 文字列（wire にバイトがない —
— 利用可能な唯一のアイデンティティが URL）、希少な legacy plural-sidecar
core は part フィンガープリントの順序付き結合。バイト同一 image が base id を
共有するのは意図的：`_N` は*真の重複*のための ordinal として残る（#459/#463
のインスタンス規律、本来設計された対象に適用）。1 枚の image が変わってもいま
は自分の core のみ再発行される。Text core はスロットを得ないので、非 image
id はアップグレード前後でバイト同一のまま。

## Hash 公理の既知のコスト —— そしてそれがどう修正されたか

同じバイト ⇒ 同じアイデンティティにはコスト面がある：#1476 —— ユーザーが折り
畳まれた既存 content と同一の短いテキストを再送；bare `h_` id が再導出；
`isCovered()` が新しいメッセージを飲み込む。修正の**方向**に注意：kernel
#459 はインスタンス番号付け（`_1/_2…`）を追加し、#463 は fold 後の**echo**
（id ∈ covered ∧ ∈ previous pass → id 保持、prune が飲み込む）と真の**新イン
スタンス**（id ∈ covered ∧ ∉ previous pass → 空き `_k` に番号付け直し）を区別
する `lastPassIds` スナップショットを追加した。Content ハッシュは base のまま；
上に重ねられたのはインスタンス識別のみ。Hash 公理自身のバグすら*hash を維持す
る*ことで修復され、位置ベース id への退却不是なのだ。

## 存在するがアイデンティティではない部分往復チャネル

#242 は両刃のエビデンスである。それは実在する store-and-replay チャネルがあ
ることを証明する（codex は response 側 `msg-proxy-*` id を rollout に永続化し
再生する）。同時にそのチャネルがアイデンティティとして使えないことも証明す
る：カバレッジは response 側アイテムのみ（user 側アイテムは id フィールドを持
たない）、upstream が namespace を制約する（64 文字上限、`rs` プレフィックス）
かつ 4 車線のうち 1 つにしか存在しない。現在の用途 —— round-2 ライフサイクル
整合性+ingress 剥離 —— が局所最適である。

## Tag は派生ビューであり、保存されたアイデンティティではない

`<acp:mNNNNN…>` tag は**egress**（モデル側向き）で ref map から出力され、**in-
gress** でホスト再生バイトから剥離される；`renderMessage()` は再描画前にその
メッセージ自身の古い tag を除去する（冪等）のに対し、外国 tag は content として
生き残る。アイデンティティは往復に乗らない：同じバイト → 同じハッシュ →
同じ ref → 同じ tag、全 pass で。

tag-echo 事故（#206/#295、#14、#673）はこれがこうでなければならない理由の実証
である。モデルは見える散文の中で描画されたマークアップを模することがある；
ホストはそれらのバイトを逐字保存して再生する；模倣が増幅する（1 つの保存メッ
セージが 77 個の echo tag + ~3,300 行の空行を蓄積 —— #14；タイプミスした tag
名 `acip` が 1 ターンの見える散文全体になった —— #673）。marker-to-storage
チャネルは実在するが**汚れている**：タイプミスし、増幅し、namespace づけが不
適切。あらゆる marker-as-identity 方式はアイデンティティをそのチャネルに賭け
ることになる。設計は漏洩した marker を剥離可能なノイズとして扱い
（`src/loop/tag-echo-filter.ts`、散文のみ —— tool-call arguments は決して剥が
さない、#1039）、アイデンティティをバイトから再導出する。

## Upstream が往復を要求する唯一の場所：strict-echo reasoning

DeepSeek 系のゲートウェイは、ゲートウェイ自身が出した reasoning アイテムをク
ライアントが返すことを要求する（"the reasoning content from the previous turn
must be passed back in thinking mode"）。これは艦隊内唯一の強制 content 往復
であり、bili の扱いはパターンを示す：それは**修復可能な形状制約**として扱われ
アイデンティティではない —— #762 は chat wire に空白 `reasoning_content` を注
入し、#1479/#1482 は Responses wire と loop リトライパスへの修復を拡張、すべて
`isStrictReasoningEcho`（学習済み 400 フラグまたは deepseek origin/model）で
ゲートされ thinking なしセッションはバイト同一のまま。アイデンティティ簿記は
一切関与しない。

## 拒否された代替案

| Direction | 拒否理由 |
|---|---|
| ホストストレージが運ぶ ingress 割当 id | 3/4 車線に運搬フィールドなし；4 車線目は provider namespace 拒否（#242、#1475）；カバレッジは ingress ではなく re-join で測定（上記のホスト別テーブル）。 |
| 位置/シーケンスを join キーに | プレフィックス不安定性は 6 つの事故クラスにわたって文書化済み（#1148、#1102、#1307、#1247、ホスト `/compact`、我々の fold 自身）；失敗モードはサイレント誤帰属。**Ledger join** については依然正しい；#2480 は position を**自己保存正規コピー付き**で fold-coverage レイヤーにのみ採用、位置ごとの検証が推測を取り除く —— 上記参照。 |
| Content への near-match 許容 | バイト完全一致が荷重を支えている（`session-identity.md` と同じ論理）；曖昧な join は decompress でサイレントに誤帰属する。 |
| `msg-proxy-*` をアイデンティティに昇格 | 単一車線、response 側カバレッジのみ、増幅しやすいチャネル（tag-echo 証拠）、upstream namespace 制約。 |
| Marker-as-identity（ホストが tag を永続化） | tag-echo 事故はそのチャネルが運ぶものを壊すことを示す；現在の設計は両端ですでに剥離済み。 |
| ホスト書き換え tool-call id の暗黙エイリアシング | 欠けたカバー済み id を、異なる toolCallId で同一 content の受信双子と対応づけるにはホスト知識が必要；なければ主張は推測となり decompress で誤帰属する（#2396：Prime が provider 切替で複合 id を書き換え）。検出のみが出荷；修正はホスト境界に属する（plugin-protocol.md obligation 5）。#2480 更新：Pass 0 がそのホスト知識（位置+保存正規フィンガープリント）を供給するので、このクラスはカウントだけでなく主張される；より早く正規化できるホストには plugin-protocol.md obligation 5 が効力を持つ。 |

## 将来の方向

あの問いはプラグイン車線で今は答えられている：安定 id を保証できるホストはそ
れを送る（#4491 msgid エンベロープ、上記）；存在するときそれは ledger
アイデンティティとして order と hash より優位になる（#4834 id-first 解決）—
— content-hash は三段組キーの安全帯であり続ける。id を保証できないホスト（そ
して id を持たない model wire 自身）は content-hash base を維持する。将来のホ
ストや車線が真に安定したクライアント側メッセージ id を提供しても、それは hash
ベース車線において**追加の join ヒントとしてのみ**採用されうる —— LEDGER
join の content-hash base の代替としては決してならない。OUTBOUND join は別問
題でありすでに答えがある：`snapshotRender` オンでは出站プレフィックスはサー
バー スナップショット `seq` でキー化される（#3756、上記）し、content-hash
ラダーは join 点を特定するチェーンフォールバックとして機能するのみ。総括：
bytes がアンカー、hashes が ledger join、`seq` が render join（rollout
gate）、mNNNNN が ledger、tags が view。

関連：#1496（本文書の契機）、`session-identity.md`（セッション粒度）、#1476 +
kernel #459/#463（echo 識別）、#242/#1475（Responses id 制約）、#206/#673
（tag echo）、#1479/#1482（strict-echo 修復）、#1039（tool-call バイト完全一
致の不変条件）、#2396（provider 切替でのホスト書き換え tool-call id）、#2480
（位置ベース fold coverage；`tests/identity-proof.test.ts` がその証明マトリク
ス）、#2695/#3588/#3640/#3641（snapshot-as-session 教義；
`tests/fold-anchor-doctrine.test.ts`）、#3642（正規 cross-protocol
アイデンティティ —— チェーンフォールバックのシグネチャ形）、#3756（snapshot
render エンジン；`tests/snapshot-render.test.ts`）。
