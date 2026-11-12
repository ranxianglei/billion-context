# REQ - dsh lane: the in-history system prompt is a durable carrier

- Task ID: `2026-11-12_dsh-durable-system-prompt`
- Home Repo: `billion-context`
- Created: 2026-11-12
- Status: Done
- Priority: proposed P1 (the model runs on a stale system prompt; no error, no log)
- References: #2419 / #2446 / #2447 / #2481 (the four existing durable carriers), #2766 (role gate), #6193 (same host behavior, cost side), #4818 / PR #5800 (same family: dsh in-history system messages)

## 1. Background & Problem Statement

- **Context**: DeepSeek Harness (dsh) decides per route how a changed system prompt reaches the model. On routes whose model reads a later `system` message as the effective prompt (`systemPromptUpdate: "in-history"`), `SystemPromptProjection.project` (deepseek-harness `packages/core/agent-loop/src/runtime-context.ts`) does not rewrite the first system node: it appends a complete system message after the cached history. `llm-deepseek`'s Messages serializer ships it as `{ role: "system", content: [{ type: "text", text }] }` after the user turn; only a leading system reaches the top-level `system` field. `llm-pi-ai` does the same for catalog models that declare `supportsMidConvoSystemMessages` (`system` on chat-completions and Anthropic Messages, `developer` on the responses API — pinned by its own `conversation-updates.spec.ts`).
- **Current behavior (symptom)**: the newest such message is the prompt in force, but ACP treats a plain-text in-history system message as ordinary history (`hasUnrecoverableMediaPayload` pins structured systems only). The dsh durable classifier knows four carriers, all on the user channel. A compress range (model-issued or proxy-initiated) that covers the newest prompt folds it into a summary. The host does not resend it until the rendered text changes again, so the model keeps working from the stale head prompt.
- **Expected behavior**: the newest in-history system prompt is never folded; superseded copies fold like any history.
- **Impact**: measured on one long-running dsh session over nine days: 143 in-history system-prompt copies; 18 to 37 of them (intersection and union of two counting methods) were covered by a newly created block while they were still the newest copy; by the intersection count the affected stretches span 2,919 of 6,206 model requests.

## 2. Reproduction

- **Environment**: Node 22, any OS; no network.
- **Minimal reproduction**: `tests/dsh-system-prompt-durable.test.ts` — "dsh lane: the newest system prompt survives a fold that covers it" (codec + `applyCompression`) and "dsh lane, Messages wire: the forwarded request still carries the prompt in force" (real fold through `/__bili/plugin/tool`). Both fail on master c26c31ac.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Host layer only (`src/`, `tests/`); no change under `kernel/**`.
  - dsh lane only (KDD #9); other lanes keep folding plain-text in-history systems.
  - Structured systems (tool deltas) keep their kernel hard pin, unchanged.
  - No config field, env var, persistence or wire-shape change.
- **Non-Goals**:
  - De-duplicating identical prompt copies at parse time (#6193's proposal).
  - Changing how the kernel positions or re-voices a surviving in-history system on the Messages wire (`healIllegalSystemPositions`).
  - Expected-rebase (drift) accounting for retired prompt copies.

## 4. Acceptance Criteria

- [x] dsh lane: newest plain-text in-history system is excluded from every fold; the superseded copy folds.
- [x] A tool-delta system after the prompt neither folds nor takes the prompt's latest slot.
- [x] Unregistered lane: the same message still folds (both wires tested).
- [x] The twelve existing dsh identities resolve as before for user-role carriers; assistant echoes still never project.
- [x] Rule-3 last-user anchor unchanged.
- [x] New tests fail on master and pass with the change; targeted suites and typecheck green.
