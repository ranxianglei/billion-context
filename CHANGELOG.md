# Changelog

All notable changes to **billion-context** are documented here.
Versions follow the merge of a `*_release-v*` branch; CI publishes to npm on tag.

## [Unreleased]

### Fixes

- **Upstream proxy: unset mode now means "direct", not env auto-detect (#346)**: the web UI advertises 直连（默认） for an unset `upstreamProxyMode` (the radio defaults to `direct`) and ZCode's own default is `mode:"direct"`, but the code parsed an unset mode as "no preference" and fell through to env/system proxy auto-detection (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`, then the Windows system proxy). A user who never configured a proxy could therefore silently have bili route the upstream through whatever proxy was in the environment (e.g. Clash), changing the egress IP — which breaks IP-bound OAuth on domestic endpoints (the #346 ZCode 401/slow symptom) and contradicts the UI. Unset mode now resolves to `direct` (an empty global proxy short-circuits to direct instead of env discovery). To follow the system/env proxy, set mode `auto` explicitly (web UI 自动（跟随系统） or `BILI_UPSTREAM_PROXY_MODE=auto`); an explicit proxy (`-F` / `BILI_UPSTREAM_PROXY` / config) still wins regardless of mode. A deduped `[upstream-proxy] <host> via <proxy> (source=<source>)` log line (non-public hosts masked per #255) now makes the resolved proxy visible instead of silent.

- **Logger: rotated log file orphan inode — writes silently drift to `.old` (#210)**: the logger holds a single `WriteStream` (`flags: "a"`) for the life of the process, so once `bili.log` is renamed to `bili.log.old` (internal 10MB rotation, logrotate, a manual rename) the fd points at the renamed inode and every subsequent line lands in `.old` while the fresh `bili.log` sits at 0 bytes until restart — and no `error` event ever fires, because the orphaned fd is still valid, so the old error/writable-based recovery never triggered. The logger now compares the fd's inode (`fstat`) with the current path's inode (`stat`) on every write and, on divergence, explicitly closes the old stream (`end()` first so buffered lines drain into the rotated file) and reopens against the current path. When a (re)open fails (disk full, perms, path clobbered), logging degrades to stderr-only with a single `[warn]` instead of crashing the proxy — both for runtime reopens and the startup `configureLogger` open. Tests: external-rename simulation (new file receives subsequent lines, `.old` frozen), reopen-failure degradation (exactly one warn, no crash), and the internal 10MB rotation regression.
- **Tag-echo filter strips truncated tag fragments (#294)**: the streaming tag-echo filter only stripped complete render tags, so a model echo cut off mid-stream (tag split across SSE chunks) left junk fragments in the output — and the unbounded lone-opening match could swallow an entire message that merely started tag-like, stripping it to empty. Now: (1) a definite unterminated opening (tag name + space, no closing `>` yet) is held across chunks up to 4096 chars instead of being passed through once it grew past the old 128-char hold cap, and dropped (with a warn) beyond that; (2) `flush()` at stream end drops arbitrary truncated openings (including an unclosed `tokens=` quote) and drops content swallowed after an unclosed attrs-bearing opening — a dangling ref fragment is tag content, not prose; (3) the lone-opening match is bounded to 256 chars of attrs, so prose that merely starts with a tag-like opening and contains a `>` later is no longer swallowed up to that `>` (the whole-message-stripped-to-empty case). Ambiguous short prefixes (`<`, `<a`, `</ac`, bare tag name without space) keep the small hold cap and are emitted at flush, so real prose is never delayed or lost; non-streaming JSON rewriters get the same fragment handling.
- **Identity plugin binding survives model switches (one conversation, many sessions)**: an identity registration (`POST /__bili/plugin/register` with `identity: true` — the omp/claude-code path) was consumed one-shot: the first request that carried the conversation id ate the registration and bound ITS session into plugin mode. Switching models or upstreams mid-conversation resolves a NEW session (session key = protocol|upstream|apiKey|conversation) — the registration was already gone, so the omp TUI flow "chat model → responses model" silently dropped back to wire injection (native tools gone, model roleplaying `acp_status` output). Identity registrations are now sticky for the conversation: every request carrying the id binds, LRU-refreshed and bounded by the same 64-entry cap. Wild-caught as "原生模式消失了" after a GLM-chat → qwen-responses model switch.
- **Responses: stamp `type:"message"` on type-less input items at ingress.** omp (pi-ai) sends user items without the spec-required `type` field; the kernel wire projection switches on `item.type` and silently dropped them, so user prompts never entered the compression state (no refs, never tagged, never compressible, invisible to nudge/preflight — #247 testing caught this).

### Features

- **`-F <url>` gost-style forward flag for the upstream proxy (#346)**: `bili -F http://host:port <client>` (and `bili -F ... start`) sets bili's upstream proxy for that run, mirroring gost's `-F/--forward`. HTTP/HTTPS proxies only for now (SOCKS5 is a follow-up). bili flags must precede the client name — everything after the client name is forwarded to the client; the launcher already isolates bili from the shell's proxy env, so `-F` is the explicit way to give a launched proxy an upstream. Also fixes the misleading `bili pi --mitm-domain ...` help example (that form forwarded the flag to the client; the working form is `bili --mitm-domain ... pi`).

- **Launcher-handed context windows (`BILI_LAUNCHER_MODEL_WINDOWS`)**: `bili <client>` launchers already read the client's own model config when rewriting endpoints — they now also capture each model's declared context window (pi `models.json` `contextWindow`, omp `models.yml` `contextWindow`, opencode `opencode.json` `models.<id>.limit`, codex `config.toml` `model` + `model_context_window`) and hand the map to the spawned proxy via the `BILI_LAUNCHER_MODEL_WINDOWS` env var. The proxy ranks it between the plugin report and the models.dev registry in the native-window chain, so a self-hosted model named like a known family (`qwen3.8-27b` → table guessed 128k) no longer gets the built-in table's denominator — the nudge percent reflects the client's real window (262k in the wild-caught case, where an omp session was being compressed at 29% real usage because the proxy computed 81% against a wrong 95k denominator). No user configuration needed; only the launcher sets the env.
- **`bili omp` zero-config native plugin with native tools (`-e` + `loadMode: "essential"` + identity register)**: omp does NOT ship the bili plugin — the native experience previously depended on `bili plugin install omp` having been run (and silently degraded when the config entry was later removed, which is how a long omp session ended up at 92% context with zero compressions). The omp launcher branch now mirrors pi: when the config carries no loadable bili entry it prepends `-e dist/agent/omp.js` (loads for this run only, writes nothing); a loadable entry is left alone, stale entries do not suppress the injection. Two omp-specific mechanics make the plugin fully native there: (1) omp 17.x mounts extension tools that omit `loadMode` under its `xd://` device URLs — invisible to the model's main turn (verified on 17.3.8: only omp's internal title request ever saw them) — so the plugin registers its tools with `loadMode: "essential"`, putting `compress`/`decompress`/`search_context`/`acp_status` directly in the main turn's tools array (pi upstream ignores the extra field); (2) omp's fork emits no `before_provider_headers`, so the plugin binds the conversation through the launcher identity register (`POST /__bili/plugin/register` with omp's session id, which equals the requests' `prompt_cache_key`/`x-session-id`) — bound sessions run in plugin mode: native tools, wire injection suppressed, `/acp` panel available. pi/opencode are unchanged (they stamp headers per request).
- **Customizable compression prompts** (#156): the `compress` block now accepts `prompts` — an override object for the compression prompt text (`compressPhilosophy`, `howToCompressRules`, `tier2DistillRules`, `tier3CondenseRules`) — merged sub-field-wise across the three config levels (global → provider → model) and applied consistently to the system prompt, the nudge text, and the compress loop. Because the kernel's default rules are load-bearing (tuned over months of production use), overrides are **inert until `acknowledgePromptsRisk: true`** is set at the winning level; without it they are ignored and a one-time warning is logged. Non-string fields are silently dropped. Mainly useful for non-English or small-model prompt tuning.
- **hermes launcher (#223)**: `bili hermes` wraps the hermes-agent (Nous Research) — cert MITM is impossible (httpx builds its own CA bundle from certifi and ignores `SSL_CERT_FILE`), so every upstream is rewritten to the `/bili/` form in an isolated `HERMES_HOME` whose `config.yaml` is a rewritten temp copy (skills/memories/sessions stay shared via symlinks; the real `~/.hermes` is never touched; CRLF endings preserved). Warns clearly when no provider endpoints are found or the config can't be rewritten — traffic then bypasses the proxy visibly instead of silently.

### Fixes

- **Strip model-emitted render tags from plugin-mode passthrough responses**: the plugin-mode direct-pipe path replayed the upstream stream verbatim, bypassing the tag-echo stripper that only lives in the compress-loop stream path — an omp native-mode session (PR bringing omp into plugin mode) re-ingested the model's fake `<acp>` tags verbatim, seeded a tag-echo loop in a fresh session, and crowded out real prose. Responses plugin passthrough now runs the same tag-echo filter (delta-level state machine, done-event payloads flushed and stripped); other events stay byte-identical. The non-streaming plugin JSON path strips the same tags for Responses bodies (parity with the compress loop's JSON branch); a held tag-echo tail is flushed as a final delta if the stream is cut without a done-family event, so prose is never silently lost; multi-line `data:` payloads (never emitted by real upstreams) collapse into the single rebuilt line instead of fusing two JSON payloads.
- **Drop whitespace-only Responses message items at ingress (flattened-turn artifact)**: Responses-API clients that flatten a mixed turn (text + tool calls) into separate `input` items — omp does this, one message item per text block — replay the model's pre-tool-call whitespace (`\n\n`) as standalone 1-token messages. bili then stamps each with a 42-char `<acp>` render tag plus a ref id, a 10x payload bloat of pure noise, and the tag makes the empties sticky (they replay as "non-empty" tag+whitespace forever after). The proxy now strips render tags and drops message items whose remaining text is pure whitespace before projection; tagged real content is never touched. Applies to all Responses clients (pi keeps its block-array structure and is unaffected).

- **Double compress per turn (stale post-compress usage, #252)**: the post-compress re-request deliberately re-sends the UNFOLDED history (prefix-cache friendly — 96% cache hits observed), so its upstream usage report still carries the pre-compress size. That report overwrote `lastInputTokens`, and the nudge gate on the client's NEXT request re-evaluated the stale number → injected the compress philosophy again → the model compressed a second, tiny range in the same logical turn. Compress savings are now tracked as a per-turn credit: `applyRanges` nets them out of `lastInputTokens` immediately, every usage recorder (wire loop, plugin passthrough, non-streaming JSON) nets the credit out of raw reports, and the next request's `processTurn` — where the fold actually materializes — clears it. If the context is genuinely still over-limit after a compress, the nudge still fires (that is correct behavior); cumulative `inputTokens` billing stats stay raw.
- **omp/stateless Responses sessions never compress (prompt_cache_key identity)**: clients that replay full history statelessly with no conversation headers (omp without its plugin loaded) fell through the identity chain to a hash of the ENTIRE input array — which changes every turn, so every request minted a brand-new session (`requests: 1` on dozens of 90%+-full session files). The nudge evaluates token counts BEFORE the first forward of a session, so it always saw 0 tokens (`usage=0%, growth 0 < floor`) and never fired: contexts sat at 92% with zero compressions, while the upstream cache affinity also churned every turn. The Responses `prompt_cache_key` (the client's own stable conversation id) now replaces that fingerprint — real headers, body `session_id`, and `previous_response_id` still win; only the per-request fingerprint fallback is upgraded.
- **acp-loop replay auto-retry on upstream risk-control rejections** (#189): after a `compress`, the acp-loop replay request can be rejected by provider risk-control — GLM Coding Plan returns `400 {"code":3007,"msg":"captcha verify failed"}` ~1s after the big context rewrite — and the error was passed straight into the agent session as `[acp-proxy: compress loop upstream error 400: ...]`. The replay request (both the streaming loop and the Responses-API JSON loop) now retries transient upstream failures with exponential backoff: up to 3 attempts total, base delay 1500ms doubling per attempt, overridable via `BILI_REPLAY_RETRY_BASE_MS` (ms; `0` disables the delay). Transient = HTTP 429/5xx, or any other 4xx whose body matches risk-control markers (`captcha`, `verify failed`, `risk control`, `风控`, `rate limit`, `too many requests`, `try again`); plain 4xx (bad model, bad params) still fail fast with no retry. Each retry logs a clear line (`upstream rejected replay (HTTP 400 ...); likely provider risk-control — retrying in 1500ms (attempt 1/3)`), and if all attempts fail the surfaced error now says `after 3 attempt(s)` so users can tell it was retried. Set `BILI_REPLAY_RETRY_MAX=1` to restore the previous fail-fast behavior.
- **Upstream rejection of replayed thinking blocks (#222, issue #221)**: some upstreams (GLM 4.6 thinking) reject the compress-loop re-request when it carries replayed `thinking` blocks with a 400 (`Invalid parameter: thinking_content …`). The compress loop now strips loop-injected thinking and retries the re-request degraded-first: replay with thinking stripped → on failure retry with reasoning dropped entirely → on failure replay raw; each degradation logs a clear line. Only affects the internal re-request — the client stream keeps the original reasoning blocks.
- **OpenAI SSE tool-call name-split regression (#224)**: some OpenAI-compatible upstreams (SGLang) split the streamed `tool_calls.delta.name` across multiple chunks; the per-chunk proxy-vs-real adjudication dropped split names, so the client received an empty tool name and the agent errored with `Unknown tool ''`. Tool calls are now settled once at `finish_reason` from the fully-buffered deltas: pure-proxy rounds re-emit structured events, real rounds replay the raw chunks verbatim (with `suppressCompletion`), mixed rounds strip only the proxy fragments. Buffer-to-finish also fixes chunk-reordering regressions.

## [0.1.49] — 2026-08-24

### Fixes

- **Context-window registry overhaul (#219, fixes #212)**: stale builtin context limits corrected (DeepSeek 64k→128k, MiniMax host mapping + 204800), resolution is now registry-first (snapshot > builtin table), and the models.dev registry fetch routes through the upstream proxy via undici `ProxyAgent` (Node fetch ignores `https_proxy` — registry lookups work behind GFW/firewalls). Ships a slim offline snapshot (351 models, 12KB) **plus the full models.dev registry bundled in-dist** (282KB, 355 models, all fields) so fresh installs resolve context windows with no network. Web-UI config PUT gains a parse-error guard.

## [0.1.48] — 2026-08-24

### Fixes

- **Responses round-2 lifecycle (#215)**: remapped the round-2 message lifecycle so codex stops dropping text deltas after a proxy tool call.
- **Launcher never reuses a proxy port (#216)**: always spawns a fresh instance — consecutive launcher runs can no longer attach to a stale proxy holding different config.
- **Plugin header gating (#217)**: `x-bili-plugin` is stamped only after the plugin tools are registered; a manifest failure falls back to permanent wire mode — a session never claims plugin mode without the tools to back it.

## [0.1.47] — 2026-08-24

### Features

- **opencode launcher (#211)**: `bili opencode` — HTTP upstreams get a `/bili/`-rewritten temp copy of `opencode.json` via `OPENCODE_CONFIG` (with the thin `bili` `/acp` status plugin appended; `BILLION_CONTEXT_PROXY` makes a host opencode-acp plugin self-disable); HTTPS upstreams ride cert-MITM. Also adds `--bin` for non-standard binary names, symlink-safe dist resolution, and `--` arg passthrough.
- **claude rides `/bili/` (#211)**: Claude Code's undici fetch ignores `HTTPS_PROXY`, so cert-MITM can't reach it — the launcher sets `ANTHROPIC_BASE_URL` to the `/bili/` form directly.
- **omp launcher (#207)**: `bili omp` — pi-style MITM env plus an isolated `PI_CODING_AGENT_DIR` temp copy of `models.yml` (the real `~/.omp/agent` is never touched).
- **`/acp` command (#205)**: thin agent plugin adds an `/acp` status command rendering the kernel's `buildStatusPanel` — live compression state with a version footer; omp sessions bind via `prompt_cache_key`.

### Fixes

- **OpenAI SSE passthrough of real tool calls** (with #205): real (non-proxy) tool-call events are re-emitted verbatim instead of re-synthesized, preserving upstream chunk boundaries.
- **Anthropic round-2 thinking fragmentation (#200)**: round-2 thinking deltas carry the raw delta — stops per-delta content-block fragmentation.
- **de-JSON compress args (#208)**: `parseCompressInput` delegates to the kernel's `parseCompressArgs` — lenient with JSON-string content.

### Chores

- acp-kernel 0.0.42 (#203, ACP tool surface re-exported from the kernel); persist mechanism delegated to `acp-kernel/persist` StateStore (#198); per-PR npm preview builds in CI (#202).

## [0.1.46] — 2026-08-23

### Fixes

- **applyCompression over the unpruned view (#197)**: compression runs over the full conversation view — compressed-but-unpruned ranges no longer produce wrong boundaries (billion-context-pi#195).
- **OpenAI system re-injection (#193)**: the client's OpenAI system prompt is re-injected around the kernel hoist (acp-kernel 0.0.37) instead of being dropped.
- **codexRemove header-only block (#187)**: drops the header-only bili block even without a trailing newline.
- acp-kernel 0.0.34 → 0.0.36 (#191, #192): sub-viability nudge ranges filtered via kernel `viableRanges`.

## [0.1.45] — 2026-08-22

### Features

- **Builtin thin agent plugins (#173)**: `bili plugin install pi|omp|claude|codex|opencode` — thin agent-side plugins ship inside billion-context itself, registering the four ACP tools natively while the proxy stays the compression engine.
- acp-kernel 0.0.31 → 0.0.32 (#181, #184).

## [0.1.44] — 2026-08-21

### Features

- **Cooperative plugin protocol (#161)**: agent-side native tools + proxy-owned engine — the protocol behind [PLUGIN.md](PLUGIN.md) (manifest via `GET /__bili/plugin/manifest`, `x-bili-plugin` session header, `x-bili-plugin-context-window` reporting).
- **Plugin-in-launcher (#163)**: native MCP tools via spawn-time injection (`--mcp-config` for claude, `-c mcp_servers.bili.*` for codex — ephemeral, nothing written to host config).

### Fixes

- **WebSocket upgrades answer a clean 426 (#169)** so codex falls back to HTTP immediately.
- **Direct-connect 10s handshake timeout (#168)** (#78).
- **Cache-hit accounting per protocol (#170)** — no double-count.
- **Context-window self-heal (#172)**: self-heals on upstream overflow and reserves output headroom.
- **Upstream non-2xx logging (#174)** — status + request-id + body snippet.
- **Localhost bind normalization (#175)**; codex web card simplified to url-only.
- **JSON-string compress content (#176)**: `parseCompressInput` accepts JSON-string content.
- **VSCode Copilot BYOK (#178)**: `total_tokens` in the final chunk + cancel propagation (#177).
- **Auto-update anti-brick (#179)**: verifies entry files and never overwrites a working install with a broken one.

## [0.1.43] — 2026-08-17

### Refactors

- **acp-kernel/wire adoption (#160)**: codecs move to the kernel (acp-kernel 0.0.26 → 0.0.28, #165); `subagentNamespace` released, unblocking codex subagent compression namespaces (#150).

### Fixes

- **Issues #150 #151 #152 #154 batch (#155)**.
- **Model identity on the nudge diagnostic line (#164)**.

## [0.1.42] — 2026-08-15

### Features

- **Configurable compression prompts (#157)**: three-level (global → provider → model) prompt overrides, risk-gated — the ancestor of today's `prompts` + `acknowledgePromptsRisk` tuning.

### Fixes

- **Security hardening batch (#141, follow-ups #153)**: network/security fixes for #115 #116 #117 #118 #80 #77 #76 #79 #63 #61 #62 (admin Host gate bypass, port-0 regression, …).
- **DeepSeek thinking signature (#147)**: the thinking `signature` is kept on compressed re-requests for the DeepSeek Anthropic endpoint (was HTTP 400).
- **e2e GLM chat-completions bridge (#149, #142)**: e2e covers chat-completions ↔ responses bridging; fixed lost text when a tool_call follows text.
- **Persist cleanup (#158)**: chain-cleanup rejection swallowed (no more unhandled rejections). acp-kernel 0.0.24.

## [0.1.41] — 2026-08-14

### Fixes

- **Responses non-proxy function_call passthrough (#144)**: non-proxy `function_call` items pass through raw — Codex `agents.*` unsupported-call workflows work.
- **Windows + cross-platform CI (#140)**: windows-latest added to the CI matrix (path-separator + coarse-mtime test fixes); devlog structure introduced.

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
