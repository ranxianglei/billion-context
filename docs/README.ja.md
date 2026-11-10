# ドキュメント

**billion-context** のシステム文書はすべてこのディレクトリに集約されています。リポジトリのルートには 4 つの**コア**入口ファイル——`README.md`、`README.zh-CN.md`、`AGENTS.md`、`CHANGELOG.md`——と、承認済みのコミュニティ維持 README 訳本（`README.<locale>.md`、例 `README.ja.md`、2026-11-09 に承認、#6000）のみを保持します。旧ルート文書パスはルートに一行的なリダイレクト用プレースホルダを残します（追跡は [lifecycle §5](lifecycle.md#5-卫生记录)）。

> **全カタログ:** [index.md](index.md) / [index.zh-CN.md](index.zh-CN.md) — 全文書を一行説明付きで一覧。このページはディレクトリの落地ページで、何がどこにあるか、そして何を live に保つかというルールを示します。

## セクション

| セクション | 文書 | 中身 |
|---|---|---|
| **ここから始める** | [configuration](configuration.md) · [clients](clients.md) · [how-it-works](how-it-works.en.svg) | 全量設定リファレンス（生成物、ドリフトガード付き） · クライアント別統合の深掘り · フロー全体を一枚の図で |
| **システムアーキテクチャ** | [architecture](architecture.md) / [中文](architecture.zh-CN.md) | **LIVE hub**: 全体図 + モジュール毎の一ページ（pipeline / lanes / kernel / identity / fastpaths / storage / webui / update）、各々に独自の図を掲載 — 鮮度は CI が強制（`architecture-docs` レーン） |
| **アイデンティティとプロトコル** | [message-identity](message-identity.md) · [session-identity](session-identity.md) · [session-identity-resolution](session-identity-resolution.md) · [identity-channels](identity-channels.md) · [msgid-infrastructure](msgid-infrastructure.md) · [opencode-responses-websocket](opencode-responses-websocket.md) · [plugin-protocol](plugin-protocol.md) | アイデンティティ教義（msg id、session id、persona フォーク、#5825 のチャンネル配線）とクライアント別プロトコル注記 |
| **エンジニアリングと運用** | [technical-notes](technical-notes.md) · [lifecycle](lifecycle.md) · [auto-merge-guardrails](auto-merge-guardrails.md) · [unified-loop-spec](unified-loop-spec.md) | 機構の深掘り · 移行/退役台帳（CI 強制） · `AGENTS.md` §7 裏のエビデンス付録 · 歴史的設計（コードにより置き換え済み） |

## ルール（このディレクトリが読みやすい状態を保つ理由）

1. **既定バイリンガル** — 英語ベース名 + `*.zh-CN.md` ミラー;単一言語の文書はその理由を [index](index.md) エントリに明記すること。
2. **新規または移動した文書はすべて同じ PR で [index.md](index.md) + [index.zh-CN.md](index.zh-CN.md) に記載** — 未記載の文書は存在しないものと同じ。
3. **アーキテクチャ文書は LIVE** — 構造変更は影響するページ・図・hub 台帳行を同じ PR で更新;機械的な部分は CI レーン `architecture-docs` が強制。
4. **手順は [`../reference/`](../reference/README.md) に置く** — ここではなく。`docs/` は意思決定/レビューア向けのリファレンス;`reference/` は遅延読み込みの how-to 資料（testing / release / git-pr / env-vars / KDD 全文台帳）を保持。
5. **移動はスタブを残す** — 旧パスに一行的なリダイレクト + [lifecycle.md](lifecycle.md) §5 に明示的な削除条件付きの衛生台帳エントリ。

これらのルールの権威ある文言: [`AGENTS.md` §3 "Documentation Layout"](../AGENTS.md)。
