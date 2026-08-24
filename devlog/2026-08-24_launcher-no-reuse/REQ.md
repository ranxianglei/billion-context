# REQ - Launcher never reuses a proxy port

- Task ID: `2026-08-24_launcher-no-reuse`
- Home Repo: `billion-context`
- Created: 2026-08-24
- Status: Done
- Priority: P1
- Owner: bili-agent (qwen3.8-27b)
- References: user report — `bili claude` broken; tmux repro showed a stale 12h-old detached proxy being reused

## 1. Background & Problem Statement

- **Context**: `ensureProxyRunning` probed the preferred port (default 8787) and, when a healthy listener answered with compatible MITM domains, reused it instead of spawning a new proxy.
- **Current behavior (symptom)**: a detached `bili start` proxy from an earlier session (12h old, old code) keeps squatting on 8787 forever; every subsequent `bili <client>` silently routes through that stale process. User directive: "bili 命令不应该复用任何端口 应该每次都是新的才对".
- **Impact**: stale-code proxies shadowing fresh launches; config drift (wrong MITM domains can still be reused when they happen to sit inside the default set); orphaned listeners that nothing ever reclaims.

## 4. Acceptance Criteria

- [x] `bili <client>` ALWAYS spawns a fresh proxy process; no health-probe reuse path.
- [x] Concurrent launches each get their own port (verified: 8787 + 46257 side by side).
- [x] Proxy is always killed on client exit (no `reused` short-circuit).
- [x] typecheck / 531 tests / build green.

## 5. Alternatives Considered

- Keep reuse but only for same-vintage proxies — rejected: requires version handshakes; complexity for no real benefit since spawn cost is ~1s.

## 6. Milestones

- Single commit; done in one pass.
