import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { assignRefs } from "../src/refs.js";
import { createInitialState } from "../src/state.js";
import { prune, isRenderedSummaryMessage, summaryMessageId } from "../src/prune.js";
import { syncBlocks } from "../src/sync.js";
import { buildStatusReport, buildRecap } from "../src/report.js";
import { retireBlocks, restoreBlocks, rewriteBlockSummary } from "../src/block-ops.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type { Config, CompressionState, CoreMessage } from "../src/types.js";

// #5765 (mirror #5767) regression: block retire / restore / external summary rewrite.
// Retired blocks leave the resident view (no summary anchor injected every turn) while
// their folded messages stay covered and decompress keeps working; both operations are
// roll-backable (restore; previousSummary one step deep). Gate discipline: every case
// below asserts both directions — triggers when it should, stays inert when it should not.

function msg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
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

/** Fold h1..h3 into b1 over a 6-message history; returns [state, messages]. */
function foldHead(): [CompressionState, CoreMessage[]] {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("h1", "first detailed work item alpha content"),
    msg("h2", "second detailed work item beta content"),
    msg("h3", "third detailed work item gamma content"),
    msg("h4", "fourth detailed work item delta content"),
    msg("h5", "fifth detailed work item epsilon content"),
    msg("last", "latest user intent theta"),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const out = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: "fold the spent head: three early work items", topic: "head" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(out.result.errors.length, 0, `unexpected errors: ${out.result.errors.join("; ")}`);
  assert.ok(out.result.blocksCreated >= 1, "the head genuinely folds");
  return [out.state, messages];
}

function hasB1Summary(view: CoreMessage[]): boolean {
  return view.some(
    (m) => isRenderedSummaryMessage(m) && m.id === summaryMessageId("b1"),
  );
}

test("retire removes the summary from the resident view but keeps coverage (#5765)", () => {
  const [state, messages] = foldHead();
  const before = prune(messages, state, {});
  assert.ok(hasB1Summary(before), "active block's summary is resident before retire");
  // h1 is the session's opening user message — the first-user pin (DESIGN.md
  // §8.1) keeps it on the wire even when covered; h2/h3 are not pinned.
  assert.ok(before.some((m) => m.id === "h1"), "first-user pin keeps h1 (pre-existing pin, not this feature)");
  assert.ok(!before.some((m) => m.id === "h2"), "covered raws pruned before retire");

  const outcome = retireBlocks(state, ["b1"]);
  assert.deepEqual(outcome.applied, ["b1"], "first retire applies");
  assert.deepEqual(outcome.noop, [], "nothing was already retired");
  assert.deepEqual(outcome.failed, [], "no failures");

  const after = prune(messages, state, {});
  assert.ok(!hasB1Summary(after), "retired block's summary is NOT injected");
  assert.ok(!after.some((m) => m.id === "h2"), "coverage preserved: folded raws stay pruned");
  assert.ok(after.some((m) => m.id === "h4"), "uncovered messages untouched");
  assert.ok(after.some((m) => m.id === "last"), "recent tail untouched");
  const charsBefore = before.map((m) => m.text ?? "").join("").length;
  const charsAfter = after.map((m) => m.text ?? "").join("").length;
  assert.ok(charsAfter < charsBefore, `view total drops by the summary size (${charsBefore} -> ${charsAfter})`);

  // Negative control: an un-retired twin still injects in the same session.
  const restore = restoreBlocks(state, ["b1"]);
  assert.deepEqual(restore.applied, ["b1"], "restore applies once");
  const back = prune(messages, state, {});
  assert.ok(hasB1Summary(back), "restored block's summary re-enters the view");
});

test("retire/restore are idempotent and reject unknown/inactive targets (#5765)", () => {
  const [state] = foldHead();
  assert.deepEqual(retireBlocks(state, ["b1"]).applied, ["b1"]);
  assert.deepEqual(retireBlocks(state, ["b1"]).noop, ["b1"], "second retire is a noop");
  assert.deepEqual(restoreBlocks(state, ["b1"]).applied, ["b1"]);
  assert.deepEqual(restoreBlocks(state, ["b1"]).noop, ["b1"], "second restore is a noop");

  const missing = retireBlocks(state, ["b99"]);
  assert.equal(missing.failed.length, 1, "unknown id fails, does not throw");
  assert.match(missing.failed[0]!.reason, /does not exist/);

  const bad = retireBlocks(state, ["zz"]);
  assert.equal(bad.failed.length, 1, "malformed id fails with a model-readable reason");
  assert.match(bad.failed[0]!.reason, /not a valid block id/);

  state.blocks.find((b) => b.blockId === "b1")!.active = false;
  const inactive = rewriteBlockSummary(state, "b1", "x");
  assert.equal(inactive.ok, false, "inactive (distilled/deactivated) blocks are rejected");
  assert.match(inactive.ok ? "" : inactive.reason, /not active/);
});

test("syncBlocks keeps a retired block active across turns (deactivation trap, #5765)", () => {
  const [state, messages] = foldHead();
  retireBlocks(state, ["b1"]);
  // Host-stripped view: neither the folded raws nor the rendered summary ride the
  // resent history — exactly the shape that deactivates any normal block here.
  const stripped = messages.filter((m) => !["h1", "h2", "h3"].includes(m.id));

  const r = syncBlocks(stripped, state);
  assert.deepEqual(r.deactivated, [], "retired block NOT deactivated despite zero presence signal");
  assert.equal(r.state.blocks.find((b) => b.blockId === "b1")!.active, true, "stays active — orphan GC cannot reap its content");

  // Control: the SAME input deactivates an active block whose content is absent —
  // proves the guard above is load-bearing, not a no-op predicate.
  const [controlState] = foldHead();
  const rc = syncBlocks(stripped, controlState);
  assert.deepEqual(rc.deactivated, ["b1"], "active block without presence signal IS deactivated (control)");
});

test("acp_status overview moves retired blocks to a RETIRED section and the meter follows (#5765)", () => {
  const [state, messages] = foldHead();
  const before = buildStatusReport(state, messages, defaultCountTokens);
  assert.ok(!before.includes("RETIRED BLOCKS"), "no RETIRED section while nothing is retired");

  retireBlocks(state, ["b1"]);
  const after = buildStatusReport(state, messages, defaultCountTokens);
  assert.match(after, /RETIRED BLOCKS — 1 out of the resident view/, "section appears with the freed-size note");
  assert.match(after, /b1/, "the retired block is listed there");
  assert.match(after, /acp_restore\(\{ blockId \}\)/, "the restore hint is present");

  const summaryBucket = (report: string): number => {
    const m = report.match(/([\d.]+[KM]?) summaries \(/);
    return m ? parseFloat(m[1]! + (m[2] === "K" ? "e3" : m[2] === "M" ? "e6" : "")) : 0;
  };
  assert.ok(summaryBucket(after) < summaryBucket(before), "usage metering excludes the retired summary");
});

test("compressed drilldown marks retired blocks (#5765)", () => {
  const [state, messages] = foldHead();
  const plain = buildStatusReport(state, messages, defaultCountTokens, { scope: "compressed" });
  assert.ok(!plain.includes(", retired"), "no retired mark before retiring");
  retireBlocks(state, ["b1"]);
  const marked = buildStatusReport(state, messages, defaultCountTokens, { scope: "compressed" });
  assert.match(marked, /b1 \(T1, retired\)/, "drilldown row carries the retired mark");
});

test("rewrite replaces the summary in place and is roll-backable one step deep (#5765)", () => {
  const [state, messages] = foldHead();
  const block = state.blocks.find((b) => b.blockId === "b1")!;
  const oldSummary = block.summary;
  const oldTokens = block.compressedTokens;

  const ok = rewriteBlockSummary(state, "b1", "much shorter: early work items folded away");
  assert.equal(ok.ok, true, `rewrite should succeed: ${ok.ok ? "" : ok.reason}`);
  if (ok.ok) {
    assert.equal(ok.prevChars, oldSummary.length, "receipt reports the previous size");
    assert.equal(ok.newChars, "much shorter: early work items folded away".length, "receipt reports the new size");
  }
  assert.equal(block.summary, "much shorter: early work items folded away", "summary becomes the given text");
  assert.equal(block.previousSummary, oldSummary, "previous summary retained for rollback");
  assert.ok(typeof block.rewrittenAt === "number" && block.rewrittenAt > 0, "rewrite stamped");
  assert.equal(block.compressedTokens, oldTokens, "original-input token accounting untouched");

  const view = prune(messages, state, {});
  const rendered = view.find((m) => isRenderedSummaryMessage(m) && m.id === summaryMessageId("b1"));
  assert.ok(rendered, "rendered view carries the rewritten summary");
  assert.ok(rendered!.text!.includes("much shorter"), "resident bytes are the new text, not the old");
});

test("rewrite rejects empty, identical, unknown and malformed targets (#5765)", () => {
  const [state] = foldHead();
  const empty = rewriteBlockSummary(state, "b1", "   ");
  assert.equal(empty.ok, false, "blank summary rejected");
  assert.match(empty.ok ? "" : empty.reason, /non-empty/);

  const [state2] = foldHead();
  const current = state2.blocks.find((b) => b.blockId === "b1")!.summary;
  const same = rewriteBlockSummary(state2, "b1", current);
  assert.equal(same.ok, false, "identical summary rejected (nothing to do)");
  assert.match(same.ok ? "" : same.reason, /identical/);

  const missing = rewriteBlockSummary(state, "b99", "x");
  assert.equal(missing.ok, false, "unknown block rejected");
  assert.match(missing.ok ? "" : missing.reason, /does not exist/);

  const bad = rewriteBlockSummary(state, "zz", "x");
  assert.equal(bad.ok, false, "malformed id rejected");
  assert.match(bad.ok ? "" : bad.reason, /not a valid block id/);
});

test("decompress/recap keep working on a retired block (#5765)", () => {
  const [state] = foldHead();
  retireBlocks(state, ["b1"]);
  const recap = buildRecap(state, "b1");
  assert.match(recap, /\[Compressed conversation section\]/, "recap still renders for the retired block");
  assert.match(recap, /fold the spent head/, "the stored summary text is intact");
  assert.match(recap, /\[b1 \| 3 messages \| topic: "head"\]/, "metadata line intact");
});

test("a compress range consuming a retired block is rejected; restoring unblocks it (#5765)", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("h1", "first detailed work item alpha content"),
    msg("h2", "second detailed work item beta content"),
    msg("h3", "third detailed work item gamma content"),
    msg("h4", "fourth detailed work item delta content"),
    msg("h5", "fifth detailed work item epsilon content"),
    msg("h6", "sixth detailed work item zeta content"),
    msg("h7", "seventh detailed work item eta content"),
    msg("last", "latest user intent theta"),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const first = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: "fold the spent head", topic: "head" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(first.result.errors.length, 0, `setup fold failed: ${first.result.errors.join("; ")}`);
  retireBlocks(first.state, ["b1"]);

  const blocked = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00005", summary: "would consume the retired head", topic: "consume" },
      { startRef: "m00006", endRef: "m00007", summary: "fresh tail pair", topic: "tail" },
    ],
    messages,
    state: first.state,
    config: config(),
  });
  // Pre-existing batch contract (compress.ts apply loop): ANY application error
  // rejects the WHOLE batch before folding anything — the guard plugs into it.
  assert.equal(blocked.result.errors.length, 1, "one error for the whole rejected batch");
  assert.match(blocked.result.errors[0]!, /Batch rejected before folding any range/, "whole-batch rejection shape preserved");
  assert.match(blocked.result.errors[0]!, /retired block\(s\) b1/, "error names the retired block");
  assert.match(blocked.result.errors[0]!, /acp_restore/, "error tells the model how to unblock");
  assert.equal(blocked.result.blocksCreated, 0, "nothing folded — the sibling range did not land either");
  assert.equal(blocked.state.blocks.length, 1, "state unchanged apart from the tombstone bookkeeping");

  restoreBlocks(blocked.state, ["b1"]);
  const unblocked = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00005", summary: "now allowed to consume the restored head", topic: "consume" },
      { startRef: "m00006", endRef: "m00007", summary: "fresh tail pair", topic: "tail" },
    ],
    messages,
    state: blocked.state,
    config: config(),
  });
  assert.equal(unblocked.result.errors.length, 0, `restored block is consumable again: ${unblocked.result.errors.join("; ")}`);
  assert.equal(unblocked.result.blocksCreated, 2, "both ranges fold once the block is restored");
});
