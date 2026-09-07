# WORKLOG — dsh native plugin deployment + fetch interception (#521)

Branch: `2026-09-04_dsh-native-plugin` · base: master @ baf1ac5 (v0.1.83)

## What shipped

### 1. `bili plugin install dsh` (src/plugin-install.ts)
- `"dsh"` added to `PLUGIN_AGENTS`; install/remove/status operate on **every** profile dir under `$DSH_HOME/profiles/*` (dirs containing `cordis.yml` or `package.json`; `node_modules` skipped).
- Entry = `- insert:\n    - name: <file:// URL of dist/agent/dsh-acp.js>` merged into each profile's `cordis.patch.yml` (replaces bare `[]`, appends otherwise). Idempotent; stale entries (target file missing) dropped, including their parent `- insert:` group only when no other items remain; `.bili-bak` backup per file (once); throws when zero profiles exist (hint: run `dsh` once first).
- Exported `dshNativeInstalled(dshHome?)` — true when ANY profile carries a live entry.
- Verified live on the real DSH_HOME: install → both profiles patched → remove → restored (`plugin list`: not installed).

### 2. Launcher compat (src/launcher.ts)
- dsh wiring now: `const dshAcpPatch = dshNativeInstalled(dshHomeDir) ? undefined : writeDshAcpPatch(dshHomeDir);` — the legacy `--patch` overlay is skipped when the native entry is present (any-profile rule avoids double-registration of the same module via both layers). Legacy path untouched for fresh machines.
- `LaunchOptions` gains `forceFresh / parentPid / instanceFile / autoUpdateOff`; `proxyStartArgs` pushes `--no-auto-update` for session proxies (no mid-session self-upgrade).

### 3. Per-session proxy: `bili daemon --fresh --json --parent-pid N` (src/cli.ts, src/server.ts, src/config.ts)
- Spawns a detached proxy on **port 0** (ephemeral), writes the bound origin only to a session instance file (env `BILI_INSTANCE_FILE`), prints `{origin, port, pid, logPath}` JSON to stdout, deletes its session file on exit.
- server.ts: with `BILI_INSTANCE_FILE` set, the global instance file and `instances.json` registry are skipped (avoids #394 dual-writer noise across many sibling session proxies); shutdown clears the session file too. Parent-gone reaping (#414 mechanism) terminates the proxy ≤2s after the agent exits.
- config.ts: port validation now accepts `0` (dynamic assignment; real port learned from the handshake). `server.ts` already anticipated port 0; only the validator blocked it.

### 4. In-process fetch interception (src/agent/intercept.ts, new — shared primitive for B/C/D)
- `installFetchInterceptor({ resolveTargets })` wraps `globalThis.fetch`. Rewrites ONLY requests whose origin equals the active upstream origin → `<proxyOrigin>/bili/<full URL>`. Everything else passes through untouched. Network failure (TypeError, non-abort) on a rewritten call retries once direct (degrade, never break the request). Stats: `{rewritten, passthrough, degraded}`. `uninstall()` restores the previous fetch.
- Targets resolve ASYNC per call through an 8s gate that closes once bootstrap knows them; while unknown, calls pass through (a dead/unstarted proxy must never hang or break traffic).

### 5. dsh-acp rewrite (src/agent/dsh-acp.ts) + settings reader (src/agent/dsh-settings.ts, new)
- Bootstrap in `apply()`: interceptor installed **synchronously**; target resolution async — env `BILLION_CONTEXT_PROXY` wins (launcher mode: attach), otherwise spawn `bili daemon` (child gets `BILI_PARENT_PID`). Upstream origin resolved per issue spec: settings provider `baseURL` ?? `llm-deepseek.baseURL` ?? env `DEEPSEEK_BASE_URL` ?? official DeepSeek default (official route only).
- Wire mode unchanged: no ACP tools, no conversation id; `/acp` still uses `fetchStatusLatest` and now reports the routing head (`billion-context: <upstream> → <proxy>`).
- Under `bili dsh`, the overlay-wrapped settings baseURL equals the proxy origin → interceptor sees equal origins → pure passthrough (zero double-proxying by construction).

## Bugs found & fixed during e2e
1. **Port 0 rejected** by config validation → spawned proxy died before bind. Fixed in `src/config.ts` (+ test update in tests/fix-config-session.test.ts).
2. **First-fetch race**: interceptor was installed only after async bootstrap finished, so the agent's first LLM fetch went direct. Fixed with sync install + async per-call target resolution (regression test: fetch fired while spawn pending waits, then lands rewritten).
3. Latent health-probe dependency cycle (gate awaited setup; setup awaited health through the gated wrapper) → settled routing *before* the health check.

## Pre-flight
- `npm run typecheck` — clean.
- `npm test` — **1052 tests, 1051 pass, 1 fail**: pre-existing env-dependent `resolveClientCommand: codex/claude resolve to themselves` (tests/launcher.test.ts) — this sandbox has a local codex binary; passes on CI runners without one. Unrelated to these changes.
- `npm run build` — OK; `dist/agent/dsh-acp.js` 12.56 KB (bundles intercept + dsh-settings; tsup entries unchanged).

## E2E (real dsh 0.1.1-rc.2, bare `dsh --profile headless`, NO `--patch`)
Ran against an isolated DSH_HOME copy (this sandbox's `~/.dsh/sessions` is root-owned and breaks bare dsh regardless of bili) and a real upstream:
1. Smoke task round-tripped end-to-end through the intercepted proxy (exit 0).
2. Rewrite proven against a mock upstream: mock saw only unwrapped `/v1/chat/completions`; with a non-SSE mock body, dsh rendered the proxy's own error string — proxy definitively in the path.
3. Compression pipeline engaged on real dsh traffic: with a 32K route cap (`ACP_PROVIDERS` compress.modelContextLimit) and a ~35.6K-token prompt, bili logged the session, ran preflight, and fail-fast 502'd with the correct adjudication ("nothing left to fold" — a single-message prompt has no compressible history). Full multi-turn compress cycles are covered by the unit suite + `tests/e2e/e2e-codex.test.ts`; headless dsh is one-shot so it cannot produce multi-turn history in a single invocation.
4. Reaping: `parent-gone` ≤2s after every dsh exit; no orphaned proxies.
5. Launcher path: `bili dsh` attach-mode verified by construction (§5) + unit tests.

Known limitations (documented, not fixed): `/acp` live rendering needs an interactive TUI (unit-covered instead); single-shot compression cycle (above); sandbox argv limit ≈128KB caps headless prompt size.
