# REQ: Preserve provider-issued reasoning IDs in Responses input sanitization

Issue: https://github.com/ranxianglei/billion-context/issues/1474

## Problem

`sanitizeResponsesInputIds` (src/loop/adapter-responses.ts, ingress via
`prepareResponses`, src/server.ts:3444) rewrites **any** Responses `input[]`
item whose string `id` exceeds 64 chars to `msg-fix-<hashId>` — without
checking the item's `type`. Provider-issued opaque items (`reasoning` with
`rs_*` ids, `function_call` with `fc_*` ids, `custom_tool_call`,
`item_reference`, `compaction`) therefore get renamed on every request.
Upstreams that validate id shape/namespace (e.g. the Copilot Responses API:
"Expected an ID that begins with 'rs'") reject the rewritten id with HTTP 400
on every turn, because the client keeps replaying its original long id and
bili rewrites it again each time.

## Root cause

The generic length rewrite was added for #242 (commit 30b33244) to heal
rollouts poisoned by over-long **Bili-generated** ids (pre-hashId round-2
mapping embedded the full 54-char upstream message id → 66 chars). Its scope
was written as "any id" instead of "Bili's own namespace". It renames
identifiers bili does not own; provider-issued ids are validated by their
owner's rules and carry replay correspondence (reasoning id ↔
`encrypted_content`), so they must cross ingress byte-identical.

Current bili never emits ids > 64 chars (all synthesized ids ≤ ~30 chars), so
the only ids that can reach the rewrite path today are historical
`msg-proxy-*` poison or provider-owned ids — the latter being exactly the
breakage.

## Acceptance criteria

1. Length-based rewrite applies ONLY to ids starting with `msg-proxy-`
   (the shape #242 healed). Everything else passes ingress byte-identical.
2. No prefix-compliant substitutes (`rs_<hash>` etc.) for provider ids —
   prefix compliance ≠ acceptance, and it breaks identity/replay
   correspondence.
3. Existing `msg-proxy-*` assistant-message handling (omit the local id on
   full-message replay) is unchanged.
4. Regression coverage: over-64 ids on `reasoning`, `function_call`,
   `custom_tool_call`, `item_reference` and provider `message` items remain
   byte-identical; over-64 `msg-proxy-*` ids keep the deterministic
   `msg-fix-*` healing; `tests/responses-proxy-id-replay.test.ts:55-70`
   updated to the new expectation.

## Constraints / behavior change disclosure

Old → new: previously ANY over-64 `input[].id` was rewritten to
`msg-fix-*`; afterwards only over-64 ids starting with `msg-proxy-` are.
A client that invented its own >64-char non-`msg-proxy` message ids would no
longer be healed (they pass through as-is). In practice such ids only ever
came from old bili versions (all `msg-proxy-*`) or from the provider itself,
so no real healing case is lost. This wire-shape change requires human review
(§7.4 auto-merge gate: wire/message-shape changes stay human).
