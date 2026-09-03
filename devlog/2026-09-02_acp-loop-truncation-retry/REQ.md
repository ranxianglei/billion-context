# REQ: acp-loop upstream truncation — zero-side-effect retry, well-formed Anthropic error stream, single-point logging

Issue #413: when the upstream LLM returns 200 but the SSE stream ends early
(no `message_delta`/`message_stop`), the compress loop (`src/loop/core.ts`)
fails fast with `emitError` and no recovery. Three concrete defects, all
confirmed by code read + red tests before the fix:

1. **No retry for zero-side-effect truncation.** `fetchWithRetry` only wraps
   the re-request fetches (it inspects `response.ok` after headers and never
   reads the body — mid-stream EOF is only observable at loop level via the
   missing done event). A round that forwarded nothing to the client
   (`0 text + 0 reasoning + 0 executed tools`, nothing yielded) is a
   zero-side-effect retry candidate; the loop instead surfaced the upstream
   flake to the host session. Production evidence: 3 truncation events in
   3 days, two of them 0+0 (2026-08-31T00:35:24Z, 2026-08-31T06:03:43Z).
2. **Orphan Anthropic stream on first-round truncation.** The adapter's
   `emitError` is stateless w.r.t. what was already forwarded: it emits
   `content_block_start/delta/stop + message_delta + message_stop` directly.
   If the stream truncated before `message_start` reached the client, the
   client sees a `content_block_*` sequence with no starting frame —
   malformed per the Anthropic stream protocol. Open `thinking` blocks left
   by the truncation are never closed either. The responses branch already
   fixed the same class (see `src/stream-error.ts` comment); the Anthropic
   adapter was missed.
3. **Double logging.** Every truncation event was logged twice: `ctx.log`
   (→ `log("info", "[sid] ...")`) plus a global `loggerLog("error", ...)` —
   both tee to the same file + stderr.

## Acceptance criteria (from the issue)

- Stub upstream: headers then 0-event EOF → exactly 1 retry observed; after
  the failed retry the client stream passes "SSE start frame before
  content_block" schema validation.
- Truncation fixture with open blocks: every `content_block_start` has a
  matching `content_block_stop` before stream end.
- Each single truncation produces exactly 1 log line.

## Constraints

- The retry must be provably side-effect-free: nothing forwarded to the
  client, no tool calls executed, no usage recorded, no state mutation.
- At most ONE retry per request (the issue says "走一次").
- No new dependencies; `fetchWithRetry` reuse (same backoff/env knobs).
- The re-request path's behavior (degraded retry, #189 rejection logging)
  is unchanged; only its `fetchUpstream` definition is hoisted.

## Non-goals (reported in the PR, not fixed)

- `adapter-responses.ts` `emitError`: a `response.failed` without a prior
  `response.created` is the same orphan class if the stream truncated before
  the created event.
- `core.ts` upstream-error path (HTTP failure on re-request) also double-logs
  (`ctx.log` + `loggerLog("error")`) — same pattern; the issue only reported
  the truncation one.
- Truncation with `reRequest = true` (truncated after a complete proxy tool
  call, before the done event) is silently swallowed — the loop continues to
  the next round. Arguably benign; unchanged.
