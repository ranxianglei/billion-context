# REQ - Port billion-context-pi in-process engine into billion-context (true non-server native for pi)

- Task ID: `2026-10-03_pi-inprocess-port`
- Home Repo: `billion-context`
- Created: 2026-10-03
- Status: Done (owner sign-off 2026-10-03 — all 4 decision points at recommended values)
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/billion-context/issues/1988 ; reference impl https://github.com/ranxianglei/billion-context-pi (v0.1.83, cloned to .tmp/bcp during triage)

## 1. Background & Problem Statement

- **Context**: pi currently has TWO competing compression implementations:
  - `npm:billion-context` (this repo): `package.json` `"pi".extensions` → `dist/agent/pi-native.js` (#519). Server-based "native": the extension spawns its own local proxy (`dist/index.js start`, ephemeral port, parent-pid watchdog), patches `globalThis.fetch` to route model traffic through `<proxy>/bili/<upstream>`, sets `BILLION_CONTEXT_PROXY`; all engine state lives in the proxy process. Failure surface: spawn failure ⇒ silent degradation to direct-uncompressed model traffic; port contention; stale-attach recovery machinery (#1135/#1365/#1243/#1795).
  - `npm:billion-context-pi` (bcp): pure in-process extension — hooks pi events directly (`before_provider_request` rewrites outgoing requests with compressed history; `registerTool` for local compress/decompress/search_context/acp_status/acp_cache/rule; `session_before_compact`, `message_end`, `agent_settled`, …). Model traffic goes pi→upstream direct; zero local HTTP in the hot path. State in `<pi-session-file>.acp.json` sidecars.
  - README "Which do I need?" currently recommends **bcp** for pi while this repo ships its own server-based lane — dual maintenance, behavioral drift (bcp merged k-hat meter calibration #598, hysteresis dead-band, persist-nudge-records #326 — none reachable from bili users; proxy-side features like image billing #1843 unreachable from bcp users).
- **Current behavior (symptom)**: pi users must pick one of two engines from two packages; the one README recommends is not maintained in this repo; the one this repo ships carries an entire server-lifecycle failure class.
- **Expected behavior**: this repo ships a true non-server native pi implementation (in-process, same mechanism family as bcp); bcp can then be fully deprecated ("全部下线").
- **Impact**: eliminates the server-failure class on the pi lane; single codebase for the kernel-driven engine; coherent support story.

## 2. Reproduction (if applicable)

Not a bug — feature request. Verified facts (code-read, 2026-10-03):

- `package.json`: `"pi": {"extensions": ["./dist/agent/pi-native.js"]}`, version 0.1.180, deps: zod 4.1.8 only (typebox NOT a dep here).
- bcp v0.1.83: ~13K LOC TS across ~45 files in src/, 90 test files. Peer deps: `@earendil-works/pi-coding-agent *`, `typebox *`. Dev pin acp-kernel 0.0.98 (this repo master pins 0.0.100 — aligning upward is safe direction).
- **State format compatibility (verified)**: both sides build on the SAME kernel `CompressionState` (acp-kernel `createInitialState`). bili wraps it in a versioned envelope `{version, savedAt, id, payload}` (PERSIST_VERSION=3, optional BILIZSTD1 zstd / BILIENC1 AES-256-GCM envelopes, namespaced layout under `~/.local/share/billion-context/sessions/`). bcp writes RAW state JSON + extras (`liveRefOrigins`, `derivedFrom` #364 marker, `activePack`, `schemaVersion`/`producer`) next to pi's session file. ⇒ One-way bcp→bili migration reader is FEASIBLE (parse sidecar, extract kernel fields, write bili envelope file under the sessions dir). Direction matters: after migration the bili entry owns the file (single-writer discipline).
- **Mutual exclusion already exists both sides**: bili side stamps `BILLION_CONTEXT_NATIVE` runtime marker; bcp `src/proxy-detect.ts` stands down on `BILLION_CONTEXT_PROXY` env or bili-proxy baseURL (`PROXY_STAND_DOWN_MESSAGE`); bili `warnLegacyBcpCoResident` (#939). Reusable within one package.
- **Public host-adapter contract in bcp**: exports `createRuntime(adapter)` / `AcpRuntime`, `deriveChildState(parentState)`, and `"./contract"` export (`schema/bcp-block-v1.json`, `SIDECAR_SCHEMA_VERSION`, `sidecarProducer`). Consumed by fork hosts (Prime RLM & co., bcp docs/host-adapter.md §2/§4, #367). Deprecating bcp requires these to keep living somewhere importable.
- **typebox usage in bcp**: all 8 tool-schema files (`rule-tool.ts`, `status-tool.ts`, `delegate-tool.ts`, `search-tool.ts`, `surface.ts`, `decompress-tool.ts`, `cache-tool.ts`, `compress-tool.ts`) import typebox. This repo has NO typebox dep (only zod 4.1.8).

## 3. Constraints & Non-Goals

- **Constraints**:
  - acp-kernel stays pinned exact-version, bundled inline per tsup entry (noExternal); new entry uses THIS repo's pin (0.0.100).
  - `@earendil-works/pi-coding-agent` remains external/host-provided (same as today's dist/agent entries).
  - Install-Lane & Update-Ownership Contract (#1196): one writer per copy; the npm:billion-context copy installed via pi's channel is host-managed, updated through pi's channel (`pi update --extension npm:billion-context` via plugin-install.ts piInstall); installer keeps stripping legacy bcp entries.
  - Machine-global facilities stay shared: `~/.local/share/billion-context/sessions/` (+ stateDir log/proxy-origin, config dir). The in-process engine should write sessions there where format-compatible so state/log/panel stay coherent across modes.
  - Kernel contract: message ids never reused (§2 Kernel Contract) applies unchanged.
  - Wire fidelity + reason in BOTH compression modes (§6): in-process mode is a THIRD mode (agent owns compression AND wire is direct) — must not break pluginMode/proxyMode semantics elsewhere.
  - **Config Surface Discipline (owner-gated)**: any new env var (e.g. proposed `BILI_PI_INPROC` kill-switch) MUST get a "config surface" section in the PR mapping onto existing conventions (kill-switch family: BILLION_CONTEXT_PLUGIN=0, BILI_NATIVE_PI=0). No invented shapes without owner sign-off.
  - No `as any`, no `@ts-ignore`, hex-escaped ACP tags in source, loggerLog not console.error.
- **Non-Goals** (explicitly out of scope — separate issues if needed):
  - Porting bcp delegate/fleet subagents (delegate-tool/fleet-inspector/fleet-widget) and TUI widgets (fleet-widget/footer-status) — separate mechanisms beyond the compression core.
  - Parity of proxy-only features (image billing/compression #1843/#1095, CCR retrieve store, apig-resign #1884, output steering, chain checkpoint #1421, advisory system, web UI) with the in-process engine.
  - Changing the dsh/omp/codex/claude/opencode lanes.
  - Actually deprecating/unpublishing npm:billion-context-pi (Phase 3, needs migration evidence first).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] New tsup entry `dist/agent/pi-inprocess.js` boots inside pi WITHOUT spawning any local HTTP server and WITHOUT patching globalThis.fetch (assertable: no child process, fetch untouched in e2e).
  - [ ] compress/decompress/search_context/acp_status/acp_cache tools execute in-process against kernel state; A/B against issue repro: a growth→compress→decompress cycle through real pi produces folded context identical in structure to proxy-mode output (kernel-owned format).
  - [ ] Nudge injection fires per kernel cadence contract (flat 50K growth, KDD #8) and prompt wording stays kernel/prompt-pack owned.
  - [ ] Stand-down: when `BILLION_CONTEXT_PROXY` set or pi launched with `/bili/` baseURL, the in-process entry defers (proxy owns) — same mutual-exclusion outcome as today's bcp proxy-detect.
  - [ ] State persists under `~/.local/share/billion-context/sessions/` (or documented equivalent) in bili envelope format; survives pi restart; corrupt-file fallback intact.
  - [ ] One-way legacy reader: given an existing bcp `<session>.acp.json` sidecar, the new entry loads its blocks (best-effort) or reports fresh-start explicitly; NEVER double-writes while bcp is also active (single-writer).
  - [ ] `createRuntime`/`deriveChildState`/contract exports available from this package for host-adapter consumers (import smoke test).
- **Performance / Stability**:
  - [ ] No long-lived background process per pi session; no ephemeral-port allocation on the model path.
  - [ ] bcp test suite coverage for the ported core (compress/decompress/search/status/cache/state/meter incl. k-hat calibration + hysteresis) carried over and green.
- **Regression**:
  - [ ] Existing proxy-mode + plugin-mode suites unaffected (full CI green on rebased head).
  - [ ] Existing server-based pi-native still works when opted back in (fallback path tested).
  - [ ] New/modified test cases added to test suite and passing.

## 5. Proposed Approach (optional)

Three phases (posted in issue thread 2026-10-03; owner to confirm):

1. **Phase 1 — core engine port**: vendor bcp compression core (runtime/state/messages/tokens+meter incl. k-hat calibration #598 + hysteresis fix, compress/decompress/search/status/cache/rule tools, prompt-pack/surface, nudge injection, `before_provider_request` rewrite, tool-pair-sanitizer, degeneration guard, overflow-selfheal, throttle-retry) into `src/agent/pi-inprocess/` (+tests), new tsup entry `dist/agent/pi-inprocess.js`. Open design items:
   - **typebox**: bcp tool schemas use it everywhere; options — (a) add typebox dep, (b) map schemas to existing zod 4.1.8 dep, (c) plain JSON Schema objects if pi's `registerTool` accepts them. Leaning: check (c) first (zero new deps), else (b) (already a dep). DECIDE in Phase 1.
   - State location/format: bili envelope under sessions dir (recommended) vs keeping bcp sidecar layout for continuity.
2. **Phase 2 — default cutover + compat**: `package.json` `pi.extensions` → new entry (in-process default); server-based pi-native kept behind opt-out kill-switch (proposed `BILI_PI_INPROC=0`, config-surface section required); installer keeps stripping legacy bcp entries; read-only bcp `.acp.json` compat; keep `createRuntime`/`deriveChildState`/`./contract` exports.
3. **Phase 3 — deprecate bcp**: deprecate npm:billion-context-pi, flip README pi row, retire repo after migration evidence.

- **Affected modules & entry files**: NEW `src/agent/pi-inprocess/**` (+tests), `tsup.config.ts` (new entry), `package.json` (pi.extensions, possibly exports), `src/plugin-install.ts` (installer interaction), README.md (pi row + native docs), CONFIGURATION.md (if new env var lands).
- **Risks**: ~13K lines doubles pi-lane surface; two pi entries in one package need crisp single-owner-per-conversation rules; bcp is actively developed (through 2026-10-03) — port snapshot pins a moving target (re-sync strategy = final convergence before deprecation); kernel pin alignment 0.0.98→0.0.100 may surface behavior diffs.
- **Rollback strategy**: Phase 2 cutover is a one-line `pi.extensions` pointer + kill-switch — revert restores server-based default instantly; Phase 1 alone changes nothing user-visible until wired up.

### Owner decision points (posted in issue; ALL signed off 2026-10-03 at recommended values)

1. Phase 1 scope = compression core only (delegate/TUI deferred) — RECOMMENDED yes.
2. In-process default ON + server-based kept as opt-in fallback vs full replacement — RECOMMENDED fallback kept.
3. Legacy bcp state: best-effort read/migrate (now verified feasible — same kernel CompressionState core) vs fresh-start-with-notice — RECOMMENDED best-effort read.
4. Preserve host-adapter contract exports (createRuntime/deriveChildState/contract) — RECOMMENDED yes (fork hosts need a migration target).
