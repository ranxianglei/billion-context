# WORKLOG — responses id length (#242)

Model: qwen3.8-27b (vllm)

1. Reproduced the arithmetic: `msg-proxy-2-` (12) + real OpenAI message id (54)
   = 66 > 64-char upstream cap. Only the round-2 remap site embeds origId;
   emitText/emitToolCall/emitMarker use `Date.now()` ids (~27 chars, safe).
2. Confirmed replay path: Codex rollout → next request `input[].id` →
   upstream 400 before any compression logic runs, so healing must sit at
   request ingress (`prepareResponses`), before `responsesToCore`/rebuild.
3. Added `shortItemHash` (FNV-1a 32-bit → base36) + `sanitizeResponsesInputIds`
   in adapter-responses.ts; server.ts imports and applies at ingress.
4. Branch off master after PR #241 merged (7b70419).

## Scope decisions

- `/responses/compact` ingress left untouched: a poisoned rollout 400s on its
  first regular request (compact never runs), and no new long ids are created
  after this fix.
- `call_id` fields untouched — the upstream error is specific to `input[].id`.
