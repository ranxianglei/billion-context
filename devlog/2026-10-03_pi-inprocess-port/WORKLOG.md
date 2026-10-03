# WORKLOG - Port billion-context-pi in-process engine into billion-context (true non-server native for pi)

- Task ID: `2026-10-03_pi-inprocess-port`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-10-03

## 1. Summary

- **What was done** (1–3 sentences): Vendored the billion-context-pi (bcp) compression core — 44 source files (~9.7K LOC) plus its test suite (77 files) — into `src/agent/pi-inprocess/` as a new tsup entry `dist/agent/pi-inprocess.js`, and made it the DEFAULT pi extension (`package.json` `pi.extensions`), replacing the server-based `pi-native` entry as the default posture. The old server-based path stays available behind the new kill-switch `BILI_PI_INPROC=0`.
- **Why**: Issue #1988 — provide a true non-server native implementation for pi in this repo so `billion-context-pi` can be fully deprecated ("全部下线"). Previously the README recommended bcp for pi while this repo shipped a server-based lane; two engines in two repos had drifted apart (bcp's k-hat meter calibration #598, hysteresis dead-band, persist-nudge-records #326 were unreachable from bili users).
- **Behavior / compatibility changes**: Yes — see §5 and the PR body. Headline: default pi compression mode flips from server-based to in-process (model traffic goes direct to upstream, no local proxy); rollback = `BILI_PI_INPROC=0`. bcp sidecar state files are read/written byte-compatibly (zero migration); new npm exports `./pi`, `./contract`, `./contract/schema`; build-time devDeps added (typebox 1.3.34, @earendil-works/pi-coding-agent 0.83.0, @earendil-works/pi-tui 0.83.0); producer string `billion-context-pi@…` → `billion-context@…`; log prefixes `[bcp]` → `[bili-pi]`.
- **Risk level**: Medium (new entry + default-mode flip; mitigated by kill-switch, full ported test suite green, and CI global regression).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha>` | feat: in-process pi compression entry; deprecates billion-context-pi (#1988) — single linear commit: vendored engine + entry wiring + tests + docs + devlog |

### Key Files

- `src/agent/pi-inprocess/**` (NEW, 46 entries incl. `schema/bcp-block-v1.json`) — vendored bcp compression core. Adaptations only where required by this repo:
  - `index.ts` — extension factory: kill-switch delegation to server-based native (dynamic import), `INPROC_NATIVE_MARKER="pi-inprocess"` stamping via shared `markNativeHost`, extended stand-down predicate (foreign marker / `BILLION_CONTEXT_PROXY` / `/bili/` baseUrl / `BILI_PROVIDER_REWRITES`), co-resident legacy-bcp warning, delegate/fleet/TUI surface removed.
  - `state.ts` — unchanged persistence semantics: sidecar `<sessionFile>.acp.json` stays CANONICAL (public data contract — downstream tools glob it directly); extras (`liveRefOrigins`, `derivedFrom`, `activePack`) preserved per (sessionFile, sessionId).
  - `update.ts` — self-updater repointed: tracks package `billion-context` (channel-based dist-tag from host deps), installs into pi's extension `node_modules` root, throttle/marker files renamed `.bili-pi-inproc-update-check[-key]` / `.bili-pi-inproc-readonly-key` (no cross-suppression with legacy bcp updater).
  - `contract.ts` / `contract-entry.ts` (NEW) — public host-adapter contract preserved: `SIDECAR_SCHEMA_VERSION`, `BcpBlockV1`/`BcpSidecarV1`, `sidecarProducer()` (now `billion-context@${VERSION}`), `BLOCK_V1_SCHEMA` (inlined JSON).
  - `prompt-pack.ts`, `commands.ts`, `status-tool.ts`, `omp.ts`, `proxy-detect.ts` — user-visible strings repointed to `billion-context`; delegate/fleet command & status sections removed.
  - All 5 former `CURRENT_VERSION` build-time define sites → `import { VERSION } from "../../version.js"`.
- `src/agent/pi-native.ts` — module-level bootstrap extracted into idempotent `startPiNative()` (same standalone-entry behavior, incl. sync marker stamping); named export `nativePiExtension` added for the kill-switch delegation path.
- `src/agent/native-bootstrap.ts` — `legacyBcpEntriesIn()` moved here (shared home; importing pi-native.ts runs its bootstrap gate) and re-exported by pi-native.ts.
- `src/version.ts` — `readPkgField` now walks UP from the module dir (≤6 levels) accepting only a `package.json` whose name is `billion-context`; nested `dist/agent/*.js` previously resolved a missing `dist/package.json` → silent `"dev"` fallback. Affects all entries' version strings (fix, disclosed).
- `tsup.config.ts` — entry array → object mapping (all original names preserved); new entries `agent/pi-inprocess`, `agent/pi-inprocess-contract`; `noExternal += typebox` (bundled inline); `external += @earendil-works/*` (host packages, runtime-resolved by pi).
- `package.json` — `pi.extensions` → `["./dist/agent/pi-inprocess.js"]`; exports += `./pi`, `./contract`, `./contract/schema`; `files` += `src/agent/pi-inprocess/schema`; devDependencies += typebox 1.3.34, @earendil-works/pi-coding-agent 0.83.0, @earendil-works/pi-tui 0.83.0 (exact pins; build-time only).
- `tests/pi-inprocess-*.test.ts` (77 NEW) + `tests/tmp-path-pi-inprocess.ts` + `tests/pi-inprocess-fixtures/` — ported bcp core suite (import remaps, producer/prefix string updates, delegate/fleet tests excluded, integration suite trimmed of delegate surface).
- `tests/pi-inprocess-wiring.test.ts` (NEW) — repo-side integration net: kill-switch parsing + delegation, marker symmetry (own marker ignored, foreign honored, never clobbered), stand-down signals, legacy bcp sidecar adoption, no-server-spawn assertions, contract smoke.
- `README.md`, `CONFIGURATION.md`, `TECHNICAL-NOTES.md` — pi recommendation flipped to the in-process entry; `BILI_PI_INPREC` documented; provenance ref updated.
- `docs/host-adapter.md` (NEW) — ported from bcp (package-name/import-path adjustments; delegate noted as out of scope).
- `devlog/2026-10-03_pi-inprocess-port/{REQ,WORKLOG,DESIGN}.md`.

## 3. Design & Implementation Notes

- **Entry point / key function**: `createAcpExtension(adapter)` (default export of `src/agent/pi-inprocess/index.ts`); host-facing API `createRuntime` / `deriveChildState` on the same entry; contract constants on `billion-context/contract`.
- **Key configuration items**: `BILI_PI_INPROC` (kill-switch, default ON; accepts `0/false/off/no`). acp.json surface unchanged (delegate fields parse but are inert).
- **Key logic explanation**: mutual exclusion is three-layered — (1) installer swaps settings entries (existing `piInstall` strips legacy bcp entries); (2) runtime marker `BILLION_CONTEXT_NATIVE` (non-clobbering first-writer-wins; value distinguishes `pi` [server-based] vs `pi-inprocess`); each entry refuses when the OTHER posture owns the session, and both warn on co-resident legacy installs that predate marker support (bcp <0.1.72). The kill-switch uses a DYNAMIC import of `../pi-native.js` inside the factory because that module bootstraps at evaluation time (sync marker stamp + attach/spawn plan) — a static import would arm the proxy in every in-process session.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck      # tsc --noEmit --project tsconfig.json (root gate covers tests/ since 2e6e508a)
npm run build          # tsup + dist-import-annotations check
node --import tsx --test tests/pi-inprocess-*.test.ts   # targeted ported + wiring suite
```

### Test Coverage

- New/modified test files: 78 flat `tests/pi-inprocess-*.test.ts` (77 ported + 1 wiring) plus fixtures/helper.
- Test count (targeted battery: all pi-inprocess suites + directly-affected existing suites `pi-native`, `hermes-native`, `update-notes`, `logger-session-tag`): **876 total, 873 pass, 0 fail, 3 skip**.
- Key scenarios verified: compress/decompress/search/status/cache/state/meter (incl. k-hat calibration + hysteresis) behavior parity with bcp; sidecar format byte-compat (legacy bcp files load, extras carried, producer rewritten on save); stand-down on every ownership signal; kill-switch delegates to server-based path without spawning anything in-process; contract entry importable with stable schema.
- Real-pi E2E suite (`tests/e2e/e2e-native-pi.test.ts`) updated for the default flip: the original four #1239 tests are pinned to the server-based lane via `BILI_PI_INPROC=0`; a new fifth test exercises the default in-process lane (every request direct — no stamping, zero proxy instances; in-process `acp_status`/`compress`; real fold evidenced by ≥1 block in a `.acp.json` sidecar; `/acp` exits clean); `ACP_AUTO_UPDATE=0` is set for every spawned pi so neither lane's updater can reach the real npm registry from CI. Verified locally **5/5 green** against real pi 0.83.6; the `e2e-native-pi` CI job is green on the PR head.
- Full regression (whole-repo `npm test` + remaining e2e jobs) left to CI on the PR head per local-testing discipline.

### Results

- **PASS**: typecheck clean; build clean (dist-import-annotations OK; `dist/agent/pi-inprocess.js` ≈2.9 MB, `dist/agent/pi-inprocess-contract.js` ≈2.3 KB); targeted battery 873/876 pass, 0 fail.

## 5. Risk Assessment & Rollback

- **Risk points**:
  - Default-mode flip: users upgrading `npm:billion-context` get in-process compression without opting in. Mitigations: kill-switch env var, installer already swaps entries cleanly, co-residence warnings on both sides, bcp ≥0.1.72 auto-stands-down via marker.
  - Ported snapshot pins a moving target (bcp was under active development). Re-sync strategy: final convergence diff against bcp before Phase 3 deprecation.
  - In-process sessions are invisible to proxy-side facilities (web UI panel, `/acp-cache` report, image billing) — disclosed, not a defect (they never went through the proxy).
- **Rollback method**:
  - User-level: `BILI_PI_INPROC=0` (restart pi) restores the server-based default instantly.
  - Repo-level: revert the single commit (restores `pi.extensions` pointer + removes the entry).
  - Rollback impact: none data-wise — sidecar files are written by both postures compatibly.
- **Compatibility notes** (data format, config schema): Sidecar format UNCHANGED (v1, byte-compatible). No config schema change for existing surfaces; one new env var added. acp-kernel pin unchanged (0.0.100; ported code needed exactly one cast widening for the kernel's new `CompactionSummaryMessage` union member).

## 6. Lessons Learned (optional)

- What went well: vendoring verbatim (plus surgical adaptation) preserved months of hard-won fixes (k-hat calibration, overflow-selfheal, throttle-retry) without re-derivation; the existing mutual-exclusion machinery (marker + proxy-detect + installer strip) transferred into one package with zero protocol invention.
- What could be improved: the `CURRENT_VERSION` build-time define was a bcp-specific seam — replacing it with the shared `version.ts` early avoided a class of "dev" version bugs (the walk-up fix in `version.ts` was found via exactly that symptom).
- Reusable conclusions: for future ports of sibling adapters, check whether the reference's state file is a PUBLIC data contract (consumed by downstream tools) before redesigning storage layout — here it forced "sidecar stays canonical", which also zeroed migration risk.

## 6b. Post-PR addendum — rebase + typecheck-gate remediation

- Rebased onto `origin/master` 33d58e5e (v0.1.181). Conflicts: README.md pi row (union of both changes) and tsup.config.ts (kept object-form entry map; noExternal union = master's `ws` + this PR's `typebox`). package.json / lock / CONFIGURATION.md / TECHNICAL-NOTES.md auto-merged cleanly.
- Master widened the typecheck gate to cover `tests/` (2e6e508a). The ported suite needed type fixes across ~33 files under acp-kernel 0.0.101 + pi-coding-agent 0.83.0 strict typings. All fixes are typing-only; where the host types lie about runtime data (AgentMessage.content typed parts-only while pi also delivers plain strings), fixtures stay byte-exact and bridge via casts. Full `npm run typecheck` now clean (was red on master before this branch).
- A separate labeled commit clears 12 residual pre-existing test type errors that postdate 2e6e508a's "clear all" claim (issue1987/issue1993 preflight tests from #1990, ws-bridge, codex-responses-ws) — they leave master CI red and block this PR's gate.
- zh docs synced: README.zh-CN.md (pi row, native-mode paragraph, notes bullet, status paragraph) + CONFIGURATION.zh-CN.md (`BILI_PI_INPROC` row).
- Battery after remediation: typecheck 0 errors; build OK (dist/agent/pi-inprocess.js + contract); targeted suite 876 tests / 873 pass / 0 fail / 3 skip.

## 7. Follow-ups (optional)

- [ ] Sessions-dir mirror: write in-process state into `~/.local/share/billion-context/sessions/` (envelope) so the web UI panel sees these sessions — deferred from this PR (panel-shape coupling risk); separate issue with 来源 marker after merge.
- [ ] Delegate/fleet subagents + TUI widget port (bcp extras beyond the compression core) — separate issue(s) after merge if owner wants them.
- [ ] Proxy-only feature parity for the in-process engine (image billing #1843/#1095, CCR retrieve, apig-resign #1884, output steering, chain checkpoint #1421) — evaluate separately.
- [ ] Phase 3: deprecate npm:billion-context-pi (needs migration evidence first: upgrade counts, co-residence warnings firing).
