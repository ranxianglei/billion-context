# WORKLOG: acp-loop upstream truncation — zero-side-effect retry, well-formed Anthropic error stream, single-point logging

- Task ID: `2026-09-02_acp-loop-truncation-retry`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-09-02

## 1. Summary

- **What was done**: (1) the compress loop now retries once when an upstream
  stream truncates (200 + early EOF) after forwarding nothing to the client;
  (2) the Anthropic adapter's `emitError` now synthesizes a `message_start`
  if none was forwarded and closes every block still open at error time;
  (3) the truncation event is logged once (via `ctx.log`) instead of twice.
- **Why**: zero-side-effect truncations are the most common recoverable
  upstream flake (3 in 3 days in production, two of them 0+0); failing fast
  lands the flake in the host session. The orphan stream shape violates the
  Anthropic stream protocol and can crash strict clients (the responses
  branch already fixed its own copy of this class). Double logging makes
  incident triage count events wrong.
- **Behavior / compatibility changes**: Yes, three —
  1. A first-round (or any-round) truncation that forwarded nothing and
     executed no tool calls now triggers exactly one retry through
     `fetchWithRetry` before the error is surfaced. Clients see either a
     clean successful stream or the error stream — never a partial one.
  2. The Anthropic error stream is now always well-formed: starts with
     `message_start`, every `content_block_start` has a matching
     `content_block_stop`, ends with `message_delta` + `message_stop`.
  3. Truncation is logged once at `info` (session-prefixed) instead of twice
     (`info` + `error`).
- **Risk level**: Low. The retry is gated on a strict zero-side-effect
  predicate (nothing forwarded, no tool calls, nothing accumulated for the
  host, not aborted, not already retried); the adapter change only adds
  frames that strict clients require; logging change is cosmetic.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha>` | fix: acp-loop zero-side-effect truncation retry + well-formed anthropic error stream (#413) |

### Key Files

- `src/loop/core.ts` — retry loop around the per-round parse; hoisted
  `fetchUpstream`; dropped the second (global error) log line on truncation;
  `roundBody` tracks the last body actually sent so a retry re-sends the
  compressed round body, not the original request.
- `src/loop/adapter-anthropic.ts` — `messageStartForwarded` / `openBlocks`
  tracking in the adapter closure; `buildSyntheticMessageStart()`;
  `emitError` closes open blocks and backfills the starting frame.
- `tests/loop-truncation.test.ts` — new; 6 tests covering all three
  acceptance criteria plus retry-body tracking and the once-per-request cap.

## 3. Design & Implementation Notes

See `DESIGN.md` for the dataflow and the safety invariants.
