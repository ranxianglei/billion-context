# WORKLOG: OpenAI SSE tool-name splitting fix

Branch: `2026-08-24_openai-tool-name-split` (single commit on top of origin/master)

## 1. Bug (found by a REAL review session under `bili hermes`)

SGLang/vLLM stream a tool-call NAME across multiple deltas: the first
fragment carries the name, continuation fragments carry empty names and
argument fragments. The previous passthrough fix (#205) decided
"proxy tool vs real tool" PER CHUNK:

- chunk 1 `function.name = "compress"` → in PROXY_TOOL_SET → buffered
  (never forwarded)
- chunk 2 `function.name = ""` → NOT in set → `sawRealToolCall = true` →
  raw chunk forwarded to the client
- at finish_reason, `sawRealToolCall` SKIPPED the pending flush → the
  buffered name chunk was dropped forever

Client accumulated a tool call with an EMPTY name:
`hermes: ⚠ Unknown tool '' — sending error to model for agent-correction (1/3)
(2/3) (3/3) ❌ Max retries (3) for invalid tool calls exceeded. Stopping as partial.`
Meanwhile the proxy logged `acp-loop round 1: 0 call(s)` every round — the
call was neither intercepted nor correctly delivered.

## 2. Fix

Decide once, at completion, from the ACCUMULATED names — never per chunk.

`src/loop/adapter-openai.ts` `parseStream`:
- buffer EVERY tool_call fragment into `pending` by index (name now
  CONCATENATED — spec-correct for split names, no-op for the
  name-once-then-empty pattern)
- keep the raw chunks (`rawToolChunks`) in arrival order
- at finish_reason (or [DONE] when finish never came) `settleToolCalls()`:
  - all accumulated names ∈ PROXY_TOOL_SET → pure proxy round → structured
    `tool_call` events (compress loop intercepts, client sees nothing) —
    same as before
  - any name ∉ PROXY_TOOL_SET → real round → replay the raw chunks
    verbatim (original ids + original order) as `meta`, plus
    `passthrough`-flagged structured events so the loop counts them as
    real calls (reRequest=false) but does NOT regenerate them; proxy calls
    in a mixed round still get structured events for server-side execution,
    and `filterRealToolFragments` strips their fragments out of the replay
    (mixed chunk → rewritten copy; pure-proxy chunk → dropped)

`src/loop/core.ts`:
- `done` event gains `suppressCompletion?: boolean`; when set, the loop
  skips `emitCompletion` (the verbatim replay already carried the
  upstream's own finish chunk + [DONE]; a regenerated completion would
  duplicate them)

## 3. Tests (`tests/openai-toolcall-finish-reason.test.ts`, 3 → 6)

- existing passthrough test strengthened: raw replay present,
  passthrough-flagged structured event, `suppressCompletion` asserted
- NEW regression: name-split PROXY tool never leaks (accumulates
  `compress` + args, zero raw fragments reach the client, finish_reason
  tool_calls, completion NOT suppressed)
- NEW: name-split REAL tool accumulates and replays verbatim
- NEW: mixed proxy+real round strips proxy fragments from the replay

## 4. Verification

- `npx tsc --noEmit` clean; `npm test` 559/559; build ok.
- Real e2e: `bili hermes` TUI review session (SGLang qwen3.8-27b,
  OpenAI wire). Before the fix the reviewer died on
  `Unknown tool '' ×3 → Stopping as partial`. After: the reviewer made
  three `compress` calls (all intercepted: `acp-loop round 1: 1 call(s):
  compress(...)` + re-request), real `read_file` calls forwarded
  (`3 real tool call(s) forwarded to client`), no TUI errors, and
  delivered `VERDICT: OK` after ~20 minutes of continuous work.

## 5. Rollback

Revert the single commit.
