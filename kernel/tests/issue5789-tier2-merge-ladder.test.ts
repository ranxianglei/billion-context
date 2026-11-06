import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState, coveredMessageIds } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { computeIntegrityWithdrawals } from "../src/turn-integrity.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

// #5789: in long sessions, Tier-2 distillation hard-failed PERMANENTLY. A
// historical block whose coverage cuts through a turn group (its call folded,
// the result still live OUTSIDE the merge span — legacy pre-widening shape;
// fresh folds self-align and never produce this) made every merge spanning it
// fail the turn-integrity gate: unfolding the covered half would drop its only
// coverage (the host pre-commit guard refuses such folds, #4484/#3322), and
// the advertised nudge range kept pointing at the same doomed span — breaker
// armed, context growing faster than before.
//
// Fixed behavior pinned here (apply-side only — the advertise-side screening
// of tier-distill runs lives in PR #5777, which owns compress.ts):
//  1. recovery ladder — the merge keeps the offending block(s) ACTIVE
//     (coverage intact) and completes around them;
//  2. pre-existing merge-neutral conflicts are inherited with an honest
//     warning instead of refusing every merge in the session;
//  3. unfixable conflicts refuse with ACTIONABLE text (stranded partner ref +
//     owning block named), keeping the "cannot satisfy turn integrity" phrase
//     the #4484 suite keys on.

const isToolProtected = (t?: string) =>
  t === "mcp__bili__acp_rule" || t === "mcp__bili__compress";
const isCompressTool = (t?: string) =>
  t === "mcp__bili__compress" || t === "compress";

const config = defaultConfig(255000, {
  preserveRecentMessages: 0,
  preserveRecentTokens: 0,
  isToolProtected,
  isCompressTool,
} as never);

const SUMMARY = "Synthetic summary for this compression test. ".repeat(4);
const LONG =
  "Synthetic historical content, safe for public reproduction. ".repeat(150);

function lostCoverage(before: Set<string>, state: CompressionState): string[] {
  const after = coveredMessageIds(state);
  return [...before].filter((id) => !after.has(id));
}

/** User-shape fixture (#5789): three clean T1 blocks plus a LAST block cut
 *  mid-tool-group — b4 covers reasoning+call while the result (l2) stays live
 *  AFTER the last block anchor. Refs: u0=m00001 a0=m00002 r1=m00003
 * k1=m00004 l1=m00005 u1=m00006 a1=m00007 r2=m00008 k2=m00009 l2=m00010
 * t2=m00011 new-user=m00012. */
function buildUserShapeFixture() {
  const core = createCore();
  const messages: CoreMessage[] = [
    { id: "u0", role: "user", contentType: "text", text: LONG },
    { id: "a0", role: "assistant", contentType: "text", text: "Previous work finished." },
    { id: "r1", role: "assistant", contentType: "reasoning", text: "Inspect the current state." },
    { id: "k1", role: "assistant", contentType: "tool-call", toolName: "Read", toolCallId: "c1", text: '{"path":"/tmp/a.txt"}' },
    { id: "l1", role: "tool", contentType: "tool-result", toolName: "Read", toolCallId: "c1", text: LONG },
    { id: "u1", role: "user", contentType: "text", text: LONG },
    { id: "a1", role: "assistant", contentType: "text", text: "More prior context." },
    { id: "r2", role: "assistant", contentType: "reasoning", text: "Check the tail." },
    { id: "k2", role: "assistant", contentType: "tool-call", toolName: "Read", toolCallId: "c2", text: '{"path":"/tmp/b.txt"}' },
    // b4 below covers r2,k2 ONLY — its tail cut mid-tool-group; l2 stays live.
    { id: "l2", role: "tool", contentType: "tool-result", toolName: "Read", toolCallId: "c2", text: LONG },
    { id: "t2", role: "assistant", contentType: "text", text: "Tail turn done." },
    { id: "new-user", role: "user", contentType: "text", text: "Continue." },
  ];
  const state = createInitialState();
  let nextRef = 1;
  for (const m of messages) {
    const ref = `m${String(nextRef++).padStart(5, "0")}`;
    state.messageRefs.byRaw[m.id] = ref;
    state.messageRefs.byRef[ref] = m.id;
  }
  const seeded = core.applyCompression({
    messages,
    state,
    config,
    ranges: [
      {
        startRef: state.messageRefs.byRaw["u0"]!,
        endRef: state.messageRefs.byRaw["a0"]!,
        summary: SUMMARY,
      },
    ],
  });
  if (seeded.result.blocksCreated !== 1 || seeded.result.errors.length !== 0) {
    throw new Error(`fixture seed failed: ${JSON.stringify(seeded.result)}`);
  }
  const push = (blockId: string, runId: string, ids: string[], tier = 1) => {
    seeded.state.blocks.push({
      ...seeded.state.blocks[0]!,
      blockId,
      runId,
      tier,
      directMessageIds: [...ids],
      effectiveMessageIds: [...ids],
      compressedTokens: ids.length * 100,
      startRef: state.messageRefs.byRaw[ids[0]!]!,
      endRef: state.messageRefs.byRaw[ids[ids.length - 1]!]!,
    });
  };
  push("b2", "r2", ["r1", "k1", "l1"]);
  push("b3", "r3", ["u1", "a1"]);
  push("b4", "r4", ["r2", "k2"]);
  seeded.state.nextBlockId = 5;
  seeded.state.nextRunId = 5;
  seeded.state.stats.compressionCount = 4;
  return { core, messages, state: seeded.state };
}

describe("#5789 tier-2 merge recovery ladder", () => {
  it("tail-cut poison block: merging b1..b4 succeeds AROUND it (b4 stays active)", () => {
    const { core, messages, state } = buildUserShapeFixture();
    const before = coveredMessageIds(state);
    const res = core.applyCompression({
      messages,
      state,
      config,
      ranges: [{ startRef: "b1", endRef: "b4", summary: SUMMARY }],
    });
    assert.equal(res.result.errors.length, 0, JSON.stringify(res.result.errors));
    assert.equal(res.result.blocksCreated, 1, JSON.stringify(res.result));
    assert.deepEqual(
      lostCoverage(before, res.state),
      [],
      "no existing coverage may be dropped",
    );
    const byId = new Map(res.state.blocks.map((b) => [b.blockId, b]));
    assert.equal(byId.get("b4")?.active, true, "poison block must stay active");
    for (const id of ["b1", "b2", "b3"]) {
      assert.equal(byId.get(id)?.active, false, `${id} must be consumed`);
    }
    const merged = res.state.blocks.find((b) => b.active && b.blockId !== "b4");
    assert.ok(merged, "a new merged block must exist");
    assert.equal(merged.tier, 2);
    assert.deepEqual(
      new Set(merged.effectiveMessageIds),
      new Set(["u0", "a0", "r1", "k1", "l1", "u1", "a1"]),
    );
    assert.deepEqual([...merged.directBlockIds].sort(), ["b1", "b2", "b3"]);
    assert.ok(
      res.result.warnings.some((w) => w.includes("b4")),
      `exclusion warning must name b4: ${JSON.stringify(res.result.warnings)}`,
    );
    // The merge must not ADD integrity violations: the post-state withdrawn
    // set is a subset of the pre-state one (b4's own split predates the merge).
    const preW = computeIntegrityWithdrawals(messages, before).withdrawn;
    const postW = computeIntegrityWithdrawals(
      messages,
      coveredMessageIds(res.state),
    ).withdrawn;
    for (const id of postW) {
      assert.ok(preW.has(id), `merge introduced a violation for ${id}`);
    }
  });

  it("block self-range b4..b4: idempotent no-op", () => {
    // A poison block referenced against itself hard-failed on master with
    // the same turn-integrity refusal as b1..b4 (its own coverage strands
    // the live k2/l2/r2 conflict and nothing else is left to fold). With
    // the recovery ladder the projection excludes b4 from consumption and
    // folds nothing: an idempotent no-op success, never an error (a retry
    // here must not arm the breaker or grow context). Pinned because #5789
    // touches the adjacent projection paths.
    const { core, messages, state } = buildUserShapeFixture();
    const before = coveredMessageIds(state);
    const res = core.applyCompression({
      messages,
      state,
      config,
      ranges: [{ startRef: "b4", endRef: "b4", summary: SUMMARY }],
    });
    assert.equal(res.result.errors.length, 0, JSON.stringify(res.result));
    assert.equal(res.result.blocksCreated, 0);
    assert.ok(
      res.result.warnings.some((w) => w.includes("folded nothing")),
      JSON.stringify(res.result.warnings),
    );
    assert.deepEqual(lostCoverage(before, res.state), [], "state must stay untouched");
  });

  it("conflict owned by a SURVIVING higher-tier block: inherited with warning, clean blocks still distill", () => {
    const core = createCore();
    const messages: CoreMessage[] = [
      { id: "u0", role: "user", contentType: "text", text: LONG },
      { id: "a0", role: "assistant", contentType: "text", text: "Previous work finished." },
      { id: "r2", role: "assistant", contentType: "reasoning", text: "Check the tail." },
      { id: "k2", role: "assistant", contentType: "tool-call", toolName: "Read", toolCallId: "c2", text: '{"path":"/tmp/b.txt"}' },
      { id: "u1", role: "user", contentType: "text", text: LONG },
      { id: "a1", role: "assistant", contentType: "text", text: "More prior context." },
      // Refs: u0=m00001 a0=m00002 r2=m00003 k2=m00004 u1=m00005 a1=m00006
      // l2=m00007 t2=m00008 new-user=m00009.
      { id: "l2", role: "tool", contentType: "tool-result", toolName: "Read", toolCallId: "c2", text: LONG },
      { id: "t2", role: "assistant", contentType: "text", text: "Tail turn done." },
      { id: "new-user", role: "user", contentType: "text", text: "Continue." },
    ];
    const state = createInitialState();
    let nextRef = 1;
    for (const m of messages) {
      const ref = `m${String(nextRef++).padStart(5, "0")}`;
      state.messageRefs.byRaw[m.id] = ref;
      state.messageRefs.byRef[ref] = m.id;
    }
    const seeded = core.applyCompression({
      messages,
      state,
      config,
      ranges: [
        {
          startRef: state.messageRefs.byRaw["u0"]!,
          endRef: state.messageRefs.byRaw["a0"]!,
          summary: SUMMARY,
        },
      ],
    });
    if (seeded.result.blocksCreated !== 1 || seeded.result.errors.length !== 0) {
      throw new Error(`fixture seed failed: ${JSON.stringify(seeded.result)}`);
    }
    const push = (blockId: string, runId: string, ids: string[], tier = 1) => {
      seeded.state.blocks.push({
        ...seeded.state.blocks[0]!,
        blockId,
        runId,
        tier,
        directMessageIds: [...ids],
        effectiveMessageIds: [...ids],
        compressedTokens: ids.length * 100,
        startRef: state.messageRefs.byRaw[ids[0]!]!,
        endRef: state.messageRefs.byRaw[ids[ids.length - 1]!]!,
      });
    };
    // b2 is a legacy TIER-2 block whose coverage cuts the c2 pair; it SURVIVES
    // a T1 distill (not consumed), so no exclusion ladder can reach it.
    push("b2", "r2", ["r2", "k2"], 2);
    push("b3", "r3", ["u1", "a1"]);
    seeded.state.nextBlockId = 4;
    seeded.state.nextRunId = 4;
    seeded.state.stats.compressionCount = 3;
    const before = coveredMessageIds(seeded.state);
    const res = core.applyCompression({
      messages,
      state: seeded.state,
      config,
      ranges: [{ startRef: "b1", endRef: "b3", summary: SUMMARY }],
    });
    // The conflict is PRE-EXISTING (b2 was already active with its mid-pair
    // coverage) and merge-neutral: the clean blocks must still be able to
    // distill — refusing here is what killed every merge in long sessions.
    assert.equal(res.result.errors.length, 0, JSON.stringify(res.result));
    assert.equal(res.result.blocksCreated, 1);
    assert.deepEqual(lostCoverage(before, res.state), []);
    const byId = new Map(res.state.blocks.map((b) => [b.blockId, b]));
    assert.equal(byId.get("b2")?.active, true, "surviving poison block untouched");
    assert.deepEqual(new Set(byId.get("b2")!.effectiveMessageIds), new Set(["r2", "k2"]));
    const merged = res.state.blocks.find((b) => b.active && b.blockId !== "b2");
    assert.ok(merged, "a merged block must exist");
    assert.equal(merged.tier, 2);
    assert.deepEqual(new Set(merged.effectiveMessageIds), new Set(["u0", "a0", "u1", "a1"]));
    assert.deepEqual([...merged.directBlockIds].sort(), ["b1", "b3"]);
    assert.ok(
      res.result.warnings.some(
        (w) =>
          w.includes("Inherited a pre-existing turn-integrity conflict") &&
          w.includes("m00007"),
      ),
      `inheritance warning must name the stranded partner (l2): ${JSON.stringify(res.result.warnings)}`,
    );
  });

});
