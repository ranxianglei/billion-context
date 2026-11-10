# Documentation Index

> All system documentation lives under `docs/`. The repo root keeps only four **core** entry files — `README.md`, `README.zh-CN.md`, `AGENTS.md`, `CHANGELOG.md` — and recognized community-maintained README translations (`README.<locale>.md`, e.g. `README.ja.md`, approved 2026-11-09, #6000). Former root doc paths keep one-line redirect stubs (scheduled for removal after 1–2 releases; tracked in [lifecycle §5](lifecycle.md#5-卫生记录)).
> Lazy-load procedures (architecture / env-vars / testing / release / git-pr): [reference/](../reference/README.md).

## Start here

| Doc | What it is |
|---|---|
| [README](../README.md) / [中文](../README.zh-CN.md) / [日本語](../README.ja.md) | Project entry: what it is, quickstart, architecture overview |
| [architecture](architecture.md) / [中文](architecture.zh-CN.md) | **System architecture hub** (LIVE doc, owner ruling 2026-11-08): overall diagram + per-module pages, each with its own diagram — see `docs/architecture/` |
| [configuration](configuration.md) / [中文](configuration.zh-CN.md) | Full configuration reference (generated from `website/config-reference/*.yaml` by `tools/gen-config-docs.mjs`; hand-written sections are drift-guarded) |
| [clients](clients.md) / [中文](clients.zh-CN.md) | Per-client integration deep dives: how each mode (launcher / `/bili/` / native plugin) wires traffic in |
| [how-it-works](how-it-works.en.svg) / [中文](how-it-works.zh-CN.svg) | One diagram: request flow + the injected context tools |
| [README](README.md) / [中文](README.zh-CN.md) / [日本語](README.ja.md) | Directory landing page: section map + the rules that keep this directory live |

## Identity & protocol

| Doc | What it is |
|---|---|
| [message-identity](message-identity.md) / [中文](message-identity.zh-CN.md) / [日本語](message-identity.ja.md) | Message identity doctrine: content hash as cross-turn join key, order > hash, msgid rung, snapshot render |
| [session-identity](session-identity.md) / [中文](session-identity.zh-CN.md) / [日本語](session-identity.ja.md) | Which session an *anonymous* request belongs to |
| [session-identity-resolution](session-identity-resolution.md) / [中文](session-identity-resolution.zh-CN.md) / [日本語](session-identity-resolution.ja.md) | Which *conversation* a known client session id belongs to (same id, different conversations) |
| [identity-channels](identity-channels.md) / [中文](identity-channels.zh-CN.md) / [日本語](identity-channels.ja.md) | Cross-client stable conversation+message id wiring (#5825): who carries identity in, where it is consumed |
| [msgid-infrastructure](msgid-infrastructure.md) / [中文](msgid-infrastructure.zh-CN.md) / [日本語](msgid-infrastructure.ja.md) | Where sessionid+msgid is produced, validated (six copies), pinned, and consumed |
| [opencode-responses-websocket](opencode-responses-websocket.md) / [中文](opencode-responses-websocket.zh-CN.md) / [日本語](opencode-responses-websocket.ja.md) | OpenCode V2 Responses-over-WebSocket integration (#1844) |
| [plugin-protocol](plugin-protocol.md) | Cooperative plugin protocol v2 (experimental) |
| [wire-contracts](wire-contracts.md) / [中文](wire-contracts.zh-CN.md) | WC ledger: permanent upstream wire constraints behind the declared custom-wire endpoints (#1295); entries are never deleted, only superseded |

## Engineering & operations

| Doc | What it is |
|---|---|
| [technical-notes](technical-notes.md) / [中文](technical-notes.zh-CN.md) | Large compendium of mechanism deep-dives (wire behavior, compression modes, fastpaths) |
| [lifecycle](lifecycle.md) | Transition-switch ledger / retirement inventory / hygiene record (CI-enforced `BILI_*` coverage) |
| [auto-merge-guardrails](auto-merge-guardrails.md) | Evidence appendix behind §7 of `AGENTS.md` (AI auto-dev review history) |
| [unified-loop-spec](unified-loop-spec.md) | Historical design: unified compress-loop spec (implemented; code is the source of truth) |
