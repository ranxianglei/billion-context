# Issue #242: round-2 Responses message id > 64 chars → permanent 400

Model: qwen3.8-27b (vllm)

## Request

https://github.com/ranxianglei/billion-context/issues/242 — round-2+ remapped
message ids embedded the full upstream id (`msg-proxy-${round}-${origId}`),
producing 66-char ids. Codex persists them into its rollout; every later
request replays them as input and upstream 400s
(`Invalid 'input[N].id': string too long … maximum length 64`), bricking the
conversation.

## Fix

1. **Root cause** — `src/loop/adapter-responses.ts` round-2 mapping now uses a
   deterministic FNV-1a 32-bit base36 digest: `msg-proxy-${round}-${shortItemHash(...)}`,
   ≤ ~21 chars regardless of upstream id length. Same-turn lifecycle events
   (added/deltas/parts/done) continue to share the remapped id via the
   existing `remapped` map.
2. **Healing** — `sanitizeResponsesInputIds()` (new export) rewrites any input
   item id > 64 chars to `msg-fix-${shortItemHash(id)}` (deterministic ⇒ stable
   across requests), called at the top of `prepareResponses` so poisoned
   rollouts recover on the next request without any user action.

## Verification

- tests/responses-round2-lifecycle.test.ts +2: round-2 with the exact 54-char
  id from the bug report (asserts ≤64 + lifecycle consistency), and
  sanitizeResponsesInputIds unit test (short ids untouched, deterministic,
  call_id untouched, idempotent).
- Full suite 595/595, typecheck, build green.
