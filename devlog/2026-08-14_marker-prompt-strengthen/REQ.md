# REQ - Harden compress prompts against exec-sandbox tool confusion + restart-pending nag

- Task ID: `2026-08-14_marker-prompt-strengthen`
- Home Repo: `billion-context`
- Created: 2026-08-14
- Status: Done
- Priority: P1
- Owner: awork
- References: dog/billion-context-pi#37; dog/billion-context#24 floors 521–542 (context-explosion postmortem)

## 1. Background & Problem Statement

- **Context**: A Codex Desktop session via the proxy (chatgpt.com/codex upstream, proxy on 0.1.39 with marker mode forced) burned 5.57M input tokens over 2h: 247 repeated file reads, 4 goal resets, only 1 patch applied.
- **Current behavior (symptom)**: The model, unable to see its own context state, tried `tools.acp_status()` / `tools.decompress()` / `tools.search_context()` inside the codex exec sandbox — 7× `TypeError: tools.acp_status is not a function` — and compensated by blindly re-reading files. Separately, 0.1.40 (which fixes the marker-mode default) was auto-installed mid-session at 15:43 but the proxy process never restarted, so the fix never activated; the only notice was a single info-level "Restart to finish." line.
- **Expected behavior**:
  1. All three compress prompt variants explicitly forbid calling ACP tools inside the code-execution sandbox (quoting the exact TypeError) and point to the correct invocation path (top-level function call / text marker).
  2. `checkForUpdate` warns (throttled to 30 min) when the on-disk installed version is newer than the running process, so a stale proxy is visible in logs instead of silently running old code.
- **Impact**: Directly mitigates the token-explosion failure mode for models that conflate proxy-level tools with sandbox objects; makes stale-version operation observable.

## 2. Reproduction (if applicable)

- **Environment**: win32-x64, Codex Desktop → proxy 127.0.0.1:8787 → chatgpt.com/codex, billion-context 0.1.39 (rollout dc1728175a3638f0, 2026-08-13).
- **Minimal reproduction steps**:
  1. Run proxy in marker/hybrid mode with a codex model.
  2. Observe model emitting exec calls containing `tools.acp_status()` → TypeError, retried.
- **Relevant configuration**: `compressProtocol: marker` (or 0.1.39 auto-forced text protocol on chatgpt.com).

## 3. Constraints & Non-Goals

- **Constraints**: no `as any`, no `@ts-ignore`, no comments unless necessary; prompts are the only wire surface (no protocol changes); Windows CI must pass.
- **Non-Goals**: not changing protocol selection logic (0.1.40 default already fixed); not auto-restarting the proxy (risky for in-flight sessions); not reworking the codex exec sandbox.
