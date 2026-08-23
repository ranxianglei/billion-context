# WORKLOG: OpenAI SSE real tool_call passthrough

## Changes

1. **src/loop/adapter-openai.ts**:
   - Added `PROXY_TOOL_SET` (canonical + bili_* proxy tool names).
   - In `parseStream`, when `delta.tool_calls` is present:
     - If ALL tool calls are proxy tools → buffer in `pending` (existing behavior).
     - If ANY is a real tool → set `sawRealToolCall = true`, yield raw SSE as `meta`.
   - In finish_reason handling: if `sawRealToolCall`, yield usage + raw SSE as `meta`
     + done event (skip pending flush + structured yields).
   - In [DONE] handling: if `sawRealToolCall`, yield raw [DONE] as `meta` (skip pending).

2. **tests/openai-toolcall-finish-reason.test.ts**:
   - Test 1 updated: expects meta events (verbatim passthrough) instead of rewritten
     finish_reason. finish_reason preserved as-is from upstream.

## Verification

- typecheck PASS
- 523 tests PASS (0 fail)
- build PASS (dist/index.js 2.13MB)

## Rollback

Revert the single commit on this branch.
