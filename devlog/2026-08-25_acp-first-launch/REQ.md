# Request

User (2026-08-25): "再修复首次启动后 Warning: bili: no ACP session yet (send a model request first, then run /acp) 这个问题" — right after `bili pi` starts, running `/acp` before any model request showed a scary warning instead of useful status.

## Root cause

Not a data bug: before the first model request the proxy legitimately has no compression session for the conversation, so `GET /__bili/plugin/status` answers 404 and the plugin rendered it as `Warning: bili: no ACP session yet …`. After one request the panel worked fine (verified both states in a real TUI).

## Fix (UX)

- `src/agent/shared.ts`: new `fetchProxyVersion(proxyBase)` — manifest probe returning the proxy version (liveness check).
- `src/agent/pi.ts` `/acp` handler: on status 404, probe the manifest; if alive show an **info** notice: `billion-context@X — proxy connected, compression armed. No model request in this conversation yet; send one, then run /acp again.` Only fall back to the old warning when the manifest is unreachable too.
- `src/agent/opencode.ts`: same treatment for its `/acp` (status.ok === false path).

## Validation

- tests/plugin-agent.test.ts: new test — mock server 404s status but serves manifest v9.9.9 → expects type `info`, msg matches `billion-context@9.9.9` + `compression armed`. Old test (both 404) still passes (warning fallback).
- typecheck, full suite 593/593, build green.
- Real TUI e2e (tmux + dist): `/acp` before first message → info notice; after one message → full ACP panel (billion-context@0.1.51).
