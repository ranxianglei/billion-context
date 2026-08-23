# REQ: OpenAI SSE real tool_call passthrough

## Problem

Issue #209: When an OpenAI-protocol client (e.g. omp) makes a request that returns
tool_calls through the proxy's compress loop (wire mode), the model enters an infinite
loop. The proxy's OpenAI adapter (`src/loop/adapter-openai.ts`) buffers ALL tool_call
deltas in a `pending` map and yields them only at finish_reason/[DONE], then the
compress loop regenerates the SSE events via `buildToolCall()` with a proxy-generated
ID (`chatcmpl-proxy-${Date.now()}`). This breaks the client's tool_call parsing:

1. **Reordered**: tool_call events moved AFTER finish_reason.
2. **ID changed**: upstream ID replaced with proxy-generated ID.

The client treats the response as "no actionable output" → never saves the tool result
→ model repeats the same call indefinitely.

## Fix

In `parseStream`, when a tool_call chunk contains ONLY proxy tools (compress/decompress/
search_context/acp_status + bili_* variants), buffer in `pending` as before. When it
contains ANY real tool call, pass the raw SSE event through verbatim as a `meta` event
(preserving original position + ID). The finish_reason and [DONE] events are also passed
through verbatim when real tool calls were seen (`sawRealToolCall` flag).

This makes wire mode behave like plugin mode for real tool calls: verbatim passthrough.

## Files Changed

- `src/loop/adapter-openai.ts`: added `PROXY_TOOL_SET`, `sawRealToolCall` flag, meta
  passthrough for real tool_call chunks + finish_reason + [DONE].
- `tests/openai-toolcall-finish-reason.test.ts`: updated test 1 to expect verbatim
  passthrough (meta events) instead of rewritten finish_reason.
