# REQ - `/acp` status command for the agent plugin

- Task ID: `2026-08-23_acp-command`
- Home Repo: `billion-context`
- Created: 2026-08-23
- Status: Done
- Priority: P2
- Owner: agent
- References: issue #53 (support session acp status on web or other place)

## 1. Background & Problem Statement

- **Context**: The agent plugin (pi/omp) registers the four ACP tools
  (`compress` / `decompress` / `search_context` / `acp_status`) as model-facing
  function tools. There is no user-facing way to see the current session's
  compression status without asking the model to call `acp_status`.
- **Current behavior (symptom)**: A user cannot type a command to view ACP status;
  the only path is to prompt the model to call the `acp_status` tool.
- **Expected behavior**: A single `/acp` slash command that shows the current
  session's context-compression status directly in the TUI.
- **Impact**: Convenience/observability. pi/omp expose `pi.registerCommand()`, so a
  slash command is a first-class, low-risk addition.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: >= 20
  - OS/Arch: linux-x64
- **Minimal reproduction steps**:
  1) Run an agent through the proxy (`bili pi` / `bili omp`, or a `/bili/` baseURL).
  2) Send at least one model request (so the proxy has a session).
  3) Type `/acp` in the agent TUI.
- **Relevant configuration**: none (the command is registered by the plugin
  automatically when the proxy is detected).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: the command must be a no-op on hosts without
    `registerCommand` (guarded by `typeof pi.registerCommand === "function"`).
  - The plugin stays a pure protocol client — no acp-kernel import, no compression
    logic; it only reads the proxy's `/__bili/plugin/status` endpoint.
  - No new runtime dependencies.
- **Non-Goals** (explicitly out of scope):
  - No subcommands (`/acp compress`, `/acp help`, …) — the user asked for exactly one
    command that only shows status.
  - No manual "compress now" trigger (that would need a new proxy endpoint + the
    compress loop; deferred).
  - No change to the proxy's wire protocol, config schema, or the four ACP tools.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `/acp` is registered by the plugin when the host supports `registerCommand`.
  - [x] `/acp` shows context usage (tokens / limit / %), in/out/cached tokens,
    request count, and block count (active/total) from the proxy status endpoint.
  - [x] `/acp` warns (not crashes) when no proxy is detected.
  - [x] `/acp` warns (not crashes) when the session is unknown (no model request yet).
- **Performance / Stability**:
  - [x] The command is best-effort: a host without `ui.notify` or a down proxy never
    throws.
- **Regression**:
  - [x] New/modified test cases added to test suite and passing (3 new tests in
    `tests/plugin-agent.test.ts`).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `src/agent/pi.ts` — add `CommandCtx` type, `registerCommand?` to `ExtensionAPI`,
    `fmtTok`/`renderAcpStatus` helpers, and the `/acp` registration in
    `createBiliPlugin` (shared by pi and omp).
- **Risks**: Low — additive, guarded, no proxy changes.
- **Rollback strategy**: revert the single commit; `/acp` disappears, nothing else
  changes.
