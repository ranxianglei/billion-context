# Worklog

## 2026-09-27

- Root cause: `sanitizeResponsesInputIds` (src/loop/adapter-responses.ts)
  rewrote ANY over-64-char `input[].id` to `msg-fix-<hashId>` regardless of
  item type. The generic scope came from the #242 healing (30b33244), whose
  poisoning class is specifically over-long `msg-proxy-*` ids — but it also
  renames provider-issued opaque ids (reasoning `rs_*`, function_call
  `fc_*`, custom_tool_call, item_reference, compaction), which upstreams with
  id-shape validation (Copilot Responses API) reject with HTTP 400 every
  turn (#1474).
- Fix: gate the length rewrite on `rec.id.startsWith("msg-proxy-")`.
  Provider/client-owned ids now cross ingress byte-identical (wire fidelity);
  Bili's own namespace keeps the deterministic #242 healing. Branch 1
  (`msg-proxy-*` assistant message → omit id on replay) untouched. No
  prefix-compliant substitutes introduced (prefix compliance ≠ acceptance;
  renaming breaks reasoning id ↔ encrypted_content correspondence).
- Key files: src/loop/adapter-responses.ts (doc comment + branch-2 gate),
  tests/responses-proxy-id-replay.test.ts (stale generic-rewrite test
  replaced by byte-identical provider-item coverage + scoped-healing test),
  tests/responses-round2-lifecycle.test.ts (#242 regression, unchanged,
  still green).
- Verified: rebased onto master @ cae30bb3 (post-#1448; target function
  verified unchanged there) — typecheck ✅, full suite 2884 pass / 0 fail /
  12 skip (gated e2e) ✅, build ✅. Real-client E2E runs in CI (diff touches
  src/loop/**).
- Behavior change disclosed in PR + issue reply: previously any over-64
  input id was rewritten; now only over-64 `msg-proxy-*` ids are. Non-Bili
  invented >64-char ids are no longer healed (they did not exist outside
  old bili versions, which all used `msg-proxy-*`).
