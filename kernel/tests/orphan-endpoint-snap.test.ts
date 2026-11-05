import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { resolveBoundaries, BoundaryNotFoundError } from "../src/boundaries.js";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { assignRefs } from "../src/refs.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "assistant",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function compressCall(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName: "compress",
    toolCallId: callId,
    text: '{"content":[{"startId":"m00001","endId":"m00002","summary":"s"}]}',
  };
}

function compressResult(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "tool-result",
    toolName: "compress",
    toolCallId: callId,
    text: "compressed",
  };
}

function config(): Config {
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
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
  };
}

// The hide pass records hidden-orphan refs so a later applyCompression can snap onto one (#396).
test("hideConsumedCompressCalls records refs of hidden orphan calls only", () => {
  const state = createInitialState();
  const messages: CoreMessage[] = [
    compressCall("k1", "c1"),
    compressResult("r1", "c1"),
    compressCall("k2", "c2"),
    compressResult("r2", "c2"),
    compressCall("k3", "c3"),
    compressResult("r3", "c3"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state.sweptOrphanCallIds = ["c1"];

  const result = hideConsumedCompressCalls(state, messages);

  assert.equal(
    result.hidden,
    2,
    "previously-swept orphan pair stays hidden (#3769)",
  );
  assert.deepEqual(
    result.hiddenOrphanRefs,
    ["m00001", "m00002"],
    "only the hidden orphan call+result refs are recorded",
  );
});

test("resolveBoundaries snaps a hidden-orphan start endpoint forward", () => {
  const state = createInitialState();
  const visible = [
    msg("v1", "a"),
    msg("v2", "b"),
    msg("v3", "c"),
    msg("v6", "d"),
    msg("v7", "e"),
    msg("v8", "f"),
  ];
  state.messageRefs = {
    byRaw: {
      v1: "m00001",
      v2: "m00002",
      v3: "m00003",
      v6: "m00006",
      v7: "m00007",
      v8: "m00008",
      orphanCall: "m00005",
    },
    byRef: {
      m00001: "v1",
      m00002: "v2",
      m00003: "v3",
      m00005: "orphanCall",
      m00006: "v6",
      m00007: "v7",
      m00008: "v8",
    },
  };
  state.hiddenOrphanRefs = ["m00005"];

  const resolved = resolveBoundaries({
    startRef: "m00005",
    endRef: "m00008",
    messages: visible,
    state,
  });

  assert.equal(
    resolved.startIndex,
    3,
    "start snaps forward to first visible message after the orphan",
  );
  assert.equal(resolved.endIndex, 5, "end resolves normally");
  assert.equal(
    resolved.snappedBoundaries.length,
    1,
    "one boundary reported as snapped",
  );
});

test("resolveBoundaries snaps a hidden-orphan end endpoint backward", () => {
  const state = createInitialState();
  const visible = [
    msg("v1", "a"),
    msg("v2", "b"),
    msg("v3", "c"),
    msg("v6", "d"),
  ];
  state.messageRefs = {
    byRaw: {
      v1: "m00001",
      v2: "m00002",
      v3: "m00003",
      v6: "m00006",
      orphanCall: "m00005",
    },
    byRef: {
      m00001: "v1",
      m00002: "v2",
      m00003: "v3",
      m00005: "orphanCall",
      m00006: "v6",
    },
  };
  state.hiddenOrphanRefs = ["m00005"];

  const resolved = resolveBoundaries({
    startRef: "m00001",
    endRef: "m00005",
    messages: visible,
    state,
  });

  assert.equal(
    resolved.endIndex,
    2,
    "end snaps backward to last visible message before the orphan",
  );
  assert.equal(resolved.snappedBoundaries.length, 1);
});

// Regression guard (billion-context#387): a ref whose message drifted to a new rawId is NOT a
// hidden orphan, so it must keep the clear "consumed" error and never be silently snapped.
test("a dangling ref NOT in hiddenOrphanRefs still throws consumed (drift preserved)", () => {
  const state = createInitialState();
  const visible = [msg("v1", "a"), msg("v2", "b"), msg("v6", "c")];
  state.messageRefs = {
    byRaw: { v1: "m00001", v2: "m00002", v6: "m00006", driftedGone: "m00005" },
    byRef: {
      m00001: "v1",
      m00002: "v2",
      m00005: "driftedGone",
      m00006: "v6",
    },
  };

  assert.throws(
    () =>
      resolveBoundaries({
        startRef: "m00005",
        endRef: "m00006",
        messages: visible,
        state,
      }),
    (e: unknown) =>
      e instanceof BoundaryNotFoundError &&
      e.kind === "consumed" &&
      e.endpoint === "start",
  );
});

test("hidden-orphan endpoint with no neighbor in direction gives an accurate error", () => {
  const state = createInitialState();
  const visible = [msg("v1", "a"), msg("v2", "b")];
  state.messageRefs = {
    byRaw: { v1: "m00001", v2: "m00002", orphanCall: "m00003" },
    byRef: { m00001: "v1", m00002: "v2", m00003: "orphanCall" },
  };
  state.hiddenOrphanRefs = ["m00003"];

  assert.throws(
    () =>
      resolveBoundaries({
        startRef: "m00003",
        endRef: "m00002",
        messages: visible,
        state,
      }),
    (e: unknown) =>
      e instanceof BoundaryNotFoundError &&
      e.kind === "consumed" &&
      /no adjacent visible message/.test(e.message),
  );
});

// End-to-end for #396: the whole range used to be rejected "cannot be anchored" because its
// start was a hidden orphan; now it anchors past the orphan and compresses.
test("applyCompression succeeds when a range endpoint is a hidden orphan compress call (#396)", () => {
  const core = createCore();
  const state = createInitialState();
  const ids = [
    "u1",
    "a1",
    "b1",
    "c1",
    "d1",
    "e1",
    "f1",
    "g1",
    "h1",
    "i1",
    "j1",
    "k1",
  ];
  const visible = ids.map((id) =>
    msg(id, "lorem ipsum dolor sit amet ".repeat(20)),
  );
  const byRaw: Record<string, string> = {};
  const byRef: Record<string, string> = {};
  let refNum = 1;
  for (const id of ids) {
    if (refNum === 5) refNum = 6;
    const ref = `m${String(refNum).padStart(5, "0")}`;
    byRaw[id] = ref;
    byRef[ref] = id;
    refNum++;
  }
  byRaw["orphanCall"] = "m00005";
  byRef["m00005"] = "orphanCall";
  state.messageRefs = { byRaw, byRef };
  state.hiddenOrphanRefs = ["m00005"];

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00005",
        endRef: "m00013",
        summary: "recap of the visible span",
      },
    ],
    messages: visible,
    state,
    config: config(),
  });

  assert.equal(
    result.result.errors.length,
    0,
    `expected no errors, got ${JSON.stringify(result.result.errors)}`,
  );
  assert.equal(
    result.result.blocksCreated,
    1,
    "range anchored past the hidden orphan and compressed",
  );
  assert.ok(
    result.result.warnings.some((w) => /snapped/.test(w)),
    `expected a snapped-boundary warning, got ${JSON.stringify(result.result.warnings)}`,
  );
});
