# WORKLOG - `/acp` status command for the agent plugin

- Task ID: `2026-08-23_acp-command`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-08-23 08:25

## 1. Summary

- **What was done** (1–3 sentences): Added a single `/acp` slash command to the
  agent plugin (pi/omp) that shows the current session's ACP context-compression
  status. The command is registered via `pi.registerCommand()` in
  `createBiliPlugin` (shared by pi and omp) and reads the proxy's existing
  `/__bili/plugin/status` endpoint — no proxy changes.
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
  (`sessionIdOf`), calls `fetchStatus`, and renders the result via
  `ctx.ui.notify(..., "info")`. Warns (not throws) when the proxy is undetected or
  the session is unknown.
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
  blocks: [{id, tier, active}] }`. `renderAcpStatus` formats tokens as
  `12.3K`/`200.0K`/`1.2M` and shows `context: <used> / <limit> (<pct>)`,
  `in/out/cached`, `requests`, and `blocks: <total> (<active> active)`. The command
  is registered unconditionally at plugin load (cheap); the proxy is detected at
  invocation time so a proxy that comes up later still works.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck      # tsc --noEmit --project tsconfig.build.json
npm test               # node --import tsx --test tests/*.test.ts
npm run build          # tsup
```

### Test Coverage

- New/modified test files: `tests/plugin-agent.test.ts`
- Test count: 517 total, 517 pass, 0 fail (was 514 before; +3 new)
- Key scenarios verified:
  - `/acp` is registered with a description matching /ACP/.
  - `/acp` renders `context: 12.3K / 200.0K (6.2%)`, `in/out/cached: 10.0K / 1.2K /
    8.0K`, `requests: 7`, `blocks: 2 (1 active)` from a fake proxy.
  - `/acp` warns `no proxy detected` when there is no `/bili/` baseURL and no
    `BILLION_CONTEXT_PROXY`.
  - `/acp` warns `no ACP session yet` when the proxy returns 404 for the session.

### Results

- **PASS/FAIL**: PASS
- **Key logs/data** (optional): built-artifact harness (loaded
  `dist/agent/pi.js` with a fake pi + fake proxy) produced:
  ```
  [info] 📊 ACP status
    context: 12.3K / 200.0K (6.2%)
    in/out/cached: 10.0K / 1.2K / 8.0K
    requests: 7
    blocks: 2 (1 active)
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
