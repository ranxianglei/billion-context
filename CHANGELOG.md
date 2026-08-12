# Changelog

All notable changes to **billion-context** are documented here.
Versions follow the merge of a `*_release-v*` branch; CI publishes to npm on tag.

## [0.1.36] — 2026-08-12

### Fixes

- **Round-2+ streaming after a tool call** (#122): `runCompressLoop` forwarded round-1 text to the client in real-time but **buffered** round-2+ text (the re-request round, emitted after the model calls `compress`/`acp_status`/…) and flushed it all at once when the stream completed — so the first token after a compress tool call appeared to hang. Round-2+ non-text-protocol text now streams per-delta (`yield adapter.emitText(ev.delta)`). The text-protocol path still buffers (marker extraction needs the whole text).

### Tests

- **L2 end-to-end proxy smoke test** (#122): `tests/e2e-proxy-smoke.test.ts` spins up the real `startServer` + a stub upstream. Round 1 returns a `compress` tool_call (bili intercepts → re-request); round 2 returns text deltas 40 ms apart. Asserts the upstream saw ≥2 requests (re-request happened), the client received the full text, and round-2 chunks span ≥50 ms (real-time streaming, not buffered). Model-free, deterministic, CI-friendly — would have caught the round-2 buffering bug.

## [0.1.35] — 2026-08-12

### Features

- **Cert-MITM launcher (`bili pi` / `bili codex` / `bili claude` / `bili test pi`)** (#98): one command auto-spawns a local bili proxy with MITM root-CA, redirects the client through it, and tears it down on exit. Discoveries are read from each client's config (Claude `~/.claude/settings.json`, Codex `~/.codex/config.toml`, Pi `~/.pi/agent/models.json`); HTTPS providers go through cert-MITM, HTTP providers through `/bili/` rewrite. `bili pi-test` runs an extension-free Pi (no double-compression with the billion-context-pi adapter).
- **Codex Responses: read-only ACP tools as real function tools** (#120): `acp_status`, `search_context`, `decompress` are now injected as Responses `tools` (codex's `additional_tools` preserved). `compress` is also a function tool. Per-URL `compressProtocol: "tools" | "marker"` in the `providers` route config (default `tools` for all upstreams; set `"marker"` to force text markers).

### Fixes

- **Compress death-loop (definitive)** (#120): `hideConsumedCompressCalls` was hiding failed compress *attempt records* (call + result), blinding the model — it reset to "attempt 1" every round and looped to `MAX_LOOP_ROUNDS`. Now failed compress/decompress records stay visible so the model can count attempts, adapt, and stop with a report. Proxy-tool results (success or failure) are fed back as standard `function_call_output` (Responses) / tool-result (other protocols).
- **Removed wrong guards & directives** (#120): the `mutatedThisTurn` (compress) / `readOnlyCalled` (acp_status) one-call guards and the proxy's `"Do not retry the same range."` directive were removed — they blocked legitimate multi-range compress and sent the model into retry spirals. The kernel's correct `"Combine more messages"` guidance is kept.
- **Strip redundant in-place `acp_summary`** (#102): the host now strips the kernel's generic in-place summary markers (it relies on the compress tool-call as the record), preventing mid-stream insertion that broke prompt-cache prefixes.
- **Code-review bug batch** (#113): `registry.ts` ESM `statSync` import (24 h TTL was never honored), `logger.ts` rotation writing to an ended stream, `persist.ts` `flushAll` missing in-flight write chains (shutdown data loss), `server.ts` dump WriteStream with no error listener, `update.ts` unbounded tarball buffer (OOM) — now streamed with a 100 MB cap.

## [0.1.34] — 2026-08-11

- Bump `acp-kernel` to **0.0.19** (fixed 50 K nudge growth).
- Aborted-loop / drain-race / session-inFlight-race fixes (#109), Responses non-stream guard + `MAX_LOOP_ROUNDS` (#110), env-proxy-by-default + port validation + bounded session pool (#111), decompress temp-file reaper (#112), `acp_status` compressible-ranges in default overview (#103), visibility-marker role `developer` (#106), V1 streaming loops removed + forward-header/route dedup (#108).
