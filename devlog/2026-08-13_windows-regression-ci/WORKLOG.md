# WORKLOG - Cross-platform (Windows) CI regression

- Task ID: `2026-08-13_windows-regression-ci`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-08-13 23:55

## 1. Summary

- **What was done**: Added `ubuntu-latest + windows-latest` OS matrix (Node 22/24,
  `fail-fast: false`) to billion-context's CI, and introduced a `devlog/`
  structure (README + REQ/WORKLOG/DESIGN templates + this entry).
- **Why**: dog/billion-context-pi#32 asked billion-context to gain the same
  Windows / cross-OS regression and devlog convention that billion-context-pi
  already has. The proxy was ubuntu-only; Windows users hit platform bugs CI
  could not catch.
- **Behavior / compatibility changes**: No (CI/docs only; no runtime code).
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

- **PASS**: YAML validated; no source changes. The first PR run on
  `windows-latest` is the real regression signal.

## 5. Risk Assessment & Rollback

- **Risk points**: A pre-existing Windows-only test failure may show up on the
  first run (expected; fix-forward).
- **Rollback method**: Revert this commit.
- **Compatibility notes**: No data/config/runtime changes.

## 6. Follow-ups (optional)

- [ ] If a Windows job fails on first run, fix the offending test in a follow-up PR.
- [ ] Consider adding macOS-latest to the matrix if Windows adoption grows.
- [ ] Consider CI-enforcing devlog presence (currently a SHOULD).
