import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage, CompressionState } from "../src/types.js";

// #7596: one range whose fresh-fold integrity withdrawal leaves it with
// NOTHING foldable (a tool turn astride the protected-zone boundary: the
// fold keeps the visible call's reasoning + results, which strands the rest,
// so the whole range is withdrawn) must be a NO-OP SUCCESS with a warning —
// not a fatal that, under the atomic batch contract, rolled back every
// sibling range that would have folded fine. The field shape: a session whose
// newest turn is reasoning + tool calls with some results already protected
// (last-N visible + #2886 pair symmetry), and a submitted range covering the
// turn's reasoning + calls only. Before the fix the batch returned
// "Batch rejected before folding any range — 1 of 3 requested range(s)
// failed during application: range m00017..m00021: Range would split 1
// turn(s) at the protected-zone boundary..." with blocksCreated 0.
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
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 4,
    preserveRecentTools: ["bash"],
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function buildState(): { state: CompressionState; messages: CoreMessage[] } {
  const M: CoreMessage[] = [];
  for (let i = 0; i < 8; i++) {
    M.push({ id: `u${i}`, role: "user", contentType: "text", text: `task ${i} with some body` });
    M.push({ id: `a${i}`, role: "assistant", contentType: "text", text: `done task ${i} ...` });
  }
  M.push({ id: "r1", role: "assistant", contentType: "reasoning", text: "long reasoning run" });
  for (let i = 0; i < 4; i++) {
    M.push({ id: `c${i}`, role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: `call_${i}`, text: `call ${i}` });
  }
  for (let i = 0; i < 4; i++) {
    M.push({ id: `t${i}`, role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: `call_${i}`, text: `output ${i}` });
  }
  M.push({ id: "a9", role: "assistant", contentType: "text", text: "all commands finished" });
  const state = createInitialState();
  state.messageRefs = assignRefs(M, { existing: state.messageRefs, nextIndex: 1 }).map;
  return { state, messages: M };
}

test("a split-doomed range is a no-op and its siblings still fold (#7596)", () => {
  const core = createCore();
  const { state, messages } = buildState();
  const refOf = (id: string) => state.messageRefs.byRaw[id]!;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00008", summary: "early tasks 0-3" },
      { startRef: refOf("r1"), endRef: refOf("c3"), summary: "the long command turn" },
      { startRef: "m00009", endRef: "m00016", summary: "early tasks 4-7" },
    ],
    messages,
    state,
    config: config(),
  });

  // SIBLINGS FOLD — the batch is no longer killed by the doomed middle range.
  // Exact geometry: b1 = u0..a3; b2 = u4..a6, because m00015 (u7) is the
  // last-user anchor (protected) and #3953 keeps its reply a7 visible too.
  assert.equal(result.result.blocksCreated, 2);
  assert.deepEqual(result.result.errors, []);
  assert.equal(result.state.blocks.length, 2);
  const direct = result.state.blocks.map((b) => [...b.directMessageIds].sort());
  assert.deepEqual(direct[0], ["a0", "a1", "a2", "a3", "u0", "u1", "u2", "u3"]);
  assert.deepEqual(direct[1], ["a4", "a5", "a6", "u4", "u5", "u6"]);

  // The doomed range reports NO-OP with an accurate warning: no error text,
  // and the model is told not to resend it (no phantom ref it can copy).
  assert.equal(
    result.result.warnings.filter((w) => /folded nothing/.test(w)).length,
    1,
  );
  const warn = result.result.warnings.find((w) => /folded nothing/.test(w))!;
  assert.match(warn, new RegExp(`Range ${refOf("r1")}\.\.${refOf("c3")} folded nothing`));
  assert.match(warn, /withdrawn in full instead of split/);
  assert.match(warn, /do not resend this range as-is/);
  assert.match(warn, /highest allocated ref is m00026/);
  // Nothing from the split turn may have entered any block.
  for (const b of result.state.blocks) {
    for (const id of ["r1", "c0", "c1", "c2", "c3", "t0", "t1", "t2", "t3", "a9"]) {
      assert.ok(!b.directMessageIds.includes(id));
    }
  }
});

test("a lone split-doomed range is a no-op success, not a batch rejection (#7596 control)", () => {
  const core = createCore();
  const { state, messages } = buildState();
  const refOf = (id: string) => state.messageRefs.byRaw[id]!;

  const result = core.applyCompression({
    ranges: [{ startRef: refOf("r1"), endRef: refOf("c3"), summary: "the long command turn" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.deepEqual(result.result.errors, []);
  assert.equal(result.state.blocks.length, 0);
  assert.equal(result.result.warnings.length, 1);
  assert.match(result.result.warnings[0]!, /folded nothing/);
  assert.match(result.result.warnings[0]!, /do not resend this range as-is/);
});
