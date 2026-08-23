# REQ - omp launcher support

- Task ID: `2026-08-23_omp-launcher`
- Home Repo: `billion-context`
- Created: 2026-08-23
- Status: Done
- Priority: P1
- Owner: agent
- References: n/a

## 1. Background & Problem Statement

- **Context**: `bili <client>` launcher already brings up a proxy and points a coding
  agent at it with NO config-file edits, auto-proxying BOTH schemes: HTTPS upstreams
  via cert-MITM, HTTP/plaintext upstreams via a `/bili/` baseURL rewrite applied
  through the client's own mechanism (pi → isolated `PI_CODING_AGENT_DIR`, codex →
  `-c key=value`, claude → `ANTHROPIC_BASE_URL`).
- **Current behavior (symptom)**: `omp` (oh-my-pi, a pi-based coding agent) is only a
  *plugin-install* target, not a launcher client. `bili omp` → `unknown command`.
  Users of omp must hand-edit `~/.omp/agent/models.yml` to route through the proxy.
- **Expected behavior**: `bili omp [args]` works like `bili pi` — discovers omp's
  upstreams by *reading* (never editing) `~/.omp/agent/models.yml`, rewrites the HTTP
  providers' `baseUrl` to the `/bili/` prefix in an isolated `PI_CODING_AGENT_DIR`,
  whitelists HTTPS providers for MITM, and launches omp pointed at the proxy.
- **Impact**: omp users get the zero-config compression experience; no manual
  `models.yml` edits, no persistent config changes.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: v25.9.0
  - OS/Arch: linux-x64
- **Minimal reproduction steps**:
  1) `bili omp` → `bili: unknown command "omp"` (before this change).
  2) After this change: `bili omp -p "reply with exactly: pong"` → proxy starts,
     omp routes through it, returns `pong`.
- **Relevant configuration**: `~/.omp/agent/models.yml` (providers with `baseUrl`),
  `~/.omp/agent/config.yml` (extensions incl. the omp plugin, modelRoles).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: must not touch the real `~/.omp/agent/models.yml` (the
    user's hard requirement: "禁止改models.yml").
  - Zero new runtime dependencies: omp's `models.yml` is YAML; the project has no YAML
    parser, so a targeted line-based reader is used (mirrors `parseCodexToml`).
  - omp is pi-based: it honors `PI_CODING_AGENT_DIR`, so the pi isolated-home pattern
    applies directly.
- **Non-Goals** (explicitly out of scope):
  - No `bili test omp` smoke-test command (pi-test stays pi-only).
  - No MCP-injection path for omp (it uses the native extension like pi, not MCP).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `bili omp` is recognized as a launch client (`isLaunchClient("omp") === true`).
  - [x] `discoverRoutes("omp", config)` splits omp providers into `httpsDomains`
        (MITM) + `httpRewrites` (`/bili/`), keyed by provider name.
  - [x] `prepareOmpHttpRewrite` builds an isolated `PI_CODING_AGENT_DIR` that symlinks
        every real-home entry except `models.yml`, and writes a `models.yml` whose
        target providers' `baseUrl` is rewritten (HTTP → `/bili/` wrap) while all other
        bytes (comments, ordering, other providers) are preserved verbatim.
  - [x] The real `~/.omp/agent/models.yml` is never modified.
- **Performance / Stability**:
  - [x] Launcher-spawned temp dir is removed on client exit; spawned proxy is killed.
- **Regression**:
  - [x] New/modified test cases added to `tests/launcher.test.ts` and passing
        (8 new tests; full suite green).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `src/client-config.ts` — `OmpProvider`/`OmpConfig`, `resolveOmpHome`,
    `parseOmpYaml`, `readOmpConfig`, wired into `loadClientConfig`.
  - `src/launcher.ts` — `omp` added to `LAUNCH_CLIENTS`/`BaseClientName`;
    `launcherInjectMcp` excludes omp; `discoverRoutes` omp branch; new
    `prepareOmpHttpRewrite`; `runLaunch` omp env branch + cleanup.
  - `src/cli.ts` — help text mentions `bili omp`.
  - `tests/launcher.test.ts` — 8 new tests.
- **Risks**: YAML parsing is targeted (string `baseUrl` values only); a non-standard
  `models.yml` layout (e.g. flow-style providers) would be skipped, not corrupted —
  the rewrite is line-based and only rewrites matched `baseUrl:` lines.
- **Rollback strategy**: revert the single feature commit; no data-format or config
  schema changes to the proxy itself.
