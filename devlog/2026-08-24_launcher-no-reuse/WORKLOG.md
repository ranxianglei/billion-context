# WORKLOG - Launcher never reuses a proxy port

- Task ID: `2026-08-24_launcher-no-reuse`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-08-24 13:05

## 1. Summary

- **What was done**: removed the health-probe reuse path from `ensureProxyRunning` — every launch now calls `findFreePort` and spawns a fresh detached proxy; `ProxyHandle.reused` deleted; always stop on exit.
- **Why**: reused proxies were stale-code orphans (12h old on 8787) shadowing fresh launches; user directive.
- **Behavior / compatibility changes**: Yes — concurrent `bili <client>` instances no longer share one proxy; each gets its own port. Sessions remain per-conversation so this is safe.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| this branch, tip | `fix(launcher): never reuse a proxy port — always spawn a fresh instance` |

### Key Files

- `src/launcher.ts` — dropped `reused` field + reuse block + `domainsNeedFreshProxy`/`coveredByDefaultMitm`; `stopProxy` now unconditional in all 4 exit paths; log line always "started proxy at".
- `src/cli.ts` — help text: "a fresh instance every launch".
- `tests/launcher.test.ts` — reuse test inverted ("always spawns a fresh proxy"); `reused` assertions removed; stopProxy no-op test now covers missing-pid child.

## 4. Testing & Verification

- typecheck ✅ · 531/531 tests ✅ · build ✅
- tmux e2e: killed the 12h-old orphan on 8787 → `bili claude` logs `started proxy at http://127.0.0.1:8787` (new pid) → second concurrent launch got port 46257 (no reuse) → both proxies reaped on client exit.
- Claude Code itself shows "Not logged in" on this machine **with or without bili** (no `~/.claude/.credentials.json`); that is an account/login issue, not a launcher regression. Wire path (proxying + ACP tool injection) was already proven with the fake-upstream harness.

## 5. Rollback Plan

- Revert the single commit.

## 6. Lessons Learned

- "Reuse if healthy" is only safe when the reused process is guaranteed current; for a dev-machine tool with detached children, spawn-per-launch is strictly simpler and self-healing.
- Detached + unref'd children outlive their owner by design — any reuse heuristic turns them into permanent squatters on the default port.
