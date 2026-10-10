import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState, isLiveCheckpointCarrier } from "../src/state.js";
import { prune } from "../src/prune.js";
import { assignRefs } from "../src/refs.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { buildStatusReport } from "../src/report.js";
import { hasMediaPayload } from "../src/protected.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type { Config, CoreMessage, CompressionBlock } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
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
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

const PAD = "x".repeat(1600);

// #2638 production geometry (full-log host): head block b1, then checkpoint
// carriers A/B/M22 declaring b1's summary, with b2/b3 folded over the raws
// BETWEEN the carriers (carriers carved out of coverage on purpose). The old
// selector advertised spans bridging those carriers; the apply side resolved
// them to zero foldable messages and threw every turn.
test("selector never advertises spans the apply side structurally rejects (#2638 repro)", () => {
  const core = createCore();
  const cfg = config();
  let state = createInitialState();
  const messages: CoreMessage[] = [
    msg("1", "user asks to refactor"),
    msg("2", "assistant plan", "assistant"),
    msg("3", "work detail", "assistant"),
    msg("4", "more work", "assistant"),
    msg("5", "user marker mid-block"),
    msg("6", "wrap up", "assistant"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  let folded = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00006", summary: "head work" }],
    messages,
    state,
    config: cfg,
  });
  assert.equal(folded.result.errors.length, 0, folded.result.errors.join("; "));
  const b1 = folded.state.blocks[0]!.blockId;
  state = folded.state;

  messages.push({ ...msg("A", `[checkpoint ${b1}] ${PAD}`, "user"), summaryOfBlockId: b1 });
  for (let i = 8; i <= 16; i++)
    messages.push(msg(String(i), `mid message ${i}`, i % 2 ? "assistant" : "user"));
  messages.push({ ...msg("B", `[checkpoint ${b1}] ${PAD}`, "user"), summaryOfBlockId: b1 });
  for (let i = 18; i <= 21; i++)
    messages.push(msg(String(i), `mid tail ${i}`, "assistant"));
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 7,
  }).map;
  folded = core.applyCompression({
    ranges: [{ startRef: "m00008", endRef: "m00021", summary: "mid work" }],
    messages,
    state,
    config: cfg,
  });
  assert.equal(folded.result.errors.length, 0, folded.result.errors.join("; "));
  assert.ok(
    folded.result.warnings.some((w) => /checkpoint/.test(w)),
    "carrier B must be carved out with a checkpoint warning",
  );
  state = folded.state;

  messages.push({ ...msg("M22", `[checkpoint ${b1}] ${PAD}`, "user"), summaryOfBlockId: b1 });
  for (let i = 23; i <= 36; i++)
    messages.push(msg(String(i), `tail message ${i}`, i % 2 ? "assistant" : "user"));
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 22,
  }).map;
  folded = core.applyCompression({
    ranges: [{ startRef: "m00023", endRef: "m00036", summary: "tail work" }],
    messages,
    state,
    config: cfg,
  });
  assert.equal(folded.result.errors.length, 0, folded.result.errors.join("; "));
  state = folded.state;

  // Fresh ordinary content arrives — something IS compressible again.
  for (let i = 37; i <= 40; i++)
    messages.push(msg(String(i), `fresh message ${i}`, "assistant"));
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 37,
  }).map;

  // Steady state: three full turns through the pipeline. Every advertised
  // range must span no live carrier and must APPLY cleanly — the #2638
  // contract, checked per range instead of trusting one repro.
  for (let turn = 0; turn < 3; turn++) {
    const processed = core.processTurn({ messages, state, config: cfg, tokenCount: 70000 });
    state = processed.state;
    const ranges = processed.nudge?.compressibleRanges ?? [];
    assert.ok(ranges.length > 0, `turn ${turn}: fresh content must be advertised`);
    const pruned = prune(messages, state);
    const refIndex = new Map<string, number>();
    pruned.forEach((m, i) => {
      const ref = state.messageRefs.byRaw[m.id];
      if (ref && typeof ref === "string" && !ref.startsWith("BLOCKED"))
        refIndex.set(ref, i);
    });
    for (const range of ranges) {
      const lo = refIndex.get(range.startRef);
      const hi = refIndex.get(range.endRef);
      assert.notEqual(lo, undefined, `range start ${range.startRef} resolvable`);
      assert.notEqual(hi, undefined, `range end ${range.endRef} resolvable`);
      for (let i = lo!; i <= hi!; i++) {
        const m = pruned[i]!;
        assert.ok(
          !isLiveCheckpointCarrier(m, state),
          `advertised range ${range.startRef}..${range.endRef} spans live carrier ${m.id}`,
        );
      }
      const applied = core.applyCompression({
        ranges: [
          { startRef: range.startRef, endRef: range.endRef, summary: "steady-state fold" },
        ],
        messages,
        state: structuredClone(state),
        config: cfg,
      });
      assert.equal(
        applied.result.errors.length,
        0,
        `advertised range ${range.startRef}..${range.endRef} failed to apply: ${applied.result.errors.join("; ")}`,
      );
    }
  }

  // Negative control: the OLD advertised dead spans still fail on apply —
  // proving they were dead, so screening them out changes behavior.
  const deadSpan = core.applyCompression({
    ranges: [{ startRef: "m00017", endRef: "m00022", summary: "dead span" }],
    messages,
    state: structuredClone(state),
    config: cfg,
  });
  assert.equal(deadSpan.result.blocksCreated, 0);
  assert.ok(
    deadSpan.result.errors.some((e) => /contains no (new )?compressible messages/.test(e)),
    deadSpan.result.errors.join("; "),
  );
  const loneCarrier = core.applyCompression({
    ranges: [{ startRef: "m00007", endRef: "m00007", summary: "lone carrier" }],
    messages,
    state: structuredClone(state),
    config: cfg,
  });
  assert.equal(loneCarrier.result.blocksCreated, 0);
  assert.ok(
    loneCarrier.result.errors.some((e) => /contains no compressible messages/.test(e)),
    loneCarrier.result.errors.join("; "),
  );
});

test("buildCompressibleRanges treats a live carrier as a boundary; stale carriers fold", () => {
  const core = createCore();
  const cfg = config();
  let state = createInitialState();
  const messages = [
    msg("1", "q", "user"),
    msg("2", "a", "assistant"),
    msg("3", "b", "assistant"),
    msg("4", "c", "assistant"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const folded = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: "s" }],
    messages,
    state,
    config: cfg,
  });
  const b1 = folded.state.blocks[0]!.blockId;
  state = folded.state;
  const carrier = { ...msg("6", `[checkpoint ${b1}] body`, "user"), summaryOfBlockId: b1 };
  messages.push(msg("5", "after block a", "assistant"), carrier, msg("7", "after block b", "assistant"), msg("8", "after block c", "assistant"));
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 5,
  }).map;
  const carrierIdx = messages.findIndex((m) => m.id === "6");

  assert.ok(isLiveCheckpointCarrier(carrier, state));
  const live = buildCompressibleRanges(messages, state, cfg, undefined);
  assert.equal(live.compressible.length, 2, JSON.stringify(live.compressible));
  for (const r of live.compressible) {
    assert.ok(
      !(r.startIndex <= carrierIdx && carrierIdx <= r.endIndex),
      `live carrier must not sit inside advertised range ${r.startRef}..${r.endRef}`,
    );
  }

  const stale = structuredClone(state);
  for (const block of stale.blocks) if (block.blockId === b1) block.active = false;
  assert.ok(!isLiveCheckpointCarrier(carrier, stale));
  const staleRanges = buildCompressibleRanges(messages, stale, cfg, undefined);
  assert.ok(
    staleRanges.compressible.some(
      (r) => r.startIndex <= carrierIdx && carrierIdx <= r.endIndex,
    ),
    "stale carrier folds like an ordinary message",
  );
});

test("media payloads are carved out of the applied block, not silently folded (#2663 facet 2)", () => {
  const core = createCore();
  const cfg = config();
  const state = createInitialState();
  const media = { ...msg("M", "see image"), imageBase64: "aGVsbG8=" };
  const messages = [msg("x1", "text one", "assistant"), media, msg("x2", "text two", "assistant")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: (m) => hasMediaPayload(m),
  }).map;
  assert.equal(state.messageRefs.byRaw["M"], "BLOCKED");
  const folded = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "with media" }],
    messages,
    state,
    config: cfg,
  });
  assert.equal(folded.result.errors.length, 0, folded.result.errors.join("; "));
  assert.equal(folded.result.blocksCreated, 1);
  assert.ok(folded.result.warnings.some((w) => /image\/attachment/.test(w)));
  const block = folded.state.blocks.find((b) => b.active)!;
  assert.ok(block.effectiveMessageIds.includes("x1"));
  assert.ok(block.effectiveMessageIds.includes("x2"));
  assert.ok(!block.effectiveMessageIds.includes("M"), "media bytes must stay outside the block");
});

// Partial-pair visibility (call visible, result covered) is UNREACHABLE
// through the pipeline today: prune's orphan stripping (stripOrphanedToolCalls
// drops any call whose result left the view) plus apply-side pair widening and
// the integrity gate keep pairs atomic end to end. The risk is structural —
// two screening sites judging two different array classes with nothing
// enforcing they agree. Pin the contract at the function level with a
// hand-crafted view pair: the judgment must flip with the array class, and
// the default (omitted source) must keep judging the passed array for
// external callers.
test("integrity withdrawal is judged on the original array class (#2663 facet 3)", () => {
  const cfg = config();
  const state = createInitialState();
  const original: CoreMessage[] = [
    { id: "R1", role: "assistant", contentType: "reasoning", text: "thinking hard" },
    { id: "C", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "c1", text: "{}" },
    { id: "R", role: "tool", contentType: "tool-result", toolCallId: "c1", toolName: "read", text: "out" },
  ];
  const prunedLike: CoreMessage[] = [original[0]!, original[1]!];
  state.messageRefs = assignRefs(original, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const synthetic: CompressionBlock = {
    blockId: "b1",
    runId: "run-t4",
    tier: 1,
    summary: "covers the result only",
    directMessageIds: ["R"],
    effectiveMessageIds: ["R"],
    directBlockIds: [],
    compressedTokens: 10,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
  };
  state.blocks.push(synthetic);

  const callIdx = prunedLike.findIndex((m) => m.id === "C");
  const oldJudgment = buildCompressibleRanges(prunedLike, state, cfg, undefined);
  assert.ok(
    oldJudgment.compressible.some((r) => r.startIndex <= callIdx && r.endIndex >= callIdx),
    `view without the result cannot see the split pair: ${JSON.stringify(oldJudgment.compressible)}`,
  );

  const newJudgment = buildCompressibleRanges(prunedLike, state, cfg, undefined, undefined, original);
  for (const r of newJudgment.compressible) {
    assert.ok(
      !(r.startIndex <= callIdx && r.endIndex >= callIdx),
      `original-array judgment must screen the split-pair call: ${JSON.stringify(newJudgment.compressible)}`,
    );
  }

  const selfJudgment = buildCompressibleRanges(prunedLike, state, cfg, undefined, undefined, prunedLike);
  assert.deepEqual(selfJudgment, oldJudgment);
});

test("acp_status uncompressed rows never bridge across a live carrier", () => {
  const core = createCore();
  const cfg = config();
  let state = createInitialState();
  const messages = [
    msg("1", "q", "user"),
    msg("2", "a", "assistant"),
    msg("3", "b", "assistant"),
    msg("4", "c", "assistant"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const folded = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: "s" }],
    messages,
    state,
    config: cfg,
  });
  const b1 = folded.state.blocks[0]!.blockId;
  state = folded.state;
  const carrier = { ...msg("6", `[checkpoint ${b1}] body`, "user"), summaryOfBlockId: b1 };
  messages.push(msg("5", "after block a", "assistant"), carrier, msg("7", "after block b", "assistant"), msg("8", "after block c", "assistant"));
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 5,
  }).map;

  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.ok(report.includes("m00006"), "carrier stays listed as visible mass");
  for (const line of report.split("\n")) {
    assert.ok(
      !(line.includes("m00005") && line.includes("m00007")),
      `row bridges across the live carrier: ${line}`,
    );
  }
});
