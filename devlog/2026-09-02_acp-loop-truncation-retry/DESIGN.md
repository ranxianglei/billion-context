# DESIGN: acp-loop truncation retry + well-formed Anthropic error stream

## Problem shape

`runCompressLoop` is an `AsyncGenerator<Buffer>`: it reads the upstream SSE
stream, forwards client-facing chunks as it parses them, and only knows the
stream was truncated *after* the parse loop ends without a done event
(`!sawDone`). `fetchWithRetry` cannot see this failure — it inspects
`response.ok` after headers and never reads the body. So recovery has to live
at loop level, where the "did I already commit to the client?" state is known.

## Retry predicate — the zero-side-effect invariant

A truncated round can be transparently replayed **iff** nothing observable
happened. All of these must hold at the end of the parse loop:

- `!sawDone` — the stream actually truncated;
- `!forwardedAny` — no chunk was yielded to the client this attempt. A
  per-attempt flag set by `fwd()` wrapping the five yield sites in the parse
  loop (raw text, synthetic text, raw reasoning, synthetic reasoning, meta).
  Ping-only streams count as forwarded (conservative: the client saw
  something, so a retry would duplicate it);
- `calls.length === 0` — no tool call was collected. The `tool_call` /
  marker / `emitText` yields happen *after* the parse loop, so they are not
  yet covered by `forwardedAny` and need explicit checks:
  - `calls.length === 0` rules out tool_call and marker yields (both are
    derived from `calls`);
  - `!(ctx.textProtocol && assistantText.length > 0)` rules out the
    text-protocol `emitText` yield (only emitted when textProtocol and the
    round produced text);
- `!signal?.aborted` — the client is still connected;
- `!truncationRetried` — function-level flag: at most ONE retry per request
  (the issue says "走一次"). The flag is never reset, so a second truncated
  round (round 2+) also fails fast.

Placement: the check runs **after** the parse loop and **before**
`recordUsage`. This matters: a round-2+ `message_start` sets `usage` without
forwarding anything, so recording before the retry check would double-count
the retried attempt's tokens.

Mechanics: the parse loop is wrapped in an inner `for (;;)` attempt loop.
On a qualifying truncation the loop calls `fetchUpstream(roundBody)` (the
hoisted `fetchWithRetry` wrapper — same backoff, same `BILI_REPLAY_RETRY_*`
env knobs, same #189 rejection logging) and `continue`s; the outer round
number is unchanged, so a round-1 retry re-parses as round 1 and its
`message_start` is forwarded exactly once (attempt 1 forwarded nothing).
Per-attempt state (text/reasoning/calls/usage/finishReason/sawDone/
suppressCompletion/forwardedAny) is reset at the top of the attempt loop.

`roundBody` (new): the re-request path replaces the body each round
(`compressMessages`); the old code re-fetched with `requestOptions` + a local
`newBody`. The retry must re-send **the body that produced the truncated
stream** — on round 1 that is the original `requestBody`, on round N it is
the compressed body. `roundBody` is updated right before the
`currentUpstream` swap, so it always holds the last body actually sent.

Failure of the retry itself falls through to the existing truncation error
path (empty body on the retry response is converted to
`UpstreamHttpError` so it is caught by the same handler).

## Adapter: tracking what was forwarded

The Anthropic adapter closure gains two pieces of state:

- `messageStartForwarded: boolean` — set where the round-1 `message_start`
  is forwarded (always forwarded in round 1, so the flag is set there);
- `openBlocks: number[]` — client indices of blocks whose
  `content_block_start` was forwarded but whose `content_block_stop` was not.
  Pushed in the non-tool `content_block_start` branch (forwarded in all
  rounds); removed in the `content_block_stop` branches via an `indexOf`
  guard (tool_use blocks are never pushed — they are buffered in `pending`
  and emitted as a whole later).

`emitError(message)` now emits, in order:

1. synthetic `message_start` (if `!messageStartForwarded`) —
   `buildSyntheticMessageStart()`: the captured `messageId` if any, else a
   generated `msg_acp_error_<ts>` id; empty `content`, null stop reason,
   zero usage, the request model if known. Zero usage is honest: nothing
   completed.
2. `content_block_stop` for every index in `openBlocks` (drained);
3. the existing error text block (`[acp-proxy: <message>]`);
4. the existing terminal (`message_delta` + `message_stop`).

Result: the stream is always well-formed — starting frame first, every block
closed, terminal last — regardless of where the truncation hit (before
`message_start`, mid-thinking-block, mid-text-block, or after everything).

On the retry path the adapter state is all-initial at re-parse time
(`messageId` undefined, `clientIndex` 0, flag false, no open blocks), so the
re-parsed stream is shaped exactly like a fresh first parse — consistent.

## Logging

The truncation path keeps `ctx.log` (session-prefixed `info` line, which is
what session-level dashboards key on) and drops the global
`loggerLog("error", ...)` duplicate. One event, one line. (The upstream-HTTP
failure path on re-request still double-logs — same pattern, out of scope,
reported in the PR.)

## What is NOT retried (and why)

- Anything that forwarded a single byte to the client (retry would emit a
  duplicate/partial stream the client cannot reconcile);
- Any round that collected a tool call or ran a proxy tool (side effects);
- Text-protocol rounds that accumulated text (the post-loop `emitText` yield
  would double it);
- Aborted requests;
- Second and later truncations within one request (one retry, per the issue).
