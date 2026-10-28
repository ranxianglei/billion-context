// PR #4725 N1 — the -1/-1 "no claim" covered-seq sentinel.
//
// Host storage (store.ts / mysql.ts boundsForCovered) writes start_seq=-1 /
// end_seq=-1 when a block's covered raw ids cannot be resolved to transcript
// rows (migrated pre-unified-storage folds whose raws never re-ingest). The
// sentinel is ABSENCE of a positional claim, not an interval: the historical
// endSeq >= startSeq guard alone let it pass as a real interval (and its
// [0,0] predecessor suppressed the seq-0 message as already folded — silent
// content loss on migrated installs, permanent because folded raws never
// re-ingest).
//
// Contracts staked:
//
//  N1a  coveredSeqIntervals skips the -1/-1 sentinel (and skips each bound
//       separately when only one is negative); [0,0] REMAINS a real claim —
//       a block can genuinely cover just seq 0, so no [0,0] special case.
//
//  N1b  syncBlocks' seq-presence path (blockSeqPresent) treats the sentinel
//       as absent: a block whose ids churned away and whose only "evidence"
//       is the sentinel deactivates, while the same block with a real
//       interval covering a visible stamp stays active.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coveredSeqIntervals } from "../src/prune.js";
import { syncBlocks } from "../src/sync.js";
import { createCore } from "../src/compress.js";
import { assignRefs } from "../src/refs.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

const LONG = "sentinel interval fixture body ";

function sentinelBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    topic: "sentinel",
    summary: "sentinel fold summary",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: 1,
    active: true,
    ...overrides,
  };
}

test("N1a: coveredSeqIntervals skips the -1/-1 no-claim sentinel", () => {
  const state = createInitialState();
  state.blocks = [
    sentinelBlock({ blockId: "sentinel", startSeq: -1, endSeq: -1 }),
    sentinelBlock({ blockId: "real", startSeq: 4, endSeq: 9 }),
    sentinelBlock({ blockId: "zero", startSeq: 0, endSeq: 0 }),
  ];
  const intervals = coveredSeqIntervals(state);
  assert.deepEqual(
    intervals,
    [
      { start: 4, end: 9 },
      { start: 0, end: 0 },
    ],
    "sentinel contributes nothing; real intervals (incl. [0,0]) survive",
  );
});

test("N1a control: negative bounds skip even when the pair is not -1/-1", () => {
  const state = createInitialState();
  state.blocks = [
    sentinelBlock({ blockId: "neg-start", startSeq: -1, endSeq: 5 }),
    sentinelBlock({ blockId: "neg-end", startSeq: 2, endSeq: -3 }),
    sentinelBlock({ blockId: "unbounded" }),
  ];
  assert.deepEqual(coveredSeqIntervals(state), [], "no interval can claim anything through a negative bound");
});

test("N1b: syncBlocks seq-presence treats the sentinel as absent", () => {
  const state = createInitialState();
  // Ids churned away (nothing matches the id path), stamp inside a REAL
  // interval would keep it alive; the sentinel must not.
  state.blocks = [
    sentinelBlock({ blockId: "gone", effectiveMessageIds: ["churned-away"], startSeq: -1, endSeq: -1 }),
  ];
  const visible: CoreMessage[] = [
    { id: "fresh-1", role: "user", contentType: "text", text: LONG.repeat(40), ledgerSeq: 5 },
  ];
  const synced = syncBlocks(visible, state);
  assert.equal(synced.state.blocks[0]!.active, false, "sentinel is not presence evidence");
  assert.deepEqual(synced.deactivated, ["gone"]);

  // Control: the same shape with a real interval covering the visible stamp
  // stays active (the S9 contract, guarding against over-skipping).
  const control = createInitialState();
  control.blocks = [
    sentinelBlock({ blockId: "kept", effectiveMessageIds: ["churned-away"], startSeq: 0, endSeq: 10 }),
  ];
  const controlSynced = syncBlocks(visible, control);
  assert.equal(controlSynced.state.blocks[0]!.active, true, "real interval still claims presence");
});

test("N1c: fold-time coverage claim treats a sentinel consumed block as no claim", () => {
    // Round-2 review F2: a NEW fold consuming a sentinel-bounded block must
    // record NO seq bounds. The old guard (endSeq >= startSeq) let {start:-1,
    // end:-1} pass as a real segment, and its adjacency rule (next.start <=
    // merged.end + 1 → 0 <= -1 + 1) merged a direct seq-0 stamp onto the
    // sentinel, recording startSeq=-1 on the NEW block — then the prune/sync
    // negative-bound guards skip it and the store freezes -1 forever.
    // Shape (10 messages): s3/s4 live inside a migrated sentinel block b7
    // (bounds −1/−1, as restored by host boundsForCovered). Re-folding the
    // block alone (b7..b7, the tier-escalation shape) must record NO seq
    // bounds. OLD code pushed the sentinel as a lone real segment and the
    // new block inherited startSeq=−1/endSeq=−1 — the prune/sync guards then
    // skip it and the store freezes −1 forever. (With adjacent directs the
    // old adjacency rule could also merge the sentinel onto a seq-0 stamp.)
    const core = createCore();
    const body = "fold-time sentinel claim fixture body ";
    const messages: CoreMessage[] = [];
    for (let i = 0; i < 10; i++) {
        messages.push({ id: `s${i}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: body.repeat(60), ledgerSeq: i });
    }
    const state = createInitialState();
    state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
    const sentinel = sentinelBlock({
        blockId: "b7", tier: 2, topic: "migrated",
        effectiveMessageIds: ["s3", "s4"],
        startSeq: -1, endSeq: -1,
    });
    state.blocks.push(sentinel);
    const res = core.applyCompression({
        ranges: [{ startRef: "b7", endRef: "b7", topic: "claimcheck", summary: "fold-time sentinel claim summary long enough to satisfy the kernel minimum summary length gate" }],
        messages, state,
        // preserveRecentTokens must be 0 too: its default tail-budget would
        // protect this short 8-message corpus wholesale.
        config: defaultConfig(100_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
    });
    const block = res.state.blocks.find((b) => b.topic === "claimcheck");
    assert.ok(block?.active, "fold must produce an active block");
    // The sentinel voids the fold-time positional claim entirely: the new
    // block must NOT inherit the sentinel interval as its own bounds (old
    // code recorded startSeq=-1/endSeq=-1 here, which the prune/sync guards
    // skip and the store freezes forever).
    assert.equal(block!.startSeq, undefined, "a fold over a sentinel block records no startSeq claim");
    assert.equal(block!.endSeq, undefined, "a fold over a sentinel block records no endSeq claim");
});
