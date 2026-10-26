import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

// #2886: neverPreserveRecentTools drops big-result tools (read/bash/...) from
// the recent-zone `visible` set, so a matching tool-result can never enter the
// zone while its paired tool-call (an unmatched name) can. computeProtectedRefs
// must therefore stay SYMMETRIC per (tool-call, tool-result) pair: if either
// half lands in the protected zone, both do. Otherwise the advisory carve (and
// the plugin-mode recommendations built off the same set) keep the call visible
// while folding the result, stranding an orphan function_call that strict
// Responses validators reject with HTTP 400 invalid_request_error.

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolCall(id: string, toolName: string, toolCallId: string): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName, toolCallId };
}

function toolResult(
  id: string,
  toolName: string | undefined,
  text: string,
  toolCallId: string,
): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    ...(toolName ? { toolName } : {}),
    toolCallId,
    text,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function seededState(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

test("computeProtectedRefs protects the tool-result when its paired call is in the recent zone (#2886)", async () => {
  const { computeProtectedRefs } = await import("../src/recommend.js");
  // m00002 is an assistant call whose name ("pwsh") is NOT in the built-in
  // neverPreserve list → it is visible and enters the last-2 window. m00003 is
  // its paired result whose name ("read") IS in the list → excluded from
  // `visible`, so it could never reach the zone on its own. The pair shares
  // toolCallId c1.
  const messages: CoreMessage[] = [
    msg("a", "old alpha context"),
    toolCall("b", "pwsh", "c1"),
    toolResult("c", "read", "x".repeat(200), "c1"),
    msg("d", "latest user intent gamma"),
  ];
  const state = seededState(messages);
  const refs = computeProtectedRefs(messages, state, config({ preserveRecentMessages: 2 }));

  assert.ok(refs.has("m00002"), "the call in the recent zone is protected");
  assert.ok(
    refs.has("m00003"),
    "its paired read result is co-protected (was orphaned before the fix)",
  );
  assert.ok(refs.has("m00004"), "last user message still protected by Rule 3");
  assert.ok(!refs.has("m00001"), "older message outside the zone stays unprotected");
});

test("computeProtectedRefs protects the call when only its paired result is in the recent zone (#2886)", async () => {
  const { computeProtectedRefs } = await import("../src/recommend.js");
  // Both halves named "custom_tool" (not in the list) → both visible. With
  // preserveRecentMessages=1 only the tail result m00004 is inside the window;
  // the call m00003 sits just before it and reaches the zone ONLY via pairing.
  const messages: CoreMessage[] = [
    msg("a", "old alpha context"),
    msg("x", "older assistant beta"),
    toolCall("b", "custom_tool", "c1"),
    toolResult("c", "custom_tool", "y".repeat(200), "c1"),
  ];
  const state = seededState(messages);
  const refs = computeProtectedRefs(messages, state, config({ preserveRecentMessages: 1 }));

  assert.ok(refs.has("m00004"), "the result at the tail of the zone is protected");
  assert.ok(
    refs.has("m00003"),
    "its paired call is co-protected via toolCallId linkage (reverse direction)",
  );
});

test("pair-awareness binds by toolCallId even when the result lost its backfilled name (#2886)", async () => {
  const { computeProtectedRefs } = await import("../src/recommend.js");
  // A function_call_output whose paired call was not earlier in the array gets
  // no backfilled toolName (wire/responses.ts). An unnamed result is treated as
  // visible, so it can sit in the recent zone while its named call does not.
  // Pairing must still hold via toolCallId, independent of toolName.
  const messages: CoreMessage[] = [
    msg("a", "old alpha context"),
    toolCall("b", "grep", "c1"),
    toolResult("c", undefined, "z".repeat(200), "c1"),
  ];
  const state = seededState(messages);
  const refs = computeProtectedRefs(messages, state, config({ preserveRecentMessages: 1 }));

  assert.ok(refs.has("m00003"), "unnamed result in the zone is protected");
  assert.ok(refs.has("m00002"), "its paired call is co-protected despite no shared name");
});

test("does NOT over-protect: an older pair outside the recent zone stays fully compressible (#2886)", async () => {
  const { computeProtectedRefs } = await import("../src/recommend.js");
  // A read call+result that has aged OUT of the recent window must remain
  // compressible — pair-awareness must only ADD protection to pairs already
  // touching the zone, never drag older big results into it.
  const messages: CoreMessage[] = [
    toolCall("b", "read", "c1"),
    toolResult("c", "read", "spent body " + "x".repeat(200), "c1"),
    msg("d", "newer user delta"),
    msg("e", "even newer assistant epsilon"),
    msg("f", "latest user zeta"),
  ];
  const state = seededState(messages);
  const refs = computeProtectedRefs(messages, state, config({ preserveRecentMessages: 2 }));

  // visible excludes b,c (read); window covers e,f (+ last user f). Neither
  // half of the aged-out pair is in the zone, so neither should be protected.
  assert.ok(!refs.has("m00001"), "aged-out read call stays compressible");
  assert.ok(!refs.has("m00002"), "aged-out read result stays compressible");
});

test("applyCompression does not strand an orphan function_call at the recent boundary (#2886)", () => {
  const core = createCore();
  // Bulk head that genuinely folds, then an asymmetric recent pair: the call's
  // name ("pwsh") is protectable, the result's name ("read") is excluded from
  // the zone. Range ends at the result so the trailing user msg is outside it.
  const messages: CoreMessage[] = [
    msg("bulk1", "first detailed work item alpha content"),
    msg("bulk2", "second detailed work item beta content"),
    msg("bulk3", "third detailed work item gamma content"),
    msg("bulk4", "fourth detailed work item delta content"),
    toolCall("call", "pwsh", "c1"),
    toolResult("result", "read", "file body " + "x".repeat(300), "c1"),
    msg("last", "latest user intent theta"),
  ];
  const state = seededState(messages);
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00006", summary: "fold the spent head", topic: "head" },
    ],
    messages,
    state,
    config: config({ preserveRecentMessages: 2 }),
  });

  assert.equal(result.result.errors.length, 0, `unexpected errors: ${result.result.errors.join("; ")}`);
  assert.ok(result.result.blocksCreated >= 1, "the bulk head still compresses");
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  const folded = new Set(block.effectiveMessageIds);
  // The orphan condition is: the result folded while its call stayed visible.
  assert.ok(
    !(folded.has("result") && !folded.has("call")),
    "orphan: result was folded while its paired call stayed visible",
  );
  // With the fix both halves are co-protected, so neither is folded here.
  assert.ok(!folded.has("call"), "recent call stays visible");
  assert.ok(!folded.has("result"), "recent result is co-protected and stays visible");
});
