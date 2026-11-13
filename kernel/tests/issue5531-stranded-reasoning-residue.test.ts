import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { collectCoverage, projectUnit } from "../src/unit-projection.js";
import { computeIntegrityWithdrawals } from "../src/turn-integrity.js";
import type { Config, CoreMessage } from "../src/types.js";

/**
 * billion-context#5531 — "每次增长压缩只回收一部分": strict-thinking sessions
 * (DeepSeek) whose turns were folded in the #564 reverse direction (call+result
 * covered by a block, reasoning+text left visible) accumulate PERMANENTLY
 * un-foldable residue: the global screen withdrew the stranded pair because a
 * covered call read as "kept visible", and apply rejected it the same way.
 * Coverage is not "kept" — these pins lock both directions of that fix.
 */

function user(id: string): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "text",
    text: `user-${id} ` + "x".repeat(200),
  };
}
function reasoning(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "reasoning",
    text: `think-${id} ` + "t".repeat(400),
  };
}
function text(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "text",
    text: `text-${id} ` + "x".repeat(200),
  };
}
function toolCall(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName: "pwsh",
    toolCallId: callId,
    text: `call-${callId}`,
  };
}
function toolResult(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "tool-result",
    toolName: "pwsh",
    toolCallId: callId,
    text: `result-${callId} ` + "r".repeat(200),
  };
}

/** One strict-thinking turn: [reasoning, text, call, result] flanked by users.
 *  Raw ids map to refs m00001..m00007 after processTurn. */
function buildMessages(): CoreMessage[] {
  return [
    user("u1"), // m00001
    reasoning("r"), // m00002
    text("t"), // m00003
    toolCall("c", "ca"), // m00004
    toolResult("res", "ca"), // m00005
    user("u6"), // m00006
    user("u7"), // m00007
  ];
}

const config = (): Config => ({
  ...defaultConfig(150000),
  preserveRecentMessages: 0,
  preserveRecentTokens: 0,
  compress: {
    ...defaultConfig(150000).compress,
    minCompressRange: 1,
    minSummaryLength: 1,
  },
});

const countTokens = (t: string) => Math.ceil(t.length / 4);

/** Seed the #564 reverse split: fold ONLY the call+result, leaving the turn's
 *  reasoning+text visible beside the new block. */
async function seedReverseSplit() {
  const core = createCore();
  const messages = buildMessages();
  const out = core.processTurn({
    messages,
    state: createInitialState(),
    config: config(),
    tokenCount: countTokens,
  });
  const seed = core.applyCompression({
    state: out.state,
    messages,
    config: config(),
    ranges: [{ startRef: "m00004", endRef: "m00005", summary: "s".repeat(400) }],
  });
  const block = seed.state.blocks.find((b) => b.active);
  assert.ok(block, "seed fold must create a block");
  assert.ok(block.effectiveMessageIds.includes("c"));
  assert.ok(block.effectiveMessageIds.includes("res"));
  assert.ok(
    !block.effectiveMessageIds.includes("r") &&
      !block.effectiveMessageIds.includes("t"),
    `seed must cover only call+result, got ${JSON.stringify(block.effectiveMessageIds)}`,
  );
  return { core, messages, state: seed.state };
}

describe("#5531 gate: a covered call cannot strand its turn's reasoning", () => {
  it("legacy semantics WITHDRAW the stranded pair (the bug mechanism)", async () => {
    const { messages, state } = await seedReverseSplit();
    // Without the invisible set, the covered call reads as kept-visible and
    // the whole turn is withdrawn — this is exactly why the residue was
    // permanent. Pinning the old verdict documents what the fix overrides.
    const legacy = computeIntegrityWithdrawals(
      messages,
      new Set(["r", "t"]),
    ).withdrawn;
    assert.ok(legacy.has("r") && legacy.has("t"), "legacy gate strands the pair");
  });

  it("with coverage as invisible, the stranded pair stays foldable", async () => {
    const { messages, state } = await seedReverseSplit();
    const gate = computeIntegrityWithdrawals(
      messages,
      new Set(["r", "t"]),
      undefined,
      collectCoverage(state),
    ).withdrawn;
    assert.ok(!gate.has("r") && !gate.has("t"), JSON.stringify([...gate]));
  });
});

describe("#5531 recommend: stranded reasoning+text are advertised again", () => {
  it("buildCompressibleRanges offers the stranded pair as compressible", async () => {
    const { messages, state } = await seedReverseSplit();
    const ranges = buildCompressibleRanges(messages, state, config());
    const byRaw = state.messageRefs.byRaw;
    const refOf = (raw: string) => byRaw[raw]!;
    const inRange = (raw: string) =>
      ranges.compressible.some(
        (r) => r.startRef <= refOf(raw) && refOf(raw) <= r.endRef,
      );
    assert.ok(inRange("r"), "stranded reasoning must be advertised");
    assert.ok(inRange("t"), "stranded text must be advertised");
  });

  it("projectUnit judges the stranded pair foldable (fatal === null)", async () => {
    const { messages, state } = await seedReverseSplit();
    const byRaw = state.messageRefs.byRaw;
    const projection = projectUnit({
      messages,
      state,
      config: config(),
      startRef: byRaw["r"]!,
      endRef: byRaw["t"]!,
      preExistingCoverage: collectCoverage(state),
    });
    assert.equal(projection.fatal, null, projection.fatal?.error.message);
    assert.ok(projection.filteredIds.includes("r"));
    assert.ok(projection.filteredIds.includes("t"));
  });

  it("closed loop: the advertised stranded range folds without a split error", async () => {
    const { core, messages, state } = await seedReverseSplit();
    const byRaw = state.messageRefs.byRaw;
    const ranges = buildCompressibleRanges(messages, state, config());
    const target = ranges.compressible.find(
      (r) => r.startRef <= byRaw["r"]! && byRaw["r"]! <= r.endRef,
    );
    assert.ok(target, "recommendation must contain the stranded pair");
    const res = core.applyCompression({
      state,
      messages,
      config: config(),
      ranges: [
        {
          startRef: target!.startRef,
          endRef: target!.endRef,
          summary: "reclaiming the stranded turn head",
        },
      ],
    });
    assert.deepEqual(res.result.errors, [], JSON.stringify(res.result.errors));
    assert.ok(res.result.blocksCreated >= 1, "a recovery block must be created");
    const block = res.state.blocks.find((b) => b.active && b !== state.blocks[0]);
    assert.ok(block, "new block distinct from the seed block");
    assert.ok(block.effectiveMessageIds.includes("r"));
    assert.ok(block.effectiveMessageIds.includes("t"));
  });
});

describe("#5531 negative: a VISIBLE call still guards its reasoning", () => {
  // Same geometry, but nothing covers the call: protecting it (recent zone /
  // protected tools) instead means folding r+t would orphan a LIVE call — the
  // original #684 doctrine must still hold.
  function freshSeeded() {
    const core = createCore();
    const messages = buildMessages();
    const out = core.processTurn({
      messages,
      state: createInitialState(),
      config: config(),
      tokenCount: countTokens,
    });
    return { core, messages, state: out.state };
  }

  it("projectUnit still fatals 'split' when the call stays visible", () => {
    const { messages, state } = freshSeeded();
    const byRaw = state.messageRefs.byRaw;
    // Protecting the call+result is what makes them KEPT (not folded) while
    // the range carries the reasoning — the geometry #684 exists to refuse.
    const projection = projectUnit({
      messages,
      state,
      config: config(),
      startRef: byRaw["r"]!,
      endRef: byRaw["t"]!,
      preExistingCoverage: new Set(),
      protectedMessageIds: new Set([byRaw["c"]!, byRaw["res"]!]),
    });
    assert.ok(projection.fatal, "visible call must keep its reasoning");
    assert.equal(projection.fatal!.kind, "split");
    assert.match(projection.fatal!.error.message, /split 1 turn/);
  });

  it("buildCompressibleRanges does NOT advertise the pair while the call is visible", () => {
    const { messages, state } = freshSeeded();
    const byRaw = state.messageRefs.byRaw;
    // With NO carve-out the whole turn folds atomically (legitimate), so the
    // suppression case is a zone brush: the call+result sit in the protected
    // zone (visible, kept) while the range would carry the reasoning.
    const zoneRefs = new Set([byRaw["c"]!, byRaw["res"]!]);
    const ranges = buildCompressibleRanges(messages, state, config(), zoneRefs);
    const inRange = (raw: string) =>
      ranges.compressible.some(
        (r) => r.startRef <= byRaw[raw]! && byRaw[raw]! <= r.endRef,
      );
    assert.ok(!inRange("r"), "orphaned-reasoning fold must stay suppressed");
    assert.ok(!inRange("t"));
  });

  it("applyCompression still refuses the split with the canonical error", () => {
    const { core, messages, state } = freshSeeded();
    const byRaw = state.messageRefs.byRaw;
    const protectedRefs = new Set([byRaw["c"]!, byRaw["res"]!]);
    const res = core.applyCompression({
      state,
      messages,
      config: config(),
      protectedMessageIds: protectedRefs,
      ranges: [{ startRef: "m00002", endRef: "m00003", summary: "s".repeat(400) }],
    });
    assert.equal(res.result.blocksCreated, 0);
    assert.equal(res.result.errors.length, 1);
    assert.match(res.result.errors[0]!, /split 1 turn/);
  });
});
