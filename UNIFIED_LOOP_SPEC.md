# Unified Compress-Loop — Design Spec (Phase 1+2)

## Problem
The generic billion-context proxy's three `compress-loop-*.ts` files have an **injection-persistence** bug: the philosophy prompt (injected as a conversation message, not a transient system prompt) and accumulated proxy-tool records PERSIST across re-request rounds, re-priming the model → on rare model paths the model loops `acp_status`/`search_context` until the loop-limit fires a degenerate empty completion (the 炸锅). Root cause confirmed by the user.

`executeProxyTool` is also copy-pasted ×3 (compress-loop.ts:47, compress-loop-anthropic.ts:59, compress-loop-responses.ts:85).

## Reference (the ONLY behavioral reference)
**billion-context-pi** (`/home/dog/projects/billion-context-pi/src/`), the Pi adapter. It uses an **executor model** (one tool call = one Pi turn, no loop). Key principles to mirror in the loop:
- `wireSystemPrompt` (index.ts:229-235): philosophy is a **transient system prompt** returned via Pi's `before_agent_start` event — rebuilt fresh each turn, NOT in message history, does NOT accumulate.
- `wireContextTransform` (index.ts:103-227): runs `core.processTurn({messages, state, config, tokenCount})` once per LLM call; nudge is a **per-turn append** (comment index.ts:178-179: "the next context event rebuilds the array from scratch, so it does NOT permanently pollute context").
- Kernel `hideConsumedCompressCalls(state, messages)` runs inside processTurn each turn (hide-consumed.ts, exported index.ts:51) — hides consumed/failed compress records, keeps active-block compress calls ("压缩成功留着"), rewrites kept compress text to live ranges.
- Kernel `protected.ts`: `ALWAYS_PROTECTED_TOOLS=["compress"]`, recent-zone + last-user protection.

**Alignment goal**: the proxy's loop must apply the SAME per-turn hygiene bili-pi gets for free (transient philosophy + hideConsumed), but per ROUND of the loop.

## Architecture: protocol-agnostic core + thin adapters

### Core message type (acp-kernel, types.d.ts:3-10)
```ts
interface CoreMessage { id: string; role: "user"|"assistant"|"system"|"tool"; contentType: "text"|"tool-call"|"tool-result"|"reasoning"; text?: string; toolName?: string; toolCallId?: string; }
```

### Loop context (mirrors existing CompressLoopResponsesCtx)
```ts
interface LoopCtx {
  core: CompressionCore;       // acp-kernel
  config: Config;
  messages: CoreMessage[];     // original (pre-loop) messages from processTurn
  session: Session;            // has .state (CompressionState), .stats
  log: (msg: string) => void;
  proxyUrl?: string;
  textProtocol?: boolean;
}
```

### Parsed stream event (what an adapter yields from the upstream stream)
```ts
type ParsedStreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; name: string; callId: string; arguments: string }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  | { kind: "done"; finishReason?: string };
```

### Adapter interface (protocol-specific; one per protocol)
```ts
interface CompressLoopAdapter {
  // Build native upstream request body from CoreMessage[] + TRANSIENT system prompt.
  // The system prompt MUST NOT be added to coreMessages — it is passed fresh each round.
  buildRequest(coreMessages: CoreMessage[], systemPrompt: string, requestBody: Record<string, unknown>): Record<string, unknown>;
  // Parse upstream SSE stream → ParsedStreamEvent (extract text deltas, tool calls, usage, done)
  parseStream(upstream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedStreamEvent>;
  // Emit downstream (client-facing) events as SSE Buffers
  emitText(delta: string): Buffer;
  emitToolCall(call: { name: string; callId: string; arguments: string }): Buffer;   // real-tool passthrough
  emitMarker(toolName: string, result: string): Buffer;                              // proxy-tool result visibility
  emitCompletion(opts?: { finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } }): Buffer;
  emitError(message: string): Buffer;
  // (Optional) extract text-protocol triggers (<acp_compress>...</acp_compress>) from assistant text
  extractTextTriggers?(text: string): { clean: string; calls: { name: string; callId: string; arguments: string }[] };
}
```

### Core loop (protocol-agnostic)
```ts
async function* runCompressLoop(
  upstream: ReadableStream<Uint8Array>,   // round-1 stream already fetched by server
  ctx: LoopCtx,
  requestBody: Record<string, unknown>,   // original client request (for tools, model, etc.)
  requestOptions: { url: string; headers: Record<string, string> },
  adapter: CompressLoopAdapter,
  systemPrompt: string,                   // TRANSIENT philosophy (never added to coreMessages)
): AsyncGenerator<Buffer>
```

Round logic (per bili-pi hygiene):
1. `for round in 1..MAX_ROUNDS` (MAX_ROUNDS = 10):
   - Parse `upstream` stream via `adapter.parseStream`.
   - Accumulate assistant text; for each tool_call:
      - If PROXY tool (compress/decompress/search_context/acp_status): execute via shared `executeProxyTool`, `yield adapter.emitMarker(...)`, append `{assistant,tool-call}` + `{tool,tool-result}` to a LOCAL coreMessages copy.
      - Else (real tool): `yield adapter.emitToolCall(...)`, increment `realCalls`.
    - After stream done: run `hideConsumedCompressCalls(ctx.session.state, coreMessages)` (per-round hygiene, skipped for textProtocol).
    - Decision: if `proxyResults.length > 0 && realCalls === 0` → re-request: rebuild body via `adapter.buildRequest(coreMessages, systemPrompt, requestBody)`, fetch new upstream, loop. Else → `yield adapter.emitCompletion(...)`, return.
      - Note: ALL proxy tools (including read-only acp_status/search_context) drive re-request. This differs from baseline (`hasMutatingOnly`) which only re-requested for compress/decompress. V2 re-requests for read-only tools to feed the result back to the model (fixes the tool_calls-no-body hang, commit d8a1e0d). Safety net: MAX_LOOP_ROUNDS=10 graceful completion (never the degenerate empty completion that caused 炸锅).
2. Limit reached: `yield adapter.emitCompletion(...)` **gracefully** (NOT a degenerate empty completion). Log it. This is the key fix — never discard the turn.

### Shared executeProxyTool (de-dup ×3 → ×1)
```ts
function executeProxyTool(name: string, args: Record<string, unknown>, ctx: LoopCtx): string
```
Dispatch (identical to current 3 copies):
- `compress` → `applyRanges(parseCompressInput(args), ctx)` (stream.ts applyRanges mutates ctx.session.state)
- `decompress` → `resolveDecompress(args, ctx)` (decompress-shared.ts)
- `search_context` → `ctx.core.search(query, state).slice(limit)` → formatted lines
- `acp_status` → `buildStatusReport(state, messages, estimateTokensFast)`

## File structure (NEW files; keep originals as baseline)
```
src/loop/
├── core.ts              # runCompressLoop + LoopCtx + shared executeProxyTool + ParsedStreamEvent + CompressLoopAdapter interface
├── adapter-responses.ts # responses adapter (parseStream/emit*/buildRequest)
├── adapter-openai.ts    # openai /chat/completions adapter
├── adapter-anthropic.ts # anthropic /v1/messages adapter
└── index.ts             # exports: runCompressLoop + a factory pickAdapter(protocol)
```
Originals (`src/compress-loop.ts`, `src/compress-loop-anthropic.ts`, `src/compress-loop-responses.ts`) stay UNTOUCHED as baseline.

## Feature-flag wiring (server.ts)
In `server.ts:1131-1200`, gate on `process.env.ACP_LOOP_V2 === "1"`:
- if set → use `runCompressLoop(...)` with `pickAdapter(protocol)`.
- else → existing baseline loops (unchanged).
This allows A/B comparison in live tests (`ACP_LOOP_V2=1 bili-test-pi ...`).

The transient `systemPrompt` = `buildCompressSystemPrompt()` (or `buildCompressTextSystemPrompt()` when `ctx.textProtocol`). Import from compress-tool.ts. Pass as the `systemPrompt` arg — do NOT inject into requestBody.input/messages in core (the adapter places it per-protocol).

## Per-protocol adapter notes

### responses (`/response-input`-style `input[]`)
- `buildRequest`: convert CoreMessage[] → ResponseInputItem[] via existing `coreToResponses` (responses.ts:324). Place systemPrompt as a developer message at the head of input (skip leading additional_tools; mirror `injectResponsesDeveloperMessage` responses.ts:362-372). Top-level `instructions` MUST stay empty/absent (code_mode requirement, server.ts:803-804). Preserve `requestBody.tools`, `model`, etc.
- `parseStream`: responses SSE events (`response.output_text.delta`, `response.function_call_arguments.done` / `response.output_item.added` with function_call, `response.completed` with usage, `response.done`). Reference existing `stream-responses.ts` helpers (buildMessageItemSequence, buildCompleted) + the baseline `compress-loop-responses.ts:454+` stream parsing for the exact event names/shapes.
- `emitText`/`emitToolCall`/`emitMarker`/`emitCompletion`: reuse `stream-responses.ts` SSE builders.
- text-protocol: `extractTextTriggers` detects `<acp_compress>...</acp_compress>` (ACP_TEXT_OPEN/CLOSE from compress-tool.ts).

### openai (`/chat/completions`, `messages[]`)
- `buildRequest`: `coreToOpenai(coreMessages)` (openai.ts:106). systemPrompt → a `{role:"system",content}` message at messages[0].
- `parseStream`: `data: {choices:[{delta:{content?,tool_calls?}}]}` chunks + `data: [DONE]`. Reference baseline `compress-loop.ts` + `stream-openai.ts`.
- emit*: `stream-openai.ts` SSE builders (buildFinishSse etc.).

### anthropic (`/v1/messages`, `messages[]` with content blocks)
- `buildRequest`: `coreToAnthropic(coreMessages)` (anthropic.ts:138). systemPrompt → top-level `system` field.
- `parseStream`: `content_block_delta` (text_delta/input_json_delta), `content_block_start` (tool_use), `message_delta` (usage), `message_stop`. Reference baseline `compress-loop-anthropic.ts` + `stream-anthropic.ts`.
- emit*: `stream-anthropic.ts` SSE builders (buildTerminalSse etc.).

## Kernel APIs (all already exported from acp-kernel, version 0.0.17 pinned)
- `hideConsumedCompressCalls(state, messages)` — hide-consumed.ts (the per-round cleanup)
- `createCore`, `CompressionCore`, `processTurn` — compress.ts
- `buildStatusReport`, `estimateTokensFast` — report.ts, tokenize.ts
- `COMPRESS_PHILOSOPHY`, `HOW_TO_COMPRESS_RULES` — compression-rules.ts (already wrapped by buildCompressSystemPrompt)
- types: `CoreMessage`, `CompressionState`, `Config`, `ProcessTurnResult` — types.ts
- `coreToResponses`/`responsesToCore`, `coreToOpenai`/`openaiToCore`, `coreToAnthropic`/`anthropicToCore` — local src/{responses,openai,anthropic}.ts

## Constraints (from AGENTS.md)
- No `as any`, no `@ts-ignore`.
- Hex escapes (`\x3c`/`\x3e`) for any `<acp>`/`<acp_compress>` XML in source.
- Comments only where strictly necessary (priority-3: encodes an invariant). This is an exception — explain WHY transient/dedup matters in 1-2 lines at the core loop's hygiene point.
- TypeScript strict, ESM (.js extensions in imports).

## Test plan (Phase 3)
247 tests total (219 baseline + 28 new in `tests/loop-*.test.ts`). Updated to match d8a1e0d (read-only tools now drive re-request):
1. **acp_status-only round**: model calls only acp_status → assert (a) marker surfaced to client, (b) re-request happens (result fed back to model), (c) graceful completion at limit, (d) no hang. **No 炸锅.** *(Changed from "NO re-request" after d8a1e0d fixed the tool_calls-no-body hang.)*
2. **search_context-only round**: same shape as #1 (re-request + graceful completion).
3. **compress round**: model calls compress → assert re-request happens (mutating), result fed back, hideConsumed ran (consumed compress records hidden in round 2 input).
4. **decompress round**: re-request happens.
5. **limit-hit graceful**: force 10 rounds → assert graceful completion (NOT degenerate empty), no crash.
6. **philosophy transient**: assert philosophy appears exactly ONCE per round in upstream body (not accumulated) — spy on fetch.
7. **hideConsumed per round**: after a compress in round 1, round 2's upstream body must NOT contain the consumed compress tool-call/result (verify hideConsumedCompressCalls ran).
8. **real-tool passthrough**: model calls a real tool (e.g. `bash`) → emitted to client, loop ends (no re-request).
9. **mixed**: compress + real tool in same round → forwarded (no re-request), compress executed, marker shown. *(V2 executes compress in mixed rounds; baseline does NOT — documented difference.)*

### recordUsage semantics (reviewer P1 clarification)
`session.stats.inputTokens` ACCUMULATES across loop rounds (`+=` per round) = total tokens consumed (billing/usage). `session.stats.lastInputTokens` OVERWRITES each round = current context size (used by nudge/compression trigger). Both behaviors are intentional and correct for their respective purposes.
Run via `node --import tsx --test tests/loop-*.test.ts` (node/npm at /home/dog/.local/bin; npx NOT available, use `npm test`).

## Verification gate (must pass before declaring done)
- `npm run typecheck` (tsc --noEmit) clean.
- `npm test` all green (existing + new).
- Manual smoke: `ACP_LOOP_V2=1` path at least imports + a round-trip works under mocked fetch.

## Out of scope for this delegation
- Live testing (bili-test-pi/codex/claude) — Phase 4, done by lead.
- Double-agent review — Phase 5, done by lead.
- Removing/reverting PR#90's MUTATING/READONLY split in baseline files — leave baseline as-is.
