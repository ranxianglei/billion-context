import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import {
  blockById,
  coveredMessageIds,
  createInitialState,
} from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { summaryMessageId } from "../src/prune.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

// #5830: a plain message-ref range must never merge an active block whose
// coverage extends beyond the requested ref window [startRef..endRef] — the
// supplied summary describes exactly that window, so such a merge replaces
// the block's wider-span summary with one that never saw part of it (the
// incident left b27 covering 1566 messages with only the last range's
// summary; prior blocks silently deactivated).
//
// Fixture = a reachable production sequence (full-resend host; the plugin
// lane judges on raw history per #3236's applyView): stage 1 builds two
// active blocks with OVERLAPPING coverage (a full-raw fold starting inside
// an existing T2's territory); stage 2 fires a range whose stale inherited
// startRef snaps to the T2's head anchor while its end is fresh, so the
// resolved span sweeps the overlapping T1 below the requested window.

const LONG =
  "Synthetic historical content, safe for public reproduction. ".repeat(150);
const sum = (label: string) =>
  `${label}: synthetic stage summary capturing the folded range. `.padEnd(72, ".");
const config = defaultConfig(255000, {
  preserveRecentMessages: 0,
  preserveRecentTokens: 0,
} as never);

function mkMsg(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: LONG };
}

type Ranges = Parameters<ReturnType<typeof createCore>["applyCompression"]>[0]["ranges"];

function buildStage1() {
  const core = createCore();
  const messages: CoreMessage[] = [];
  const initial = createInitialState();
  for (let i = 1; i <= 14; i++) {
    const id = `u${String(i).padStart(2, "0")}`;
    messages.push(mkMsg(id));
    const ref = `m${String(i).padStart(5, "0")}`;
    initial.messageRefs.byRaw[id] = ref;
    initial.messageRefs.byRef[ref] = id;
  }
  let state: CompressionState = initial;
  const fold = (ranges: Ranges) => {
    const res = core.applyCompression({ messages, state, config, ranges });
    if (res.result.errors.length !== 0) {
      throw new Error(`stage-1 fold failed: ${JSON.stringify(res.result.errors)}`);
    }
    state = res.state;
    return res;
  };
  fold([{ startRef: "m00001", endRef: "m00002", summary: sum("b1") }]);
  fold([{ startRef: "m00003", endRef: "m00004", summary: sum("b2") }]);
  fold([{ startRef: "b1", endRef: "b2", summary: sum("b3-distillation") }]);
  const b3 = blockById(state, "b3");
  assert.equal(b3?.tier, 2, "distillation must produce a T2");
  assert.ok(b3?.active === true, "b3 must stay active");
  // Full-raw fold over the T2's territory: b3's anchor sits inside the span
  // but b3 is T2 (target tier of a plain range is 1), so it survives — b4
  // ends up covering [u01..u12] and OVERLAPS b3's [u01..u04]. Both stay
  // active: the stage-1 overlap product.
  fold([{ startRef: "m00001", endRef: "m00012", summary: sum("b4-fullraw") }]);
  const b4 = blockById(state, "b4");
  assert.equal(b4?.tier, 1, "plain fold must produce a T1");
  assert.ok(
    b4?.active === true && b3.active === true,
    "stage 1 must leave both blocks active with overlapping coverage",
  );
  return { core, messages, state };
}

/** The pruned view a normal host sends after stage 1: the two rendered
 *  summaries at their head anchors, then the fresh uncovered tail. */
function prunedView(messages: CoreMessage[]): CoreMessage[] {
  return [
    {
      id: summaryMessageId("b3"),
      role: "system",
      contentType: "text",
      text: "[Compressed conversation section] S-b3",
    },
    {
      id: summaryMessageId("b4"),
      role: "system",
      contentType: "text",
      text: "[Compressed conversation section] S-b4",
    },
    messages[12]!,
    messages[13]!,
  ];
}

function lostCoverage(before: Set<string>, state: CompressionState): string[] {
  const after = coveredMessageIds(state);
  return [...before].filter((id) => !after.has(id));
}

describe("#5830 plain-range merge window guard", () => {
  it("stale-inherited start + fresh end: a sweep that swallows an out-of-window block is rejected atomically with zero commits", () => {
    const { core, messages, state } = buildStage1();
    const before = coveredMessageIds(state);
    const res = core.applyCompression({
      messages: prunedView(messages),
      state,
      config,
      ranges: [{ startRef: "m00002", endRef: "m00014", summary: sum("tail-only") }],
    });
    assert.equal(res.result.blocksCreated, 0, JSON.stringify(res.result));
    assert.equal(res.result.errors.length, 1, JSON.stringify(res.result.errors));
    assert.match(
      res.result.errors[0]!,
      /extends beyond the requested ref window/i,
    );
    assert.match(res.result.errors[0]!, /b4/, "the offender block must be named");
    assert.deepEqual(lostCoverage(before, res.state), [], "no coverage may be lost");
    assert.ok(blockById(res.state, "b4")!.active, "b4 must stay active");
    assert.ok(blockById(res.state, "b3")!.active, "b3 must stay active");
  });

  it("control: a plain-range merge whose window CONTAINS the consumed block's coverage still lands", () => {
    const { core, messages, state } = buildStage1();
    const res = core.applyCompression({
      messages: prunedView(messages),
      state,
      config,
      ranges: [{ startRef: "m00001", endRef: "m00014", summary: sum("legit-wide") }],
    });
    assert.equal(res.result.errors.length, 0, JSON.stringify(res.result.errors));
    assert.equal(res.result.blocksCreated, 1, JSON.stringify(res.result));
    assert.equal(
      blockById(res.state, "b4")!.active,
      false,
      "b4 [u01..u12] lies inside window [1..14] — legitimate absorption",
    );
  });

  it("control: a fully-covered resubmit changes nothing — no block, no coverage loss (pre-fix: refold-guidance error, NOT a silent merge)", () => {
    const { core, messages, state } = buildStage1();
    const before = coveredMessageIds(state);
    const res = core.applyCompression({
      messages: prunedView(messages),
      state,
      config,
      ranges: [{ startRef: "m00002", endRef: "m00004", summary: sum("resubmit") }],
    });
    assert.equal(res.result.blocksCreated, 0, JSON.stringify(res.result));
    assert.deepEqual(lostCoverage(before, res.state), []);
    assert.ok(
      blockById(res.state, "b4")!.active && blockById(res.state, "b3")!.active,
    );
  });

  it("control: block-boundary distillation across the same blocks is untouched by the gate", () => {
    const { core, messages, state } = buildStage1();
    const res = core.applyCompression({
      messages: prunedView(messages),
      state,
      config,
      ranges: [{ startRef: "b3", endRef: "b4", summary: sum("distill-mixed") }],
    });
    assert.equal(res.result.errors.length, 0, JSON.stringify(res.result.errors));
    assert.equal(res.result.blocksCreated, 1, JSON.stringify(res.result));
  });
});
