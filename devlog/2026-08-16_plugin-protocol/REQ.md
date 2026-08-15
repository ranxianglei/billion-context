# REQ - Cooperative plugin protocol (内外呼应)

- Task ID: `2026-08-16_plugin-protocol`
- Home Repo: `billion-context`
- Created: 2026-08-16
- Status: Done
- Priority: P1
- Owner: awork
- References: dog/billion-context#1

## 1. Background & Problem Statement

- **Context**: Issue #1 asks for an agent-side plugin that cooperates with the external proxy ("虽然还是外部代理 但是 agents 内部也安装一个插件 可以里外配合 达到原生插件效果"). Today the two existing modes are mutually exclusive: pure proxy (wire-level tool injection + SSE intercept/re-request loop, session identity guessed) vs pure in-process extension (billion-context-pi, per-agent code).
- **Current behavior (symptom)**: proxy mode has no native agent UX for the ACP tools; session identity relies on heuristics (pi sends no conversation id → content-fingerprint collision risk); the compress loop emulates the tool round-trip inside one HTTP response.
- **Expected behavior**: a thin agent-side plugin registers the 4 ACP tools natively; the proxy stays the compression authority (state, folding, philosophy, nudges); tool calls flow through the agent's own native loop; session identity comes from the plugin.
- **Impact**: enables native-plugin UX (permissions/audit/UI, slash-command status) with zero schema drift (proxy serves schemas), and safer multi-session identity.

## 2. Reproduction

N/A (feature).

## 3. Constraints & Non-Goals

- **Constraints**: AGENTS.md (no `as any`, exact acp-kernel pin, devlog convention); plugin endpoints must sit under the `/__bili/` loopback + trusted-origin gate; wire mode must remain byte-identical for non-plugin clients.
- **Non-Goals**: writing the per-agent plugins (separate repos; billion-context-pi will adopt first); changing kernel behavior; manifest serving the philosophy prompt as a separable field (v1 keeps philosophy proxy-side).
