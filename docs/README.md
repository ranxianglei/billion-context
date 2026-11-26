# Documentation

All system documentation for **billion-context** lives in this directory. The repo root keeps only four **core** entry files — `README.md`, `README.zh-CN.md`, `AGENTS.md`, `CHANGELOG.md` — and recognized community-maintained README translations (`README.<locale>.md`, e.g. `README.ja.md`, approved 2026-11-09, #6000). Former root doc paths keep one-line redirect stubs at the root (tracked in [lifecycle §5](lifecycle.md#5-卫生记录)).

> **Full catalog:** [index.md](index.md) / [index.zh-CN.md](index.zh-CN.md) — every doc with a one-line description. This page is the directory landing: where things are and which rules keep them live.

## Sections

| Section | Docs | What you'll find |
|---|---|---|
| **Start here** | [configuration](configuration.md) · [clients](clients.md) · [how-it-works](how-it-works.en.svg) | Full configuration reference (generated, drift-guarded) · per-client integration deep dives · one diagram of the whole flow |
| **System architecture** | [architecture](architecture.md) / [中文](architecture.zh-CN.md) | **LIVE hub**: overall diagram + one page per module (pipeline / lanes / kernel / identity / fastpaths / storage / webui / update), each with its own diagram — freshness is CI-enforced (`architecture-docs` lane) |
| **Identity & protocol** | [message-identity](message-identity.md) · [session-identity](session-identity.md) · [session-identity-resolution](session-identity-resolution.md) · [identity-channels](identity-channels.md) · [msgid-infrastructure](msgid-infrastructure.md) · [opencode-responses-websocket](opencode-responses-websocket.md) · [plugin-protocol](plugin-protocol.md) | The identity doctrine (msg id, session id, persona forks, the #5825 channel wiring) and per-client protocol notes |
| **Engineering & operations** | [technical-notes](technical-notes.md) · [lifecycle](lifecycle.md) · [auto-merge-guardrails](auto-merge-guardrails.md) · [unified-loop-spec](unified-loop-spec.md) | Mechanism deep-dives · the transition/retirement ledger (CI-enforced) · the evidence appendix behind `AGENTS.md` §7 · historical design (superseded by code) |

## Rules of the road (why this directory stays readable)

1. **Bilingual by default** — English base name + `*.zh-CN.md` mirror; a single-language doc must say why in its [index](index.md) entry.
2. **Every new or moved doc is listed in [index.md](index.md) + [index.zh-CN.md](index.zh-CN.md) in the same PR** — an unlisted doc does not exist.
3. **Architecture docs are LIVE** — structural changes update the affected page, diagram, and hub ledger row in the same PR; CI lane `architecture-docs` enforces the mechanical parts.
4. **Procedures live in [`../reference/`](../reference/README.md), not here** — `docs/` is decision/reviewer-facing reference; `reference/` holds the lazy-loaded how-to material (testing / release / git-pr / env-vars / the KDD full-text ledger).
5. **Moves leave a stub** — a one-line redirect at the old path + a hygiene-ledger entry in [lifecycle.md](lifecycle.md) §5 with an explicit removal condition.

The authoritative wording of these rules: [`AGENTS.md` §3 "Documentation Layout"](../AGENTS.md).
