# Wire Contracts (WC ledger)

Permanent ledger of upstream wire constraints discovered while implementing
declared custom-wire endpoints (#1295). Rule (owner policy): **every upstream
constraint discovered during implementation becomes a permanent WC entry** —
entries are never deleted, only superseded (mark `SUPERSEDED by WC-n`). Code
cites entries inline as `(WC-n)`; keep both sides in sync when touching these
paths.

## Umbrella rule — strict fidelity

A declared endpoint's request/response is converted **or relayed byte-for-byte
verbatim** — never partially. Any shape the codec cannot convert rejects the
whole body (one-time loud warning per endpoint, then silent relays). This is
the #1284 precedent applied per-wire: a same-path non-LLM endpoint, or any
future provider revision the codec does not understand, must surface loudly
and pass through untouched rather than be silently mangled.

## commandcode CLI wire (`wire: "commandcode"`)

Motivating case: `@mars-sea/dsh-commandcode-provider` Go plan —
`POST https://api.commandcode.ai/alpha/generate`; request = nested CLI
envelope around an openai-completions-shaped conversation; response = bare
JSONL event stream (one JSON object per line, NOT SSE).

| ID | Constraint | Consequence in bili |
|----|-----------|---------------------|
| WC-1 | `finish` and `error` events ARE the stream terminators. There is no `[DONE]` sentinel, no SSE framing, nothing after the terminal event. | The loop emits exactly one terminal frame (`finish` or `error`) and stops. `emitUpstreamTruncation` synthesizes an `upstream_stream_truncated` error line only when the stream cut BEFORE a terminal event was delivered; after delivery it writes nothing (`finished=true`). |
| WC-2 | Rewrap must never drop content mid-forward. | Roles the codec does not know (e.g. a compat-roles rewrite target) degrade to a `user` text message instead of being discarded. Unwrap is allowed to skip EMPTY messages (a user message whose text-part array yields no text, a content-less assistant) — they carry nothing to lose and compress-round re-sends omit them (#1295 review F2). |
| WC-3 | Upstream may emit lines/events bili does not understand (future revision risk). | Undecodable lines, unknown event types, and malformed events are forwarded byte-exact — on the first round only, before bili's own injections could be confused with upstream content. Never dropped, never rewritten. |
| WC-4 | Tool-call `arguments` are user intent (#1039 invariant) and must survive the round trip byte-semantically. | Unwrap: `input` object → `JSON.stringify` → `arguments` (non-object `input` rejects the whole body → verbatim relay). Rewrap: `arguments` string → JSON parse → `input` object (malformed → `{}`). bili's own proxy tools (`compress`, `decompress`, `search_context`, `acp_status`, `bili_*`) are ephemeral in proxy mode — executed server-side, NEVER forwarded to the client; real tool calls are replayed verbatim from the upstream's original event line. |
| WC-5 | The wire has no dedicated channel for visibility markers. | Injected markers ride as prose inside a `text-delta`. Whether a host TUI renders them invisibly is host-side policy (renderTags), not a wire concern. |
| WC-6 | v1 is streaming-only: the provider hardcodes `params.stream: true` and the bare-JSONL response codec assumes it. | Unwrap requires `params.stream === true`; anything else is not convertible → original bytes relayed verbatim with a one-time warning. |

### Envelope mapping (unwrap / rewrap)

- Every top-level envelope key except `params` (e.g. `config`, `memory`,
  `taste`, `skills`, `threadId`) passes through verbatim in both directions.
- Unknown `params.*` keys pass through verbatim (collected at unwrap, restored
  at rewrap) — a future provider adding fields must not break the round trip.
- `params.system` ↔ system-role messages: unwrap lifts it into a leading
  `system` message; rewrap folds all system messages back into the single
  `params.system` slot joined with `\n\n` (absent ⇒ omitted; present-but-empty
  ⇒ kept as `""`).
- Assistant blocks: `text` → content string, `reasoning` →
  `reasoning_content`, `tool-call {toolCallId,toolName,input}` → OpenAI
  `tool_calls[]` (id/name map remembered for rewrap fidelity).
- `user` content arrays accept `text` blocks only; `tool` results accept
  `output` of type `text` or `error-text` (string). Anything else rejects the
  whole body.
- Documented normalizations (semantically lossless, byte-level): multi-part
  `user` text blocks are joined with `\n` on unwrap and re-emitted as a single
  block; assistant `content` is always re-emitted as a block array (string
  content becomes one `text` block); `tool` results always carry `toolName` on
  rewrap (derived from the paired assistant call when absent, `"unknown"` when
  unpaired); a body whose messages contain no non-`system` role is rejected
  (nothing to compress).
- Usage: `finish.totalUsage.{inputTokens,outputTokens}` (+
  `inputTokenDetails.cacheReadTokens`) maps to the kernel usage triple
  `(inputTokens, outputTokens, cachedTokens)`.
- Errors: `{"type":"error","error":<code>,"message"}` — the client throws an
  `LlmError`; retry policy belongs to the CLI's HTTP layer, so bili's
  preflight/stream error frames carry code+message only.

## TRAE SOLO wire (`wire: "trae"`)

Motivating case: Trae IDE's in-house SOLO agent lane —
`POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`; request = an
openai-completions conversation inside a Trae envelope (`function: "solo_agent"`,
model id echoed in `config_name`, Max mode expressed purely in the body through
`mode_type` / `context_window_size` / `prompt_max_tokens`); response = an SSE
dialect whose frame names are its own.

| ID | Constraint | Consequence in bili |
|----|------------|---------------------|
| WC-12a | The conversation is openai-completions, but message content is ALWAYS an array of text parts — tool results included. | Unwrap joins text parts into a plain string; any non-text part (image/audio) rejects the whole body → verbatim relay. Rewrap turns every message back into one text part. |
| WC-12b | Tool calls keep OpenAI's envelope (`id`, `type: "function"`) but rename the payload key to `function_call`; an assistant turn carrying tool calls sets `content: null`. | Unwrap renames to `function`; rewrap renames back and restores `content: null` for tool turns (`arguments` survives byte-semantically, #1039). |
| WC-12c | The stream is `event:<name>` / `data:<json>` with NO space after the colon and NO `[DONE]` sentinel; the `done` frame terminates it. Frames: `metadata` → `timing_cost` → N×`output` → (`extra_info`) → `token_usage` → `done`. | The adapter parses that dialect; `emitCompletion` writes `token_usage` + `done`. A truncation synthesizes an `error` frame only when the cut happened before `done`. |
| WC-12d | Rewrap must never drop content mid-forward. | Roles this wire has no slot for (e.g. a compat-roles rewrite target) degrade to `user` text instead of being discarded. |
| WC-12e | Upstream may emit frames bili does not understand (future revision risk). | Unrecognized frame names and undecodable `data:` payloads are forwarded byte-exact — first round only, before bili's own injections could be confused with upstream content. |
| WC-12f | `token_usage` carries the real counters in the per-request fields; every `*_total` field is always 0. | Usage maps from `prompt_tokens` / `completion_tokens` / `cache_read_input_tokens`; the `*_total` fields are never read. |
| WC-12g | The wire has no dedicated channel for visibility markers. | Injected markers ride as prose inside an `output` frame's `response`; how they render is host-side policy. |
| WC-12h | `output.reasoning_content` streams through the same frame type as `response` (no separate reasoning event), and `extra_info` re-delivers reasoning that already streamed. | Reasoning maps to the reasoning channel; `extra_info` is forwarded verbatim (first round) and never re-injected into the rebuilt conversation. |

### Envelope mapping (unwrap / rewrap)

- `messages`: text parts → strings (and back, one part per message).
- `tools`: plain OpenAI shape, passed through unchanged.
- Envelope keys the flat body cannot carry (`function`, `config_name`,
  `mode_type`, `context_window_size`, `prompt_max_tokens`,
  `model_selection_strategy`, `model_auto_selection`, …) are captured verbatim
  at unwrap and replayed at the final forward boundary (and on every
  compress-loop re-send).
- Verification boundary: the request/response shapes above come from a real
  capture (#1295). The bili-side round trip is covered by unit tests; a full
  end-to-end replay through a real Trae client (compressed conversation echoed
  back by the IDE) has NOT been run — that needs a live seat.

