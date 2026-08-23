# WORKLOG — opencode launcher + /acp thin plugin

## Date
2026-08-23

## What was done (this commit)

### 1. Thin opencode plugin — `src/agent/opencode.ts` (new)
- Activates only when `BILLION_CONTEXT_PROXY` is set (launcher sets it);
  prints `[bili-opencode] plugin active (proxy <origin>)`.
- `config` hook registers the `acp` command (`{ template: "", description }`).
- `command.execute.before` intercepts `/acp`: GETs
  `/__bili/plugin/status?conversationId=<sid>&fallback=latest`, then renders
  the returned panel via `client.session.prompt` with
  `{ noReply: true, parts: [{ type: "text", text, ignored: true }] }`
  (same rendering path opencode-acp uses — writes into the session without
  triggering a model reply), then throws `__BILI_ACP_HANDLED__` to stop
  opencode from sending the empty template to the model.
- Early iteration also POSTed `/__bili/plugin/register` on `session.created`;
  this was REMOVED: registering made the proxy set `pluginAgent` and suppress
  wire tool injection, but this plugin does not natively register the 4 tools
  (opencode's `tool` hook needs zod schemas) → the model lost the ACP tools.
  Wire injection + `fallback=latest` status is the correct split.

### 2. Launcher injection — `src/launcher.ts`
- `prepareOpencodeHttpRewrite(..., pluginPath?)`: appends the absolute plugin
  path to the temp config's `plugin` array (deduped). Temp config is now
  emitted whenever a pluginPath is given — even if the real opencode.json is
  missing/unreadable or has no rewriteable providers — so `/acp` always rides
  along `bili opencode`.
- `runLaunch` opencode branch: resolves `dist/agent/opencode.js` next to the
  running CLI (`fs.existsSync` guarded) and passes it in.

### 3. Status fallback — `src/plugin.ts` + `src/server.ts`
- `handlePluginStatus(conversationId, res, fallbackLatest = false)`: when the
  conversation is unknown and `fallbackLatest`, pick the session with the
  newest `lastSeen` via `listSessions()`; response gains `fallback: true`.
- `/__bili/plugin/status` route parses `fallback=latest`.

### 4. Build + tests
- `tsup.config.ts`: entry += `src/agent/opencode.ts` (dist 1.8KB).
- `tests/launcher.test.ts`: plugin-injection assertions (appended, not
  duplicated; provider baseURL untouched when no rewrites; temp config emitted
  from a missing source file).
- `tests/plugin-protocol.test.ts`: `fallback=latest` resolves unknown
  conversation → ok/fallback=true; plain unknown still 404.

## Verification
- `npm run typecheck` clean; `npm test` 530 pass / 0 fail; build OK.
- e2e `node dist/index.js opencode run "reply with exactly: pong"`:
  - proxy starts (MITM: open.bigmodel.cn; 1 HTTP /bili/ rewrite)
  - `[opencode-acp] disabled: BILLION_CONTEXT_PROXY detected`
  - `[bili-opencode] plugin active`
  - model replies pong; proxy log round 2 shows
    `tools=[bash,read,...,compress,decompress,search_context,acp_status]`
    (4 ACP tools appended after opencode's native set)
- Fallback endpoint test (proxy + one OpenAI request + unknown conv):
  `?fallback=latest` → 200 `{ok:true, fallback:true}` with the
  buildStatusPanel rendered (`billion-context@0.1.46` header); without the
  param → 404. PASS.
- Real `~/.config/opencode/opencode.json` byte-identical; temp dirs cleaned.

## Follow-up fix — symlink-safe dist path resolution
Symptom: user's `bili opencode` TUI (22:44) loaded the temp config and
opencode-acp/awork/omo but NOT `dist/agent/opencode.js`, while `node
dist/index.js opencode` (same dist) injected it fine.
Root cause: the launcher resolved the plugin as
`path.resolve(path.dirname(process.argv[1]), "agent/opencode.js")` — via the
global bin symlink `~/.local/.../bin/bili` that dirname is the bin dir, so
`existsSync` failed and the plugin was silently skipped. Same latent bug in
`buildMcpConfig` / `buildCodexMcpArgs` (dist/mcp.js).
Fix: added `selfDistFile(name)` = `path.join(selfPackageRoot(), "dist", name)`
(selfPackageRoot is import.meta.url-based, so Node's realpath resolution
makes it symlink-safe); used it at all three sites.
Verified: `bili opencode run "reply with exactly: pong"` through the global
symlink now prints `[bili-opencode] plugin active` and the session log shows
`dist/agent/opencode.js loading plugin`. 530 tests pass, typecheck/build OK.

## Rollback
Revert this commit. No data-format or protocol changes; the fallback param is
additive and ignored by older callers.

## Notes / pitfalls
- Registering the plugin conversation (`/__bili/plugin/register`) suppresses
  wire tool injection — only register when the plugin ALSO natively registers
  the 4 tools (pi/omp do; opencode cannot without zod).
- opencode loads `plugin: ["opencode-acp@latest"]` from
  `~/.cache/opencode/packages/...` (NOT ~/.config/opencode/node_modules) —
  local self-disable patches must hit the cached copy.
- The ignored-message render path (`noReply` + `parts[].ignored`) is the
  opencode-sanctioned way to print UI text from a plugin.
