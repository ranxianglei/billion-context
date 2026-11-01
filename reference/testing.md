# Testing Reference

> **Not auto-loaded.** On-demand mechanics pulled out of `AGENTS.md` §3 to keep
> the auto-loaded spec lean. The operative rules (run e2e before pipeline
> changes, never remove the gates) stay in [`AGENTS.md` §3](../AGENTS.md#3-development-standards);
> this file holds the exact commands, env vars, phases, and CI trigger list.

## Build Commands

```bash
npm run build          # tsup bundle (inlines acp-kernel)
npm run typecheck      # tsc --noEmit --project tsconfig.json (src + tests)
npm test               # scripts/test-suite-lock.mjs run → node --import <preloads> --test tests/*.test.ts
```

## Test-runner preload: storage baseline + dir sandbox

Every suite entry point (`npm test` via `scripts/test-suite-lock.mjs`, CI via
`scripts/run-ci-tests.mjs`) loads `tests/preload-storage-baseline.mjs` before
the tests. It does two things:

1. `BILI_STORAGE_UNIFIED ??= "legacy"` — keeps the broad wire/e2e corpus on
   the legacy storage baseline (the storage family pins and overrides its own
   modes; see the preload header, #2815).
2. **Default-dir sandbox** — `XDG_DATA_HOME` / `XDG_STATE_HOME` /
   `XDG_CACHE_HOME` are pointed at a per-run temp tree (`$TMPDIR/bili-test-dirs-*`)
   unless already set. A suite that builds a store or server without pinning a
   directory otherwise resolves through the XDG defaults straight into your
   REAL `~/.local/{share,state,cache}/billion-context` — envelopes, index.db
   rows, and state bookkeeping land beside production data (found while
   triaging #5082: a local run of `tests/anthropic-cache-control.test.ts`
   wrote `sess-1639-*` rows and `sessions/anthropic/127.0.0.1_*` envelopes
   into the live sessions dir). Tests that pin their own `XDG_*` are
   unaffected (`||=` — empty counts as unset, matching the lock script's XDG
   handling); set the three vars yourself to deliberately run against real
   machine state. The contract is pinned by `tests/preload-sandbox-dirs.test.ts`.

Targeted runs inherit the same protection when you include the preload in the
loader chain (recommended form for local single-file runs):

```bash
node --import ./tests/preload-storage-baseline.mjs --import tsx --test tests/<area>.test.ts
```

A bare `node --import tsx --test ...` still works (the storage family pins its
own dirs), but any suite that relies on DEFAULT path resolution will write
into your real machine state — prefer the preload chain.

## CI: test schedule (#2816)

The main CI `test` job does not run the flat `npm test` glob — it runs
`node scripts/run-ci-tests.mjs`, which runs the same top-level suites with an
explicit `--test-concurrency=4`. Baseline logs prove the old runner default
(`availableParallelism()-1`) was already concurrent — the sum of per-test
durations (~630s ubuntu / ~1110s windows) fits inside the step wall
(373s / 688s) only if several files ran at once; pinning c=4 makes that
explicit with one slot per core. A two-phase prototype (serial "live" phase +
concurrent pool) was measured first and rejected: the serial phase idled the
other cores for 3-4 min without buying stability, because live/process suites
have run mixed with the rest on these dedicated runners for months (#1248's
flakes were loaded local sandboxes — gated by `ACP_TEST_CLAUDE_NATIVE`, not CI).

The script self-checks on every run: a new top-level `tests/*.test.ts` that
matches a process-spawn pattern but is NOT registered in its `LIVE_FILES` list
fails the job. When you add a suite that spawns processes, register it in
`scripts/run-ci-tests.mjs` and review its concurrency assumptions (#1248:
per-file XDG homes, `listen(0)` ports, no machine-global state) before it
rides c=4 unreviewed.

Scheduling only — same tests, same assertions, same env vars; local
`npm test` is untouched.

Since #3143 the `test` job also SHARDS across the matrix: each leg runs one of
three balanced slices (`CI_TEST_SHARD="i/3"`), partitioned by
`scripts/run-ci-tests.mjs` with deterministic LPT bin-packing over file size —
total (union of shards == every file) and disjoint (no file in two shards), so no
test is ever skipped and the LIVE_FILES tripwire still scans the full set in every
shard. The suite had grown past one runner's ~c=4 ceiling (~656 files / ~190k LOC →
~20 min wall on windows), so sharding cut the wall ~3x (~7 min) at zero coverage
cost. Tune by editing the `shard:` list in `.github/workflows/ci.yml` AND its `/3`
denominator together (they must stay equal).

The `static-gates` job (same os×node matrix) runs typecheck + kernel suite +
pi-subagents suite + build IN PARALLEL with the `test` job; they used to be
sequential steps ahead of the tests (~90s of critical path per leg).

## Hermetic data roots (#5107)

Running the suite on a machine that also has bili installed must never touch
the developer's real data tree. Two layers enforce this:

1. **Preload redirect** — `tests/preload-test-env.mjs` (wired into
   `scripts/test-suite-lock.mjs`, `scripts/run-ci-tests.mjs`, and the
   `test:e2e*` npm scripts as an `--import`) points every test process'
   ambient roots at a per-process temp dir: `BILI_SESSIONS_DIR`,
   `BILI_CONFIG_FILE` (absent config), and all four XDG homes. Each test FILE
   runs in its own process, so each gets its own root — parallel shards never
   collide, and the OS tmp cleanup discards them. Per-test isolation
   (`_setStoreForTest`, mkdtemp dirs, explicit env) still wins; the preload
   only replaces the ambient default, so a test that forgets isolation
   degrades to a throwaway root instead of the production tree.
2. **Leak guard** — `npm test` (via `scripts/test-suite-lock.mjs run`)
   snapshots the PRODUCTION sessions dir (`BILI_SESSIONS_DIR` →
   `$XDG_DATA_HOME/billion-context/sessions` → `~/.local/share/…`, resolved
   from the wrapper's pre-isolation env) before the run and diffs after: NEW
   files fail the suite, modified pre-existing files only warn (a concurrently
   live bili instance can touch its own sessions). Escape hatch for the
   false-positive case: `BILI_TEST_LEAK_GUARD=0 npm test`
   (reference/env-vars.md).

Bare targeted runs outside `npm test` do NOT load the preloads on their
own — carry them explicitly or they resolve the real default roots:

```bash
node --import ./tests/preload-test-env.mjs --import tsx --test tests/<file>.test.ts
```

## Local Testing & Install

Test against the REAL published artifact:

```bash
npm run build
npm install -g billion-context@latest   # install from registry
bili start --port 8787
```

`npm install -g . --install-links` also works (installs a real copy of the local
build). The `--install-links` flag is REQUIRED on npm ≥ 9: without it, local-directory
global installs default to a SYMLINK (`install-links=false`), which leaks dev-tree
edits into the "installed" tool and silently re-links on reinstall (#1225). Verify with
`readlink $(npm root -g)/billion-context` — empty output means a real copy. The
registry install remains preferred for testing the real published artifact.

## E2E Regression (real client through bili)

`tests/e2e/e2e-codex.test.ts` drives the **real `codex` CLI** through a built proxy
against a real Responses-compatible upstream and asserts the full context lifecycle
end-to-end: warmup → load growth → ACP compress → purity → native-compact
interception (last phase gated by `E2E_FORGE=1`). Full phase details, env vars, and
mechanics: `tests/e2e/README.md`.

```bash
# zero-token preflight (codex binary + dist + upstream reachable)
E2E_CHECK=1 node --import tsx --test tests/e2e/e2e-codex.test.ts

# full run (defaults to local sglang at http://127.0.0.1:8199/v1, zero cost)
npm run build
ACP_TEST_E2E=1 node --import tsx --test tests/e2e/e2e-codex.test.ts

# + native-compact interception phase
ACP_TEST_E2E=1 E2E_FORGE=1 node --import tsx --test tests/e2e/e2e-codex.test.ts
```

Rules:

- The suite **skips by default** so `npm test` stays free; never remove the
  `ACP_TEST_E2E` gate.
- Run it (at least the 4-phase core) before merging changes to the request
  pipeline — `server.ts`, `src/loop/`, adapters, preflight/compact paths. It is
  the only coverage that exercises real client behavior (codex UA, wire quirks,
  retry loops).
- Any Responses-compatible upstream works via `E2E_UPSTREAM_URL` /
  `E2E_UPSTREAM_KEY`; the provider is configured as `name = "OpenAI"` so codex
  stays on the remote compaction (V2) path — do not "fix" this.
- CI (`.github/workflows/ci-e2e.yml`) auto-runs on PRs whose diff touches the
  request-pipeline hot files (`src/server.ts`, `src/server/**`, `src/loop/**`,
  `src/agent/**`, adapters/stream/persist, `tests/e2e/**`, `package-lock.json`
  — an acp-kernel pin bump IS a pipeline change) plus manual dispatch for anything
  else. It needs repo secrets `E2E_UPSTREAM_URL` / `E2E_UPSTREAM_KEY`; a hosted
  runner cannot reach `127.0.0.1` upstreams, and events without secret access
   (fork PRs) skip the run gracefully instead of failing.

## CI: registry installs must be retry-protected (#2611)

A transient runner↔registry blip (`ECONNRESET` / `network aborted`) during a
setup-phase `npm i -g <cli>` or `npm ci` used to red an otherwise-green PR with
no test code ever running (#2541 run 38032380794; rerun-failed-jobs turned it
green on the same head). Root cause: npm's built-in fetch retry defaults to only
2 tries. Every job that touches the npm registry therefore carries this
job-level `env:` block — it raises the retry budget so a ~10s jitter rides out
instead of aborting setup, and because it is job-level it covers EVERY registry
op in the job (the global CLI install AND `npm ci`, plus any build-time fetch):

```yaml
    env:
      npm_config_fetch_retries: '5'
      npm_config_fetch_retry_mintimeout: '5000'
      npm_config_fetch_retry_maxtimeout: '60000'
```

Bounded by design: worst case ~+2 min of backoff before a genuine sustained
outage still fails fast (each job also carries its own `timeout-minutes`). Copy
the block verbatim into any NEW e2e/setup lane that installs from the registry so
the pattern never re-scatters unpinned. Deliberately NOT applied around
`npm publish` (the artifact/release lanes): a publish is non-idempotent — if the
first upload commits server-side but its response resets, a fetch-retry re-POSTs
and can trip E409 / double-publish, which is worse than the original failure mode.

## E2E: Real-Image Billing Lane (`npm run test:e2e:image`)

`tests/e2e/e2e-image-billing.test.ts` is the hermetic twin of the manual
verification that cleared PR #1857 (#1843/#1848): a corpus of structurally
real images (valid PNG/JPEG/WebP/GIF containers, real dimensions, a 4.7MB
4032x3024 photo, EXIF-orientation, truncated and pure-garbage blobs) is
synthesized deterministically in pure Node — no PIL/ImageMagick, no network,
zero tokens — and driven through the real billing pipeline against a mock
upstream that bills the Qwen2-VL formula. It pins the three failure classes
#1857 fixed: header-parser truth for every container, the >=700x bytes-prior
poison ratio, and the learned-cost rescue (arbitrated 12.6MB forward ->
usage report teaches the per-image cost -> stale-high usage baseline no
longer bricks the session -> baseline regresses to real billing) plus the
default auto->pixels route riding a malformed blob. CI:
`.github/workflows/ci-image.yml` auto-runs on PRs touching the image/
window-gate surfaces; it always runs ungated (needs nothing external), ~1s.

## E2E: Hermetic Local Registry (`ACP_TEST_REGISTRY`)

`tests/e2e/e2e-registry.test.ts` brings its own verdaccio instance (random loopback
port read back from `listen(0)`, isolated storage/config/home) and exercises the REAL
self-update chain end-to-end — dist-tag resolve → tarball download → sha512 verify →
staged extract → in-place install → disk flip — plus post-update
`plugin install opencode`. Loopback only; zero external network, zero secrets,
zero tokens.

`tests/e2e/e2e-advisory-rollback.test.ts` (same gate, same fixture infra)
drives a resident `bili start` against a rollback-form advisory document and
asserts the #1588 contract end-to-end: control self-update, forced rollback
to the older target + persistent restart banner, no ping-pong across cycles
(pre-restart), and the candidate gate refusing the affected latest
(post-restart).

```bash
npm run build
ACP_TEST_REGISTRY=1 node --import tsx --test \
  tests/e2e/e2e-registry.test.ts tests/e2e/e2e-advisory-rollback.test.ts
```

Rules:

- Gated by `ACP_TEST_REGISTRY=1`; skips by default, and the `npm test` glob does
  not cover `tests/e2e/` anyway. CI job: `.github/workflows/ci-registry.yml`.
- Run it before merging changes to `src/update.ts`, `src/advisory.ts`, or the
  install/uninstall pipeline (`src/plugin-install.ts`).
- The updater's registry base URL and check interval are overridable via
  `BILI_UPDATE_REGISTRY` / `BILI_UPDATE_CHECK_INTERVAL_MS` (defaults unchanged when
  unset) — these seams exist for this suite (#1153); keep them default-invariant.
- The fixture MUST bring its own registry instance — never point it at an external
  (even internal) registry service.

Three additional phases harden the #1628 failure class:

- **Unwritable install dir** (posix only; skipped on windows) — chmods the install
  root `0o555` and drives `bili update` through the real chain: assert the loud
  failure line, the one-per-process `install location` diagnostic, zero disk flip,
  and no leaked update lock.
- **Real published baseline** (`BILI_E2E_REAL_BASELINE=<published version>`) — the
  only phase that reads upstream: downloads ONE real published tarball, then proves
  the LIVE old updater hops onto the locally built dist. This is the local form of
  the no-op validation protocol (`reference/release.md`); it cannot replace a real
  no-op release, but it catches "current dist can't be installed by an old updater"
  per PR. CI resolves the baseline to `npm view billion-context version` before the
  run; locally pass it explicitly.
- **Cache-lane doctor** — lays out an opencode cache lane
  (`npm/billion-context@latest/<ts>/node_modules/billion-context`) and asserts
  `doctor --json` resolves the update target to the running copy, not a global root.
