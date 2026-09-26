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
| WC-2 | Rewrap must never drop content mid-forward. | Roles the codec does not know (e.g. a compat-roles rewrite target) degrade to a `user` text message instead of being discarded. |
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
