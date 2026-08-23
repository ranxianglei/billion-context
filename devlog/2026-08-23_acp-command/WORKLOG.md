# WORKLOG - `/acp` status command for the agent plugin

- Task ID: `2026-08-23_acp-command`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-08-23 17:30

## 1. Summary

- **What was done** (1–3 sentences): Added a single `/acp` slash command to the
  agent plugin (pi/omp) that shows the current session's ACP context-compression
  status. The command is registered via `pi.registerCommand()` in
  `createBiliPlugin` (shared by pi and omp) and reads the proxy's
  `/__bili/plugin/status` endpoint. The proxy now renders the status with the
  kernel's `buildStatusPanel` (from `acp-kernel/panel`) and returns it as a `panel`
  field; the plugin displays that rendered panel (falling back to a compact
  `renderAcpStatus` if absent) — so the `/acp` output matches billion-context-pi's
  `/acp` exactly (same kernel function).
- **Why** (1–3 sentences): The four ACP tools are model-facing; there was no
  user-facing way to view status without prompting the model. pi/omp expose
  `registerCommand`, so a slash command is a first-class, low-risk addition
  (addresses the spirit of issue #53).
- **Behavior / compatibility changes**: Yes — `/acp` is now available in pi/omp when
  the proxy is detected. No change to the proxy's wire protocol, config schema, or
  the four ACP tools. Hosts without `registerCommand` are unaffected (guarded).
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| (single commit on this branch) | feat(plugin): add /acp command to show session ACP status |

### Key Files

- `src/agent/pi.ts` — added `CommandCtx` type; `registerCommand?` to `ExtensionAPI`;
  `fmtTok` + `renderAcpStatus` helpers; the `/acp` registration in
  `createBiliPlugin` (guarded by `typeof pi.registerCommand === "function"`). The
  handler detects the proxy (`detectProxyBase`), reads the session id
  (`sessionIdOf`), calls `fetchStatus`, and displays `status.panel` (the
  proxy-rendered `buildStatusPanel` text) when present, else falls back to
  `renderAcpStatus`. Warns (not throws) when the proxy is undetected or the
  session is unknown.
- `src/plugin.ts` — `handlePluginStatus` now renders the status with
  `buildStatusPanel` (imported from `acp-kernel/panel`) and adds a `panel` field to
  the response. Inputs: `tokenCount` = `session.stats.lastInputTokens`,
  `systemPromptTokens` = 0 (the proxy keeps the system prompt out of the CoreMessages,
  so it isn't measured per session), `state` = `session.state`, `nudge` = the
  remembered per-session nudge, `modelContextLimit` = `session.metadata.effectiveContextLimit`
  (fallback 200000), `unprunedTokens` = `defaultCountTokens` over the remembered
  original messages. Wrapped in try/catch — a render failure yields `panel: undefined`
  (the plugin falls back to `renderAcpStatus`).
- `tests/plugin-agent.test.ts` — extended `FakePi` with `registerCommand`/`commands`;
  3 new tests (renders proxy status; warns when no proxy; warns when session unknown).

## 3. Design & Implementation Notes

- **Entry point / key function**: the `/acp` registration block in
  `createBiliPlugin` (`src/agent/pi.ts`), and `renderAcpStatus(status)` which formats
  the proxy status JSON into a compact multi-line string.
- **Key configuration items**: none — the command is registered automatically; it
  reads `GET /__bili/plugin/status?conversationId=<session id>`.
- **Key logic explanation**: the proxy status endpoint returns
  `{ contextLimit, contextTokens, inputTokens, outputTokens, cachedTokens, requests,
  blocks: [{id, tier, active}], panel }`. `panel` is the kernel's `buildStatusPanel`
  output (the same function billion-context-pi's `/acp` uses) — a bordered
  "ACP Context Analysis" with the context bar, sent-view token breakdown, nudge
  state, compressible ranges, and the block list with topics. The plugin displays
  `panel` verbatim when present; `renderAcpStatus` (the compact `12.3K / 200.0K`
  format) is only a fallback for proxies that don't return `panel`. The command is
  registered unconditionally at plugin load (cheap); the proxy is detected at
  invocation time so a proxy that comes up later still works.
- **Note on "Sent to LLM"**: the panel derives the sent view from
  `nudge.contextBreakdown` + `systemPromptTokens`. For a short/no-compression turn
  the breakdown is all-zero, so "Sent to LLM" shows 0 — this is kernel behavior
  (billion-context-pi shows the same); it populates correctly once compression is
  active.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck      # tsc --noEmit --project tsconfig.build.json
npm test               # node --import tsx --test tests/*.test.ts
npm run build          # tsup
```

### Test Coverage

- New/modified test files: `tests/plugin-agent.test.ts`
- Test count: 526 total, 526 pass, 0 fail
- Key scenarios verified:
  - `/acp` is registered with a description matching /ACP/.
  - `/acp` renders `context: 12.3K / 200.0K (6.2%)`, `in/out/cached: 10.0K / 1.2K /
    8.0K`, `requests: 7`, `blocks: 2 (1 active)` from a fake proxy.
  - `/acp` warns `no proxy detected` when there is no `/bili/` baseURL and no
    `BILLION_CONTEXT_PROXY`.
  - `/acp` warns `no ACP session yet` when the proxy returns 404 for the session.

### Results

- **PASS/FAIL**: PASS
- **Key logs/data** (optional): end-to-end (real proxy + SGLang backend, model
  request with `x-bili-plugin` headers, then `GET /__bili/plugin/status`) returned a
  rendered `panel`:
  ```
  ╭─────────────────────────────────────────────╮
  │           ACP Context Analysis              │
  ╰─────────────────────────────────────────────╯
  Context (session accounting, host footer scale): 1% (1.8k / 262k) — never shrinks; includes compressed originals
  Sent to LLM (after compression, est.): 0 (0% of limit)
  Nudge: idle — max compressible 0 < threshold 50000; growth 0 < floor 22500
  Blocks: none (nothing compressed yet)
  ```
  Both `dist/agent/pi.js` and `dist/agent/omp.js` contain the `registerCommand` call
  (omp reuses the factory). Full TUI verification (typing `/acp` in a live omp/pi)
  is deferred to post-merge — it needs the launcher (separate branch) to route the
  agent through the proxy without editing config.

## 5. Risk Assessment & Rollback

- **Risk points**: The command handler is best-effort and fully guarded (proxy
  detection, `ui.notify` availability, fetch errors) — it cannot crash the host.
  `renderAcpStatus` tolerates missing/odd fields (each line is conditional).
- **Rollback method**:
  - Revert commit(s): the single commit on branch `2026-08-23_acp-command`
  - Rollback impact: `/acp` disappears; no other behavior changes.
- **Compatibility notes** (data format, config schema): No — no proxy config schema
  or wire-protocol changes; reuses the existing `/__bili/plugin/status` endpoint.

## 6. Lessons Learned (optional)

- What went well: the proxy already exposed `/__bili/plugin/status` (used by the web
  UI), so the command needed zero proxy changes — just a thin reader + renderer in
  the plugin.
- What could be improved: a live TUI test would be ideal; it's blocked on the
  launcher branch (which routes the agent through the proxy without config edits).
- Reusable conclusions: for any future user-facing plugin command, register it in
  `createBiliPlugin` guarded by `typeof pi.registerCommand === "function"`, detect
  the proxy at invocation time, and render via `ctx.ui.notify`.

## 7. Follow-ups (optional)

- [ ] Add a live TUI smoke test once the omp/pi launcher is merged.
- [ ] Consider `/acp compress` (manual compression trigger) — needs a new proxy
      endpoint that runs a compress round on demand.
- [ ] Consider surfacing the same status in the `/__bili/` web UI (issue #53).

## 8. omp `/acp` fixes (post-merge debugging)

Two fixes were needed for `/acp` to work in **omp** (it worked in pi from the
start). Both are in this branch's uncommitted changes on top of the `/acp` commit.

### 8.1 Persist the plugin-conversation map across proxy restarts

- **Symptom**: after restarting `bili omp` (or resuming with `-r`), `/acp` said
  "no ACP session yet" even though a model request had been sent in the prior run.
- **Root cause**: the `conversations` map (`conversationId → sessionId`) in
  `src/plugin.ts` was in-memory only. Every `bili omp` starts a fresh proxy with an
  empty map, and the map is only repopulated by a NEW model request. A resumed
  session that hasn't sent a new prompt yet had no entry.
- **Fix** (`src/plugin.ts` + `src/server.ts`): persist the map to
  `<stateDir()>/plugin-conversations.json` (debounced 300ms write on
  `recordPluginSession`, `flushConversations()` on the 3 shutdown paths,
  `loadConversations()` right after `initSessions()` at startup). `stateDir()` is
  `$XDG_STATE_HOME/billion-context` (default `~/.local/state/billion-context`).

### 8.2 Record omp's session id from the request body (`prompt_cache_key`)

- **Symptom**: even after 8.1, a FRESH omp session's `/acp` still said "no ACP
  session yet".
- **Root cause**: the map is populated by `recordPluginSession`, which was called
  ONLY inside `if (pluginAgent)`. `pluginAgent` is set from the `x-bili-plugin`
  header — which the plugin stamps in the `before_provider_headers` event. **omp
  has no `before_provider_headers` event** (its dist only emits
  `before_provider_request`, which exposes the body, not headers), so the header
  was never stamped and `pluginAgent` stayed undefined for omp. pi HAS the event,
  which is why pi worked.
- **Key discovery**: omp sends its own session id in the request **body** as
  `prompt_cache_key` (a Responses-API field), and that value is exactly the session
  id the plugin uses for `/acp` (`ctx.sessionManager.getSessionId()`).
  **Pitfall**: the kernel's `conversationIdentityResponses` (acp-kernel/wire) does
  NOT read `prompt_cache_key` — it only checks a header, `body.session_id`,
  `body.metadata.session_id`, `body.previous_response_id` (clientProvided:false),
  then falls back to a content fingerprint (clientProvided:false). So
  `responsesIdentity.clientProvided` is **false** for omp's first request, and a
  fix keyed on it never fires. The field must be read directly.
- **Fix** (`src/server.ts`, one block): for responses requests, read
  `parsed.prompt_cache_key` directly and, if present, call
  `recordPluginSession(pck.trim(), session.id)` unconditionally (not just when
  `pluginAgent` is set). This is the ONLY path for omp; pi still records via the
  header path above.
- **Verification**: `bili omp -p "<unique prompt>"` → the conversations file gains
  an entry whose key EQUALS the request's `prompt_cache_key`; then
  `GET /__bili/plugin/status?conversationId=<that id>` (what `/acp` does) returns
  `ok:true` with the rendered `buildStatusPanel`.
