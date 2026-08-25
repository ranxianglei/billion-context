# Issue #242: Responses round-2 remapped id exceeds upstream 64-char limit

Codex Desktop rollout replays a `msg-proxy-2-<54-char-upstream-id>` (66 chars) as
`input[].id` and upstream 400s on every turn — conversation permanently stuck.

Requirements:
1. Proxy-synthesized Responses item ids must always fit the 64-char upstream cap.
2. Already-poisoned rollouts must recover without client-side cleanup.
3. Deterministic rewriting only — repeated requests must keep referencing the
   same replacement id; `call_id` values untouched.

#243 (Haerbin23456): root-cause fix — remap with `hashId()` instead of embedding
the upstream id (28 chars total). This branch adds the ingress healing on top.
