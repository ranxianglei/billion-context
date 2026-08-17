# WORKLOG — launcher plugin mode (#162)

- 2026-08-16: baseline — #161 merged into worktree branch + master (#160) merged,
  session.ts conflict resolved (peekSession + snapshotMessages both kept), 444/444.
- register endpoint + pending queue in src/plugin.ts; route in src/server.ts;
  binding block after getSession (pending consumed only when stats.requests===0).
- src/mcp.ts stdio shell (manifest → tools → /tool forward); tsup second entry.
- CLI: `bili mcp` + `bili plugin-register <id>`.
- launcher: direct-URL mode (claude env ANTHROPIC_BASE_URL; codex -c inline),
  --mcp-config ephemeral JSON, BILI_LAUNCHER_MITM=1 opt-out, BILI_LAUNCHER_PLUGIN=0 kill switch.
- Real-host verification loop (claude 2.1.227):
  - v1 assumed `_meta.ui.sessionId` in MCP initialize — WRONG (claude sends none).
  - env probe: `CLAUDE_CODE_SESSION_ID` is passed to MCP children → register at
    initialize; but claude -p races its first model request past initialize →
    binding missed, session stayed wire mode (`[acp-loop]` in logs).
  - raw-socket header capture: every request carries `x-claude-code-session-id`
    === CLAUDE_CODE_SESSION_ID → identity-keyed binding (registeredIds map),
    race-free on any arrival order.
  - leak found by test: a foreign session ate a headless registration → split
    register into identity/headless modes (identity map vs pending queue).
- Fixed along the way: session.ts merge scar (peekSession closing brace),
  `initialized`/`PROXY_ORIGIN` declarations lost in mcp.ts edits, direct-entry
  guard matched only dist/mcp.js (now .ts too), cli.ts export branch restored.
- Tests: tests/launcher-plugin-mode.test.ts — 6 tests: register validation,
  identity binding after first request, headless pending binding, no cross-session
  leak, injection builders, MCP shell stdio (by-id response matching).
- Full suite 450/450; real e2e `bili claude` → `[plugin] tool acp_status
  executed via plugin`, host config untouched, tmp MCP config removed on exit.
