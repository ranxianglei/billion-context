// #4316 layer 3, PR 2/3 — block coverage evidence migrates from content-hash
// id lists to unified-ledger seq intervals. The id path stays (unstamped
// traffic is byte-identical to today); the interval path is additive and
// only ever claims what it can prove.
//
// Contracts staked (打桩):
//
//  S8   applyCompression over fully-stamped messages records the block's
//       ledger interval (startSeq/endSeq = the folded messages' min/max
//       ledgerSeq), and prune() suppresses ORIGINALS BY SEQ even after every
//       id was re-minted (the #4316 model-switch churn shape: same messages,
//       same seqs, brand-new content-hash ids). Control: the same churned
//       view WITHOUT stamps loses coverage (documents today's hole).
//
//  S9   syncBlocks keeps a bounded block ACTIVE when the view carries its
//       seq interval under re-minted ids (originals restored by a host that
//       re-stamps bytes). Control: unstamped churn deactivates the block.
//
//  S10  Honest degradation: a fold whose direct messages are not ALL stamped
//       records NO bounds (never guess a partial interval).
//
//  S11  Interval merging is exact: a fold spanning a bounded consumed block
//       plus adjacent stamped messages records the contiguous union; a
//       boundary fold over two blocks with a HOLE between them records NO
//       bounds (a [min,max] claim there would cover uncovered messages).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { prune } from "../src/prune.js";
import { syncBlocks } from "../src/sync.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

const LONG = "stamped ledger interval fixture body ";

function stampMsg(
  id: string,
  seq: number,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text: LONG.repeat(60), ledgerSeq: seq };
}

/** A stamped history: 60 messages, seqs 1..60, alternating roles. */
function stampedHistory(): { messages: CoreMessage[]; state: ReturnType<typeof createInitialState> } {
  const messages: CoreMessage[] = [];
  for (let i = 1; i <= 60; i++) {
    messages.push(stampMsg(`s${i}`, i, i % 2 ? "user" : "assistant"));
  }
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  return { messages, state };
}

function fold(core: ReturnType<typeof createCore>, state: ReturnType<typeof createInitialState>, messages: CoreMessage[], startRef: string, endRef: string, summary: string) {
  return core.applyCompression({
    ranges: [{ startRef, endRef, summary, topic: "interval" }],
    messages,
    state,
    config: defaultConfig(),
  });
}

test("S8: stamped fold records the ledger interval and survives id churn", () => {
  const core = createCore();
  const { messages, state } = stampedHistory();

  const res = fold(
    core, state, messages, "m00007", "m00020",
    "interval fold covering stamped messages seven through twenty with a summary long enough to satisfy the kernel minimum summary length gate for sure",
  );
  const block = res.state.blocks.find((b) => b.topic === "interval");
  assert.ok(block?.active, "fold must produce an active block");

  // (a) The block carries its ledger interval.
  assert.equal(block!.startSeq, 7, "startSeq = folded min ledgerSeq");
  assert.equal(block!.endSeq, 20, "endSeq = folded max ledgerSeq");

  // (b) #4316 churn shape: the host re-sent every message with brand-new
  // content-hash ids (model switch / re-stamp) but the ledger seqs held.
  const churned: CoreMessage[] = messages.map((m, i) => ({
    ...m,
    id: `remint-${i}-${m.id}`,
  }));
  const pruned = prune(churned, res.state);
  const churnedFolded = pruned.filter(
    (m) => m.id.startsWith("remint-6-") || (m.ledgerSeq !== undefined && m.ledgerSeq >= 7 && m.ledgerSeq <= 20),
  );
  // The covered originals (seq 7..20) must be suppressed BY SEQ — they are
  // gone from the pruned view (only the injected summary carrier remains).
  assert.equal(
    churnedFolded.length, 0,
    "re-minted originals inside the interval must stay folded (seq claim)",
  );
  assert.ok(
    pruned.some((m) => m.ledgerSeq === 6),
    "message just below the interval stays visible",
  );
  assert.ok(
    pruned.some((m) => m.ledgerSeq === 21),
    "message just above the interval stays visible",
  );

  // Control (documents today's hole): the same churned view WITHOUT stamps
  // loses coverage — the id path cannot match re-minted ids.
  const unstampedChurn = churned.map(({ ledgerSeq: _drop, ...rest }) => rest);
  const control = prune(unstampedChurn, res.state);
  const stillThere = control.filter(
    (m) => m.id.startsWith("remint-") && /remint-(6|7|13)-/.test(m.id) === false && m.ledgerSeq === undefined,
  );
  assert.ok(
    control.some((m) => m.id.startsWith("remint-6-") || m.id === "remint-6-s7"),
    "control: unstamped churned original is NOT suppressed (id path miss)",
  );
});

test("S9: syncBlocks keeps a bounded block alive across stamped id churn", () => {
  const core = createCore();
  const { messages, state } = stampedHistory();

  const res = fold(
    core, state, messages, "m00007", "m00020",
    "sync interval fold: stamped messages seven through twenty folded so syncBlocks must keep the block alive when the seq interval is present under re-minted ids",
  );
  const block = res.state.blocks.find((b) => b.topic === "interval");
  assert.ok(block?.active);

  // The host restored the originals with re-minted ids, no summary carrier.
  const churned: CoreMessage[] = messages.map((m, i) => ({
    ...m,
    id: `restore-${i}-${m.id}`,
  }));
  const synced = syncBlocks(churned, res.state);
  const after = synced.state.blocks.find((b) => b.blockId === block!.blockId);
  assert.equal(after?.active, true, "seq interval present ⇒ block stays active");

  // Control: unstamped churn deactivates (documents the id-path behavior).
  const unstamped = churned.map(({ ledgerSeq: _drop, ...rest }) => rest);
  const controlSync = syncBlocks(unstamped, res.state);
  const controlBlock = controlSync.state.blocks.find((b) => b.blockId === block!.blockId);
  assert.equal(controlBlock?.active, false, "no ids, no stamps ⇒ block deactivates");
});

test("S10: partial stamping records no bounds (never guess)", () => {
  const core = createCore();
  const { messages, state } = stampedHistory();
  // Punch the stamp off one message inside the would-be fold range.
  const holey = messages.map((m) =>
    m.id === "s13" ? { ...m, ledgerSeq: undefined } : m,
  );
  const res = fold(
    core, state, holey, "m00007", "m00020",
    "partial stamp fold: one message in the range carries no ledger stamp so the block must honestly record no interval bounds at all",
  );
  const block = res.state.blocks.find((b) => b.topic === "interval");
  assert.ok(block?.active);
  assert.equal(block!.startSeq, undefined, "no bounds when any folded message is unstamped");
  assert.equal(block!.endSeq, undefined);
});

test("S11: interval merging is exact — adjacent union recorded, hole not", () => {
  const core = createCore();
  const { messages, state } = stampedHistory();

  // b1 over [7..20].
  const first = fold(
    core, state, messages, "m00007", "m00020",
    "first bounded block over stamped messages seven through twenty, long enough summary text for the kernel gate",
  );
  const b1 = first.state.blocks.find((b) => b.startSeq === 7 && b.endSeq === 20);
  assert.ok(b1?.active, "b1 must exist and be bounded");

  // Merge case: a fold whose range starts AT block b1's boundary and ends
  // above it (b1..m00025) consumes b1 and adds the adjacent stamped messages
  // — the contiguous union [7..25] must be recorded on the new block.
  const adjacent = fold(
    core, first.state, messages, b1!.blockId, "m00025",
    "boundary fold from block one up through message twenty-five so the merged coverage forms one contiguous interval from seven through twenty-five",
  );
  const merged = adjacent.state.blocks.find((b) => b.endSeq === 25 && b.active);
  assert.ok(merged, "boundary+adjacent fold produces a bounded block");
  assert.equal(merged!.startSeq, 7, "union interval spans the consumed block too");

  // Hole case (independent fixture): two bounded blocks with the middle of
  // the history DELETED by the host between them (the #4316 mid-history
  // truncation world). A fold spanning both must NOT claim [min,max] — the
  // claim would cover the hole's seqs, which nothing actually covers.
  const fresh = stampedHistory();
  const left = fold(
    core, fresh.state, fresh.messages, "m00007", "m00015",
    "left bounded block over stamped messages seven through fifteen with a long enough summary text for the kernel gate",
  );
  const leftBlock = left.state.blocks.find((b) => b.startSeq === 7 && b.endSeq === 15);
  assert.ok(leftBlock?.active);
  const right = fold(
    core, left.state, fresh.messages, "m00025", "m00035",
    "right bounded block over stamped messages twenty-five through thirty-five with a long enough summary text for the kernel gate",
  );
  const rightBlock = right.state.blocks.find((b) => b.startSeq === 25 && b.endSeq === 35);
  assert.ok(rightBlock?.active);

  const holeyView = fresh.messages.filter(
    (m) => !(m.ledgerSeq !== undefined && m.ledgerSeq >= 18 && m.ledgerSeq <= 22),
  );
  const bridged = fold(
    core, right.state, holeyView, "m00007", "m00035",
    "fold across two bounded blocks whose coverage has a hole between them: the result must honestly record no interval because a min-max claim would swallow the hole",
  );
  const bridge = bridged.state.blocks.find(
    (b) => b.active && b.directBlockIds.includes(leftBlock!.blockId) && b.directBlockIds.includes(rightBlock!.blockId),
  );
  assert.ok(bridge, "the spanning fold consumed both bounded blocks");
  assert.equal(bridge!.startSeq, undefined, "hole between segments ⇒ no bounds");
  assert.equal(bridge!.endSeq, undefined);
});
