# Changelog

All notable changes to **billion-context** are documented here.
Versions follow the merge of a `*_release-v*` branch; CI publishes to npm on tag.

## [0.1.40] — 2026-08-13

### Features

- **Three-level compression tuning** (#124): the `compress` block now merges **per field, deepest wins** at three levels — global → per-provider → per-model. An unset field at a deeper level never clears a value set higher up, so you can pin a global `nudgeGrowthTokens` and still override `modelContextLimit` for one model on one provider without re-declaring the rest. Lets you tune when/where compression fires without forking the whole config per model.

### Fixes

- **Windows `bili codex` ENOENT** (#134): npm globals install as `.cmd`/`.bat` shims on Windows, and Node `spawn` can't resolve a bare name to them (CVE-2024-27980). `resolveClientCommand` now resolves the full `.cmd`/`.bat`/`.exe` path via `resolveOnPath` (using `path.delimiter`, was hardcoded `:`) and spawns with `shell:true` on win32. Fixes `spawn codex ENOENT` for all `bili <client>` launchers on Windows.
- **DeepSeek thinking 400 after compression** (#133): the root cause is in acp-kernel — an assistant turn's `reasoning_content` (emitted as a separate `contentType:"reasoning"` message) could be split from its companion text/tool-call by a compress range, leaving an orphaned half that DeepSeek-thinking rejects with HTTP 400 `"reasoning_content in the thinking mode must be passed back to the API."`. Bumps **acp-kernel to 0.0.23**, which mirrors the existing tool-pair mechanism: `adjustBoundariesForReasoningPairs` expands the compress range so the pair always compresses together, `stripOrphanedReasoning` is a rebuild safety net, and `applyPairBoundaryAdjustments` composes both to a fixpoint. The same latent class is fixed on the Anthropic and Responses paths too.
- **textProtocol suppresses only message items, preserves reasoning/image lifecycle** (#94): the text-protocol stream filter was dropping `reasoning` and `image` content along with the message items it meant to suppress, breaking their lifecycle. Now only `message` items are suppressed; reasoning and image blocks pass through unchanged.

## [0.1.39] — 2026-08-13

### Fixes

- **OpenAI non-compliant `finish_reason="stop"` for tool-call responses** (#131): some OpenAI-compatible upstreams (e.g. the model behind openclaw) return `finish_reason="stop"` for a text + tool_calls response, violating the OpenAI Chat Completions spec (which requires `"tool_calls"`). bili faithfully re-emitted `"stop"`, and the downstream parser (openclaw `openai-transport-stream`) dropped **all** `tool_call` chunks because `hasVisibleText=true` kept `stopReason=stop` — so tool calls were silently lost and the model "replied once and stopped". bili now rewrites the non-compliant `"stop"` to `"tool_calls"` when the streamed response emitted tool calls; compliant `"tool_calls"`, text-only `"stop"`, and `"length"` are unchanged.

## [0.1.38] — 2026-08-13

### Fixes

- **OpenAI `reasoning_content` round-trip for thinking-mode models** (#129): OpenAI-compatible reasoning models (DeepSeek-R1, GLM-4.6 thinking, Qwen-QwQ) emit `reasoning_content` (chain-of-thought) and require it be echoed back on subsequent requests — without it the upstream returns HTTP 400 `The reasoning_content in the thinking mode must be passed back to the API.` bili's OpenAI adapter dropped it (Anthropic `thinking` and Responses paths already handled it). Now `openaiToCore`/`coreToOpenai` round-trip `reasoning_content` through a `contentType:"reasoning"` core message; the streaming adapter captures `delta.reasoning_content`; re-request reconstruction re-emits it so the model never sees a missing-CoT 400. Also fixed double-forwarding when a single chunk carried both `reasoning_content` and `content`.

## [0.1.37] — 2026-08-13

### Features

- **MITM domain auto-discovery** (#125): bili now reads client configs (`~/.zcode/v2/config.json`, `~/.codex/config.toml`, `~/.pi/agent/models.json`, `~/.claude/settings.json`) and auto-builds the MITM whitelist from all discovered HTTPS provider hostnames (mtime-cached, re-scanned on change). No more hardcoded domain assumptions — `open.bigmodel.cn`, `zcode.z.ai`, `api.z.ai` are now discovered, not baked in. Defaults reduced to the three binary-hardcoded endpoints (api.anthropic.com / api.openai.com / chatgpt.com) that have no config file to discover from.

### Fixes

- **Anthropic round-2 streaming framing (vertical-text bug)** (#126): after a proxy tool/compress re-request, round-2 streamed text rendered as vertical text (each ~2-char chunk on its own line). `runCompressLoop` round-2 text now carries the Anthropic `content_block_start/delta/stop` framing with the correct client index. Regression test added.
- **HTTP-proxy-mode absolute URLs** (#127): bili concatenated its default anthropic upstream with the full absolute request URL in HTTP-proxy mode (`https://api.anthropic.comhttp://127.0.0.1:18081/…`). Absolute URLs (e.g. a local model server) are now forwarded to the host in the URL instead of mangled.

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
