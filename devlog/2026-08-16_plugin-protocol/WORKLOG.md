# WORKLOG - Cooperative plugin protocol

- Task ID: `2026-08-16_plugin-protocol`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-08-16 01:55

## 1. Summary

- **What was done**: Added the proxy-side ("outside") half of the cooperative plugin protocol (issue #1): `/__bili/plugin/manifest` + `/__bili/plugin/tool` endpoints, plugin-mode detection via `x-bili-plugin`/`x-bili-plugin-conversation` headers, wire-injection suppression, verbatim response passthrough with usage sniffing, and tool execution under the session lock. 6 new tests; PLUGIN.md spec; devlog entry.
- **Why**: Pure proxy mode can't give agents a native tool UX and guesses session identity; the plugin protocol lets a thin in-agent plugin own the tool surface + identity while the proxy remains the compression authority.
- **Behavior / compatibility changes**: Yes, additive only. Non-plugin clients are byte-identical (all 419 pre-existing tests pass). Plugin-mode sessions skip wire tool injection and the compress-loop interception; philosophy prompt + nudges still flow.
- **Risk level**: Low (gated entirely on the new `x-bili-plugin` header; absent header ⇒ legacy path).

## 2. Change Log

### Key Files

- `src/plugin.ts` (new) — manifest + tool endpoints, conversation LRU (1024), remembered per-session prepare views, `pipeThroughWithUsage`/`pipePluginJson` verbatim passthrough with usage sniffing (anthropic message_start/message_delta, openai chunk.usage, responses response.completed, non-stream `usage` object).
- `src/server.ts` — plugin routes under the admin gate; `pluginMode` detection in handle(); threaded into prepare{Anthropic,Openai,Responses} as `injectTools = injectTool && !pluginMode`; `rememberPluginMessages` after prepare; verbatim-passthrough branch in forward() before the rewriter.
- `src/session.ts` — `peekSession(id)` (read-only, never creates).
- `src/session-id.ts` — `x-bili-plugin-conversation` first in the conversation-header priority list.
- `tests/plugin-protocol.test.ts` (new, 6 tests) — manifest contract; no wire injection + philosophy still injected + native compress tool_use passes through (1 upstream call); tool API compress → next request folds (pair hidden, history 12→8, folded content gone) + summary retrievable via `search_context`; error paths (400/400/404); stream + non-stream usage sniffing into stats.
- `PLUGIN.md` (new) — the plugin protocol spec for plugin authors.
- `README.md` / `README.zh-CN.md` — "Agent plugin mode" section pointing at PLUGIN.md.

## 3. Verification

- `npm run typecheck` clean; `npm test` 425/425 pass (419 pre-existing + 6 new); `npm run build` OK (dist 2.06 MB).
- Kernel-behavior ground truth established via scratch (deleted after use): with the same wire codecs, plugin-mediated compress + next request folds identically to wire mode (12 wire msgs → processTurn → 10 core → 8 wire; `acp_summary_*` stripped by design — summary lives in block state).

## 4. Notes / Follow-ups

- Follow-up commit (issue #1 comment: MITM + deeper cooperation): `BILLION_CONTEXT_PROXY` exported by `bili pi`/`codex`/`claude` launcher env builders (MITM detection signal for plugins); `x-bili-plugin-context-window` header — plugin-reported window replaces the `native` source in `resolveRequestConfig` (operator `compress.modelContextLimit` still outranks); `GET /__bili/plugin/status?conversationId=` endpoint (contextTokens/contextLimit/blocks/requests for plugin UIs); usage now applied BEFORE `res.end()` in `pipeThroughWithUsage` (client's next request must see it). Tests: 426/426.
- Kernel `search()` is token-based, not substring: "lorem" does not match "lorem-ipsum" in a summary (test uses "plugin").
- The kernel keeps the first user message of a compressed range anchored (turn-1 question survives, turn-1 answer folds) — consistent across wire and plugin modes; asserted only on the folded answer.
- Follow-up (separate repos): billion-context-pi adopts the protocol as the reference plugin; per-agent plugins (opencode etc.) follow.
