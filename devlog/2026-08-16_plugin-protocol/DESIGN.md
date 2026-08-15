# DESIGN - Cooperative plugin protocol

- Task ID: `2026-08-16_plugin-protocol`
- Home Repo: `billion-context`
- Created: 2026-08-16
- Status: Accepted

## 1. Goals & Non-Goals

- **Goals**: native tool surface via plugin; proxy-owned engine/state; single source of truth for tool schemas; real session identity; no wire-mode behavior change.
- **Non-Goals**: plugin implementations for specific agents; auth tokens for the tool API (loopback gate is the boundary); changing the kernel pipeline.

## 2. Division of responsibilities

| Concern | Owner |
|---|---|
| Native tool registration + agent tool loop | plugin (inside) |
| Session identity (real conversation id) | plugin (inside) |
| Compression engine, blocks, folding, nudges, philosophy | proxy (outside) |
| Tool schemas + protocol manifest | proxy — served to the plugin |

## 3. Protocol (v1)

1. `GET /__bili/plugin/manifest` → `{protocolVersion, version, toolNames, tools: {anthropic, openai, responses}, headers, toolEndpoint}`. Plugin registers the four tools natively from the served schemas.
2. Request headers: `x-bili-plugin: <agent>` + `x-bili-plugin-conversation: <id>`. Effects: session enters plugin mode → wire tool injection suppressed (`injectTools = opts.compress.injectTool && !pluginMode` in all three prepare* fns), compress loop never intercepts proxy-named tools (they are native client tools), session id keyed by the conversation id (first in `clientConversationHeader` priority), philosophy prompt + nudge keep flowing.
3. `POST /__bili/plugin/tool {conversationId, tool, args}` → executes under the session lock via the same `executeProxyTool` the wire loop uses, against the last prepare()'s processed view (`rememberPluginMessages`), returns `{ok, tool, conversationId, result}`.
4. Verbatim response passthrough: `pipeThroughWithUsage` (SSE) / `pipePluginJson` (JSON) forward upstream bytes untouched while sniffing usage into `session.stats` (anthropic message_start/message_delta, openai chunk.usage, responses response.completed) — required because `lastInputTokens` feeds the next nudge decision.

## 4. Key decisions

- **No token/session registry**: the conversation id itself is the API key (loopback-gated). An LRU (1024) maps conversationId → sessionId; `peekSession` (never creates) resolves the session.
- **Same-code execution path**: plugin tool calls run the identical `executeProxyTool` as wire mode — one behavioral reference.
- **Kernel handles plugin-mediated history for free**: the next request's tool-call+result pair is converted, paired, hidden and folded by the existing pipeline (`hideConsumedCompressCalls`, prune) — verified: 12 wire msgs → processTurn → 10 → wire 8, consumed `toolu` ids absent, folded content gone, summary retrievable via `search_context`. The summary text intentionally does NOT ride in the wire body (`stripKernelSummaries` drops `acp_summary_*`), same as wire mode.
- **`pluginMode` flag on `Prepared`** gates the passthrough branch in `forward()`; count_tokens paths unaffected.

## 5. Alternatives considered

- **Plugin as sensor only** (proxy keeps wire tools): rejected — keeps the SSE interception machinery and the non-native UX; the issue explicitly asks for native-plugin effect.
- **Plugin executes compression locally** (state inside agent): rejected — splits the single source of truth, breaks the web UI/stats, duplicates the engine per plugin.
- **Token-authenticated register API** (`POST /__bili/plugin/session`): rejected for v1 — extra round-trips and lifecycle complexity with no security gain under the loopback gate.
