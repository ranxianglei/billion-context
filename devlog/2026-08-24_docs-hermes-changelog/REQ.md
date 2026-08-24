# REQ - Docs update for v0.1.47–v0.1.50 (hermes launcher + changelog backfill)

- Task ID: `2026-08-24_docs-hermes-changelog`
- Home Repo: `billion-context`
- Status: Accepted
- Created: 2026-08-24

## 1. One-liner

Bring README/CHANGELOG/AGENTS.md up to date: the launcher section still
documented only pi/codex/claude, and CHANGELOG had a nine-version gap
([Unreleased] jumped straight to [0.1.40]).

## 2. Background

- v0.1.47 shipped omp + opencode launchers, `/acp` command, SSE passthrough;
  v0.1.48 the port-no-reuse + plugin-header-gating fixes; v0.1.49 the
  context-window registry overhaul. None were in CHANGELOG.
- Post-v0.1.49 master adds #222 (thinking-replay degraded retry), #223
  (hermes launcher), #224 (OpenAI SSE name-split) — riding release PR #225
  (v0.1.50, still open at the time of writing).
- README.md launcher section also claimed the launcher "reuses a proxy
  already running there" — stale since #216 (never reuse a port).

## 3. Scope

- README.md: launcher heading/usage block cover all six clients; redirect/CA
  and config-discovery tables gain omp/opencode/hermes rows; new subsection
  documenting the isolated-temp-config rewrite pattern per client; fix the
  stale port-reuse note.
- README.zh-CN.md: update the one-line launcher client list.
- CHANGELOG.md: add #222/#223/#224 under [Unreleased]; backfill [0.1.41] …
  [0.1.49] from git history (PR numbers verified via tag ranges).
- AGENTS.md: regenerate the module map (src/loop/, launcher.ts, mcp.ts,
  agent/, web/, registry…), correct the test count (66 files), fix cli.ts
  description.

## 4. Constraints

- Docs-only: no version bump, no code changes (version-guard CI must stay
  green).
