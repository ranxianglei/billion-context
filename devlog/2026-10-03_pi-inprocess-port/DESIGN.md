# DESIGN - In-process pi compression entry (true non-server native for pi)

- Task ID: `2026-10-03_pi-inprocess-port`
- Home Repo: `billion-context`
- Created: 2026-10-03
- Status: Accepted (owner sign-off 2026-10-03, issue #1988 comment "直接做" — all four decision points at recommended values)

## 1. Goals & Non-Goals

- **Goals**:
  - Ship a true non-server native pi implementation inside `billion-context`: compression runs in-process in pi's own process; model traffic goes direct to upstream; no local HTTP server on the hot path.
  - Make it the DEFAULT pi posture so `billion-context-pi` can be deprecated (Phase 3, later).
  - Preserve the public host-adapter contract (`createRuntime` / `deriveChildState` / sidecar schema) for fork-host consumers.
  - Zero data migration for existing bcp users.
- **Non-Goals**: delegate/fleet subagents + TUI widgets; proxy-only feature parity (image billing, CCR, resign, steering, chain checkpoint); sessions-dir panel mirror; actually deprecating/unpublishing bcp; any change to dsh/omp/codex/claude/opencode lanes.

## 2. Background & Motivation

pi had two competing engines: this repo's server-based native entry (#519 — extension spawns its own proxy, patches `globalThis.fetch`, all state in the proxy process; failure surface: spawn fail ⇒ silent direct-uncompressed degradation, port contention, stale-attach recovery machinery) and bcp's pure in-process extension (which the README recommended). Dual maintenance across two repos had already produced behavioral drift in both directions. Consolidating into one repo ends the drift and removes the server-failure class from the default pi path.

## 3. Current Architecture (as-is)

- `package.json` `"pi".extensions` → `dist/agent/pi-native.js`: bootstrap (`planNativePi` off/attach/spawn → `armNativePi` stamps `BILLION_CONTEXT_NATIVE="pi"` + `verifyAttachAndRecover`) + fetch intercept routing model traffic to `<proxy>/bili/<upstream>` + shared plugin (`src/agent/pi.ts`) whose tools forward to the proxy over HTTP.
- bcp (separate package): `createAcpExtension` hooks pi events directly (`before_provider_request` rewrites outgoing requests with compressed history; local tools; nudge injection), persists `<sessionFile>.acp.json` sidecars next to pi's session files, stands down when a bili proxy owns the session (`BILLION_CONTEXT_PROXY` env or `/bili/` baseUrl).

## 4. Proposed Design (to-be)

- **Module / data-flow changes**:
  - NEW module `src/agent/pi-inprocess/` = vendored bcp compression core (verbatim where possible; adaptations listed in WORKLOG §2). It is a THIRD compression mode alongside pluginMode/proxyMode (§2 KDD #7): the agent OWNS compression AND the wire is direct — like pluginMode the call+result live in the client's own history and no `acp_summary` carrier is injected on the wire.
  - `package.json` `pi.extensions` now points at `dist/agent/pi-inprocess.js`. The old entry remains buildable and reachable through the kill-switch.
  - Mutual exclusion (three layers, unchanged protocol): installer entry-swap (existing); runtime marker `BILLION_CONTEXT_NATIVE` — value `pi` (server-based) vs `pi-inprocess`; each posture refuses when the other owns the session (own marker ignored via value comparison; marker stamping is non-clobbering first-writer-wins); both entries warn on co-resident legacy installs that predate marker support (bcp <0.1.72 double-compression risk).
  - Kill-switch `BILI_PI_INPREC=0/false/off/no` → factory delegates to the server-based path via DYNAMIC `import("../pi-native.js")` (that module bootstraps at evaluation time; static import would arm the proxy in every in-process session).
  - Self-updater repointed to package `billion-context` (channel-based dist-tag from host deps; installs into pi's extension node_modules root; throttle/marker files renamed `.bili-pi-inproc-*` so a legacy co-resident bcp updater cannot cross-suppress). Install-Lane Contract §2 compliant: the copy self-heals through its own install channel, bounded transient drift toward the registry version, plus the global-driven `pi update` lane.
- **New types / interfaces**: none beyond what the vendored code already exports (`AcpRuntime`, `SessionRef`, `AdapterConfig`, `BcpBlockV1`, `BcpSidecarV1`). New npm subpath exports: `./pi` (runtime entry), `./contract` (schema constants + types), `./contract/schema` (JSON Schema file).
- **New files**: `src/agent/pi-inprocess/**` (+ `contract-entry.ts`, `schema/bcp-block-v1.json`), `tests/pi-inprocess-*` (78 flat test files + fixtures + helper), `docs/host-adapter.md`.

## 5. Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| A. Vendor bcp core verbatim (+ surgical adaptation) into this repo | Preserves months of hard-won fixes byte-for-byte (k-hat calibration #598, hysteresis, overflow-selfheal, throttle-retry); convergence diff against bcp stays mechanical until deprecation; single codebase going forward | ~10K LOC added; two pi postures in one package need crisp ownership rules | **CHOSEN** |
| B. Reimplement the engine on this repo's proxy-side primitives (compress-tool/persist/session) | Smaller diff; one engine family | Re-derives bcp's calibration/guard fixes (drift risk creates a THIRD variant — the exact disease being cured); proxy primitives are coupled to the HTTP request flow | rejected |
| C. Make bcp depend on billion-context internal exports | No code move | Inverts the deprecation goal; adds a cross-repo dependency on unpublished internals | rejected |
| Storage: keep bcp sidecar layout vs move to bili envelope under sessions dir | Sidecar: zero migration, downstream-tool contract intact, single-writer trivial / Envelope: unified machine-global facility, web UI visibility | Sidecar wins on risk; envelope couples the port to panel PersistedSession shape (breakage would hit proxy users' `/__bili` page) | **Sidecar stays canonical**; envelope mirror deferred as separate issue (disclosed gap) |
| typebox: bundle inline vs rewrite schemas to plain JSON vs map onto zod | Inline: zero rewrite risk, dist stays self-contained (like acp-kernel), no new RUNTIME dep for consumers | Larger bundle (~+0.7 MB) | **Bundle inline**, exact-pin devDependency |

## 6. Risks & Trade-offs

- **Backward compatibility**: bcp users' sidecar state works unchanged (byte-compatible read/write; producer string updated on next save). bcp ≥0.1.72 auto-stands-down via marker; older bcp versions are covered by an explicit warning (double-compression risk stated in the message). Users who want the old behavior: `BILI_PI_INPROC=0`.
- **Performance**: strictly better on the hot path — no localhost HTTP hop, no port allocation, no watchdog process per session. Bundle size of the pi entry grows (≈2.9 MB incl. typebox + kernel); load cost at pi startup increases marginally (one more extension module evaluated).
- **Cross-platform** (Node >=20; Linux / macOS / Windows): inheritance from bcp (it ran on all three) plus this repo's Windows CI gates running on the PR head. The updater's npm invocation uses `execFile("npm", …)` with a cwd walk-up — same mechanism bcp shipped.
- **Moving target**: bcp kept developing after the port snapshot; final convergence diff before Phase 3 deprecation is the mitigation (tracked in WORKLOG §7).

## 7. Open Questions

- None blocking Phase 3: migration evidence for deprecating npm:billion-context-pi (upgrade counts / co-residence-warning telemetry) will come from the released version.
