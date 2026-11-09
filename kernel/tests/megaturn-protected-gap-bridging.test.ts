// Regression pins for the production 2026-11-09 mega-turn no-ranges incident.
//
// Shape: a mega-turn whose rounds are interleaved with protected-tool
// exchanges (config.protectedTools — todo/tool_learn/…), with an active block
// cut mid-group through the middle. The protected exchanges + integrity
// withdrawals fragment the compressible surface into islands of ~3-5K chars —
// each individually BELOW the apply-side minCompressRange gate, and (because
// the apply gate sums chars per CALL, compress.ts #847) perfectly legal to
// fold together. Pre-fix, mergeRangesToThreshold dropped every sub-gate island
// → recommendedRanges=[] → the host's emergency lane fell back to irreversible
// physical pruning while its four-bucket diagnostic still counted 84
// "collectible" messages. Three pins:
//   1. mergeRangesToThreshold BRIDGES across span-safe gaps so islands
//      accumulate to the gate (and still never bridges a hard gap);
//   2. the bridged unit SURVIVES screening — projectUnit clamps the
//      pair-boundary adjustment at the coverage boundary instead of dragging
//      the adjacent block in as consumed (the second, independent killer);
//   3. the whole recommend chain advertises ≥1 range for the incident shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeProtectedRefs,
  buildCompressibleRanges,
  mergeRangesToThreshold,
  screenRecommendedUnits,
} from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type {
  CompressibleRange,
  CompressionState,
  Config,
  CoreMessage,
} from "../src/types.js";

const CJK = "上下文压缩水位判定折叠范围构建完整性撤回保护区覆盖";
const cjk = (n: number): string =>
  Array.from({ length: n }, (_, i) => CJK[i % CJK.length]).join("");

const PROTECTED_TOOLS = [
  "tool_learn",
  "skill_learn",
  "todo",
  "compress",
  "acp_status",
  "search_context",
  "absorb",
  "recall",
];
const COMMON = ["read", "run_code", "glob", "grep", "browser_evaluate", "write"];

function config(): Config {
  return defaultConfig(112000, {
    protectedTools: [...PROTECTED_TOOLS],
    preserveRecentMessages: 8,
    preserveRecentTokens: 8000,
    nudge: { ...defaultConfig(112000).nudge, maxContextLimitPct: 0.8 },
  });
}

/** 50 small rounds; every 4th round's exchange rides a protected tool; the
 *  newest 24 messages are unrefed (state persist lag, as in production). */
function buildIncident(): {
  messages: CoreMessage[];
  state: CompressionState;
} {
  const messages: CoreMessage[] = [];
  messages.push({ id: "m00001", role: "user", contentType: "text", text: cjk(600) });
  let n = 1;
  const nid = () => `m${String(++n).padStart(5, "0")}`;
  for (let r = 0; r < 50; r++) {
    messages.push({
      id: nid(),
      role: "assistant",
      contentType: "reasoning",
      text: cjk(250 + ((r * 137) % 450)),
    });
    if (r % 2 === 0) {
      messages.push({ id: nid(), role: "assistant", contentType: "text", text: cjk(60 + ((r * 61) % 150)) });
    }
    const isProt = r > 2 && r % 4 === 0;
    const tool = isProt
      ? (["todo", "tool_learn", "search_context", "skill_learn"] as const)[r % 4]!
      : COMMON[(r * 7) % COMMON.length]!;
    const callId = `tc-${r}`;
    messages.push({
      id: nid(),
      role: "assistant",
      contentType: "tool-call",
      toolName: tool,
      toolCallId: callId,
      text: `{"r":${r}}`,
    });
    messages.push({
      id: nid(),
      role: "tool",
      contentType: "tool-result",
      toolName: tool,
      toolCallId: callId,
      text: cjk(200 + ((r * 331) % 1600)),
    });
  }
  const state = createInitialState();
  const noRefIds = new Set(messages.slice(-24).map((m) => m.id!));
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
    shouldSkip: (m) => noRefIds.has(m.id!),
  }).map;
  // Active block cut mid-group through the middle (the earlier growth-lane
  // fold): start on a compressible message so the round's call/result stay
  // covered while the reasoning stays visible.
  let startIdx = 30;
  while (
    startIdx < messages.length &&
    messages[startIdx]!.contentType === "tool-result"
  ) {
    startIdx++;
  }
  const ids = messages.slice(startIdx, startIdx + 86).map((m) => m.id!);
  state.blocks = [
    {
      blockId: "b1",
      runId: "r1",
      tier: 1,
      topic: "mid",
      summary: cjk(400),
      directMessageIds: ids,
      effectiveMessageIds: ids,
      directBlockIds: [],
      compressedTokens: 40000,
      createdAt: Date.now(),
      survivedCount: 0,
      generation: 0,
      active: true,
    },
  ];
  return { messages, state };
}

function minChars(cfg: Config): number {
  return cfg.compress.minCompressRange;
}

describe("mega-turn protected-gap bridging (2026-11-09 incident)", () => {
  it("buildCompressibleRanges flags protected-only gaps as bridgeable", () => {
    const { messages, state } = buildIncident();
    const cfg = config();
    const protectedRefs = computeProtectedRefs(messages, state, cfg, defaultCountTokens);
    const ranges = buildCompressibleRanges(messages, state, cfg, protectedRefs, defaultCountTokens, messages);
    assert.ok(ranges.compressible.length > 0, "islands must exist");
    const bridged = ranges.compressible.filter((r) => r.bridgeableGapBefore === true);
    assert.ok(bridged.length > 0, "at least one island follows a span-safe gap");
  });

  it("mergeRangesToThreshold bridges span-safe gaps so islands clear the gate", () => {
    const { messages, state } = buildIncident();
    const cfg = config();
    const gate = minChars(cfg);
    const protectedRefs = computeProtectedRefs(messages, state, cfg, defaultCountTokens);
    const ranges = buildCompressibleRanges(messages, state, cfg, protectedRefs, defaultCountTokens, messages);
    // Precondition of the incident: islands exist below the gate.
    const subGate = ranges.compressible.filter((r) => (r.chars ?? 0) < gate);
    assert.ok(subGate.length > 0, "fixture must produce sub-gate islands");
    const merged = mergeRangesToThreshold(ranges.compressible, gate);
    assert.ok(
      merged.length > 0,
      "bridged islands must accumulate past the merge gate (pre-fix: all dropped)",
    );
    for (const unit of merged) {
      assert.ok(
        (unit.chars ?? 0) >= gate,
        `every emitted unit clears the gate, got ${unit.chars}`,
      );
    }
  });

  it("mergeRangesToThreshold still refuses to bridge a hard gap", () => {
    // Two islands separated by a block-coverage gap: no bridge flag on the
    // second island → sub-gate islands on both sides stay unmerged.
    const island = (startIdx: number): CompressibleRange => ({
      startRef: `m${String(startIdx).padStart(5, "0")}`,
      endRef: `m${String(startIdx + 2).padStart(5, "0")}`,
      startIndex: startIdx,
      endIndex: startIdx + 2,
      count: 3,
      tokens: 900,
      chars: 2000,
      toolPct: 50,
      textPct: 50,
      userMsgs: 0,
    });
    const merged = mergeRangesToThreshold([island(10), island(40)], 5000);
    assert.deepEqual(merged, [], "hard-gapped sub-gate islands must not merge");
  });

  it("the bridged unit survives screening next to a mid-group block cut", () => {
    const { messages, state } = buildIncident();
    const cfg = config();
    const gate = minChars(cfg);
    const protectedRefs = computeProtectedRefs(messages, state, cfg, defaultCountTokens);
    const ranges = buildCompressibleRanges(messages, state, cfg, protectedRefs, defaultCountTokens, messages);
    const merged = mergeRangesToThreshold(ranges.compressible, gate);
    assert.ok(merged.length > 0);
    const screened = screenRecommendedUnits(merged, messages, state, cfg, protectedRefs);
    assert.ok(
      screened.length > 0,
      "bridged unit must survive projectUnit (clamp keeps the adjacent block out of the span)",
    );
    // The surviving span must not reach into covered territory: its END stays
    // on the visible side of the mid-group block cut.
    const covered = new Set<string>();
    for (const b of state.blocks ?? []) {
      if (b.active) for (const id of b.effectiveMessageIds ?? []) covered.add(id);
    }
    const indexById = new Map<string, number>();
    messages.forEach((m, i) => indexById.set(m.id!, i));
    for (const unit of screened) {
      const endIdx = indexById.get(unit.endRef);
      assert.ok(endIdx !== undefined, "endRef resolves to an array slot");
      assert.ok(
        !covered.has(messages[endIdx!]!.id!),
        "span end stays on the visible side of the block boundary",
      );
    }
  });

  it("full recommend chain advertises ranges for the incident shape", () => {
    const { messages, state } = buildIncident();
    const cfg = config();
    const gate = minChars(cfg);
    const protectedRefs = computeProtectedRefs(messages, state, cfg, defaultCountTokens);
    const ranges = buildCompressibleRanges(messages, state, cfg, protectedRefs, defaultCountTokens, messages);
    const merged = mergeRangesToThreshold(ranges.compressible, gate);
    const screened = screenRecommendedUnits(merged, messages, state, cfg, protectedRefs);
    assert.ok(
      screened.length > 0,
      "pre-fix this funnel returned [] and the host fell back to physical pruning",
    );
    const viable = screened.filter((r) => r.tokens >= 200);
    assert.ok(viable.length > 0, "at least one unit clears the 200-token viable floor");
  });
});
