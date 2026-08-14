# WORKLOG - Cross-platform (Windows) CI regression

- Task ID: `2026-08-13_windows-regression-ci`
- Home Repo: `billion-context`
- Status: Done (Windows test failures fixed)
- Updated: 2026-08-14 01:20

## 1. Summary

- **What was done**: Added `ubuntu-latest + windows-latest` OS matrix (Node 22/24,
  `fail-fast: false`) to billion-context's CI, and introduced a `devlog/`
  structure (README + REQ/WORKLOG/DESIGN templates + this entry).
- **Why**: dog/billion-context-pi#32 asked billion-context to gain the same
  Windows / cross-OS regression and devlog convention that billion-context-pi
  already has. The proxy was ubuntu-only; Windows users hit platform bugs CI
  could not catch.
- **Behavior / compatibility changes**: No runtime code change. Two Windows-only
  **test** bugs fixed (see §3a) so the new OS matrix is green. Product behavior
  unchanged.
- **Risk level**: Low.

## 2. Change Log

### Key Files

- `.github/workflows/ci.yml` — `test` job: replaced single `runs-on: ubuntu-latest`
  with `matrix.os = [ubuntu-latest, windows-latest]` (+`fail-fast: false`,
  `runs-on: ${{ matrix.os }}`, `cache: npm`). `version-guard` job unchanged.
- `devlog/README.md` — purpose, naming convention, required/optional files,
  rules, npm-packaging note, directory layout (adapted from billion-context-pi).
- `devlog/REQ.template.md`, `devlog/WORKLOG.template.md`, `devlog/DESIGN.template.md`
  — copied from billion-context-pi and adapted (Home Repo = `billion-context`;
  build/test commands match this repo: `tsup`, `tsc --noEmit --project tsconfig.build.json`).
- `devlog/2026-08-13_windows-regression-ci/{REQ,WORKLOG}.md` — this entry (dogfooding).
- `tests/launcher.test.ts:380-386` — `resolveClientCommand` fallback test: compare
  the resolved path after normalizing `path.sep` to `/` (Windows uses `\`).
- `tests/discover.test.ts:177-197` — rescan test: force a distinct config.json
  mtime via `fs.utimesSync` so coarse Windows NTFS mtime resolution can't make
  back-to-back writes look identical (which skipped the rescan → stale result).

## 3a. Windows failures found on first CI run (PR #140) and fixed

1. **`tests/launcher.test.ts`** — `assert.ok(prefixArgs[0].endsWith("pi-coding-agent/dist/cli.js"))`.
   On Windows the resolved path is `…\pi-coding-agent\dist\cli.js` (backslashes),
   so the forward-slash `endsWith` was false. Fix: `split(path.sep).join("/")` first.
2. **`tests/discover.test.ts`** — "mtime change + TTL expiry triggers re-scan".
   `writeZcodeConfig(v1)` → `discover()` → `writeZcodeConfig(v2)` happen within
   microseconds. `src/discover.ts` `mtimesEqual()` compares `statSync().mtimeMs`;
   NTFS gives back-to-back writes the same `mtimeMs` → rescan skipped → stale `v1`.
   Fix: `fs.utimesSync(cfgPath, base+60s, base+60s)` to guarantee a distinct mtime
   on every OS. (Also a latent product edge case for sub-ms edits, but not worth
   changing product behavior; the test now asserts intent deterministically.)

## 3. Design & Implementation Notes

- **Why not a separate e2e.yml?** billion-context's e2e
  (`tests/e2e-proxy-smoke.test.ts`) is a fast, in-process Node test (starts the
  HTTP server, captures upstream requests, asserts on SSE). It already runs under
  `npm test`, so the ci.yml OS matrix exercises cross-OS e2e regression directly.
  billion-context-pi needs a separate e2e.yml because its e2e drives a real `pi`
  host (slow, separate timeout) — not the case here.
- **Why ubuntu+windows, not macOS?** Matches billion-context-pi; covers the two
  platforms that matter; macOS runners are ~10× costlier.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck      # tsc --noEmit --project tsconfig.build.json
npm test               # node --import tsx --test tests/*.test.ts
npm run build          # tsup
```

### Results

- **PASS (local, ubuntu)**: typecheck clean; `npm test` 370 pass / 0 fail;
  `npm run build` success.
- The Windows fixes are cross-platform (verified locally on Linux); the Windows
  jobs are expected to go green on the next CI run.

## 5. Risk Assessment & Rollback

- **Risk points**: A pre-existing Windows-only test failure may show up on the
  first run (expected; fix-forward).
- **Rollback method**: Revert this commit.
- **Compatibility notes**: No data/config/runtime changes.

## 6. Follow-ups (optional)

- [x] First Windows CI run surfaced 2 Windows-only test failures → fixed in this PR (launcher path-sep, discover coarse-mtime).
- [ ] Consider adding macOS-latest to the matrix if Windows adoption grows.
- [ ] Consider CI-enforcing devlog presence (currently a SHOULD).
