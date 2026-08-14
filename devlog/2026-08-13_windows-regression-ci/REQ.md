# REQ - Cross-platform (Windows) CI regression

- Task ID: `2026-08-13_windows-regression-ci`
- Home Repo: `billion-context`
- Created: 2026-08-13
- Status: Done
- Priority: P1
- Owner: awork
- References: dog/billion-context-pi#32

## 1. Background & Problem Statement

- **Context**: billion-context (the proxy) ran CI only on `ubuntu-latest`. The
  sibling repo billion-context-pi already runs a `ubuntu + windows` matrix for
  both unit and e2e. Windows users hit platform-specific bugs (path handling,
  MITM CA cert paths, spawn semantics, line endings) that ubuntu-only CI cannot
  catch.
- **Current behavior (symptom)**: A change can land on master and pass CI while
  silently breaking Windows (e.g. the `2026-08-13_fix-codex-windows-39` fix was
  found out-of-band, not by CI).
- **Expected behavior**: CI runs typecheck + the full test suite (including the
  in-process `e2e-proxy-smoke` e2e) + build on both `ubuntu-latest` and
  `windows-latest`, for Node 22 and 24.
- **Impact**: Catches Windows regressions before merge; matches billion-context-pi.

## 2. Reproduction (if applicable)

- N/A — infra change.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Do not touch the `"version"` field (version-guard enforces this).
  - Keep the existing `npm install --ignore-scripts --no-fund --no-audit` install
    (avoids running dependency postinstall scripts).
  - No new runtime dependencies.
- **Non-Goals**:
  - macOS matrix (costly; ubuntu+windows already covers the two main platforms
    and matches billion-context-pi). Can be added later if needed.
  - A separate `e2e.yml` workflow: billion-context's e2e
    (`tests/e2e-proxy-smoke.test.ts`) is a fast in-process Node test already run
    by `npm test`, so the ci.yml matrix covers cross-OS e2e regression without a
    redundant workflow (unlike billion-context-pi, whose e2e drives a real pi
    host and justifies a separate slow workflow).
  - CI-enforced devlog presence (kept as a SHOULD for now).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `ci.yml` `test` job uses `os: [ubuntu-latest, windows-latest]` matrix
        with `fail-fast: false` and `runs-on: ${{ matrix.os }}`.
  - [x] `devlog/` scaffolding exists (README + 3 templates).
- **Regression**:
  - [x] No source/test changes; only CI config + docs.

## 5. Proposed Approach

- **Affected files**:
  - `.github/workflows/ci.yml` — add OS matrix + `cache: npm`.
  - `devlog/README.md`, `devlog/{REQ,WORKLOG,DESIGN}.template.md` — new.
- **Risks**: A Windows-only test failure may surface on the first PR (that is
  the point of the regression — fix-forward in a follow-up).
