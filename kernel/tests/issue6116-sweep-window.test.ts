import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { assignRefs } from "../src/refs.js";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { createInitialState } from "../src/state.js";
import type { CompressionState, Config, CoreMessage } from "../src/types.js";

// #6116 regression: the fold-gated orphan sweep (#3769) is bounded by a WINDOW —
// [earliest covered ref of the pending fold, highest ref allocated when it committed].
// The successful compress call and any same-turn calls issued after it only receive
// refs above that frontier, so their failure feedback must survive the sweep: wiping
// fresh error text would push the model straight back into re-issuing the same no-op
// compress (the pathology #3769 exists to prevent). Under-sweep is safe; over-sweep
// is not. States written before #6116 lack the max bound and keep the pre-fix
// unbounded behavior (upgrade compat).

const isMcp = (n: string) => n === "compress" || n === "mcp__bili__compress";

function msg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function failPair(callId: string): [CoreMessage, CoreMessage] {
  return [
    {
      id: `c-${callId}`,
      role: "assistant",
      contentType: "tool-call",
      toolName: "mcp__bili__compress",
      toolCallId: callId,
      text: JSON.stringify({ content: [{ startId: "mA", endId: "mB", summary: "s" }] }),
    },
    {
      id: `r-${callId}`,
      role: "tool",
      contentType: "tool-result",
      toolCallId: callId,
      text: "nothing to compress",
    },
  ];
}

function seqRefs(state: CompressionState, messages: CoreMessage[]): void {
  messages.forEach((m, i) => {
    state.messageRefs.byRaw[m.id] = `m${String(i + 1).padStart(5, "0")}`;
  });
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

// refs: p1=1 c-f1=2 r-f1=3 p2=4 c-f2=5 r-f2=6 p3=7 c-f3=8 r-f3=9 p4=10 c-f4=11 r-f4=12
function windowLayout(): { state: CompressionState; messages: CoreMessage[] } {
  const state = createInitialState();
  const messages: CoreMessage[] = [];
  messages.push(msg("p1", "early"));
  messages.push(...failPair("f1"));
  messages.push(msg("p2", "mid"));
  messages.push(...failPair("f2"));
  messages.push(msg("p3", "late"));
  messages.push(...failPair("f3"));
  messages.push(msg("p4", "later"));
  messages.push(...failPair("f4"));
  seqRefs(state, messages);
  return { state, messages };
}

test("the sweep window is inclusive on both ends: inside swept, outside visible (#6116)", () => {
  const { state, messages } = windowLayout();
  state.pendingOrphanSweepMinRef = 5;
  state.pendingOrphanSweepMaxRef = 9;

  const r = hideConsumedCompressCalls(state, messages, isMcp);
  assert.deepEqual(r.newlySweptCallIds, ["f2", "f3"], "only orphans inside [min,max] swept");
  const ids = r.messages.map((m) => m.id);
  assert.ok(ids.includes("c-f1"), "orphan below min stays visible (still-cached prefix)");
  assert.ok(!ids.includes("c-f2") && !ids.includes("c-f3"), "in-window orphans removed");
  assert.ok(ids.includes("c-f4"), "orphan above max stays visible (fresh failure feedback)");

  // Endpoint inclusivity, one side each.
  const lo = createInitialState();
  seqRefs(lo, messages);
  lo.pendingOrphanSweepMinRef = 5;
  lo.pendingOrphanSweepMaxRef = 5;
  assert.deepEqual(
    hideConsumedCompressCalls(lo, messages, isMcp).newlySweptCallIds,
    ["f2"],
    "lower endpoint inclusive",
  );
  const hi = createInitialState();
  seqRefs(hi, messages);
  hi.pendingOrphanSweepMinRef = 8;
  hi.pendingOrphanSweepMaxRef = 8;
  assert.deepEqual(
    hideConsumedCompressCalls(hi, messages, isMcp).newlySweptCallIds,
    ["f3"],
    "upper endpoint inclusive",
  );
});

test("a legacy state without the max bound degrades to the pre-fix unbounded sweep (#6116 upgrade compat)", () => {
  const { state, messages } = windowLayout();
  state.pendingOrphanSweepMinRef = 5;
  // pendingOrphanSweepMaxRef absent: exactly the shape of states written before #6116.

  const r = hideConsumedCompressCalls(state, messages, isMcp);
  assert.deepEqual(
    r.newlySweptCallIds,
    ["f2", "f3", "f4"],
    "min-only marker keeps the #3769 unbounded-at/after behavior",
  );
});

test("a max bound without a min marker sweeps nothing (defensive invariant, #6116)", () => {
  const { state, messages } = windowLayout();
  state.pendingOrphanSweepMaxRef = 12;
  // Cannot arise in practice — applyCompression sets both markers together — but
  // the guard order must make a stray max inert rather than an all-history sweep.

  const r = hideConsumedCompressCalls(state, messages, isMcp);
  assert.equal(r.hidden, 0, "no min marker -> no sweep");
  assert.equal(r.newlySweptCallIds.length, 0, "stray max bound is inert");
});

test("a real fold writes BOTH markers: min = earliest covered ref, max = commit-time frontier (#6116)", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("h1", "first detailed work item alpha content"),
    msg("h2", "second detailed work item beta content"),
    msg("h3", "third detailed work item gamma content"),
    ...failPair("f1"),
    msg("h4", "fourth detailed work item delta content"),
    msg("last", "latest user intent theta"),
  ];
  // refs: h1=1 h2=2 h3=3 c-f1=4 r-f1=5 h4=6 last=7
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const out = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: "fold the spent head", topic: "head" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(out.result.errors.length, 0, `unexpected errors: ${out.result.errors.join("; ")}`);
  assert.ok(out.result.blocksCreated >= 1, "the head genuinely folds");
  assert.equal(out.state.pendingOrphanSweepMinRef, 1, "min marker points at the fold's earliest start ref");
  assert.equal(out.state.pendingOrphanSweepMaxRef, 7, "max marker is the highest allocated ref at commit time");
});

test("a failure issued after the successful call keeps its feedback visible (mixed multi-tool turn, #6116)", () => {
  // THE issue scenario: the model fires several tools in one assistant turn. The
  // request history the fold applies to ends BEFORE the response's calls land; the
  // successful call and any later same-turn failures only get refs on the next
  // assignRefs pass — strictly above the committed frontier — so they must stay
  // out of the sweep while the pre-success residue inside the window goes away.
  const core = createCore();
  const requestHistory: CoreMessage[] = [
    msg("h1", "first detailed work item alpha content"),
    msg("h2", "second detailed work item beta content"),
    msg("h3", "third detailed work item gamma content"),
    ...failPair("f1"),
    msg("h4", "fourth detailed work item delta content"),
    msg("last", "latest user intent theta"),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(requestHistory, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const out = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00003", summary: "fold the spent head", topic: "head", compressCallId: "s1" },
    ],
    messages: requestHistory,
    state,
    config: config(),
  });
  assert.equal(out.result.errors.length, 0, `unexpected errors: ${out.result.errors.join("; ")}`);
  assert.equal(out.state.pendingOrphanSweepMaxRef, 7, "frontier frozen at apply time");

  // The response then rides the history: success s1 (the block's carrier) plus a
  // fresh failure fAfter issued in the same turn.
  const extended: CoreMessage[] = [
    ...requestHistory,
    {
      id: "c-s1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "mcp__bili__compress",
      toolCallId: "s1",
      text: JSON.stringify({ content: [{ startId: "m00001", endId: "m00003", summary: "fold the spent head" }] }),
    },
    {
      id: "r-s1",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "s1",
      text: "compressed the head",
    },
    ...failPair("fAfter"),
  ];
  out.state.messageRefs = assignRefs(extended, {
    existing: out.state.messageRefs,
    nextIndex: 8,
  }).map;
  // c-s1=8 r-s1=9 c-fAfter=10 r-fAfter=11 — all strictly above the frontier.

  const r = hideConsumedCompressCalls(out.state, extended, isMcp);
  assert.deepEqual(r.newlySweptCallIds, ["f1"], "only the pre-success failure inside the window is swept");
  const ids = r.messages.map((m) => m.id);
  assert.ok(ids.includes("c-fAfter") && ids.includes("r-fAfter"), "post-success failure stays visible for the model to react to");
  assert.ok(ids.includes("c-s1"), "the active success carrier is untouched");
});

test("two folds before one consuming turn: running min + running max define the union window (#6116)", () => {
  const core = createCore();
  const m1: CoreMessage[] = [
    msg("h1", "first detailed work item alpha content"),
    msg("h2", "second detailed work item beta content"),
    msg("h3", "third detailed work item gamma content"),
    ...failPair("f1"),
    msg("h4", "fourth detailed work item delta content"),
    msg("last", "latest user intent theta"),
  ];
  // refs: h1=1 h2=2 h3=3 c-f1=4 r-f1=5 h4=6 last=7
  const state = createInitialState();
  state.messageRefs = assignRefs(m1, { existing: state.messageRefs, nextIndex: 1 }).map;

  const first = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: "fold the head", topic: "head" }],
    messages: m1,
    state,
    config: config(),
  });
  assert.equal(first.result.errors.length, 0, `unexpected errors: ${first.result.errors.join("; ")}`);
  assert.equal(first.state.pendingOrphanSweepMinRef, 1, "first fold: min=1");
  assert.equal(first.state.pendingOrphanSweepMaxRef, 7, "first fold: max=7");

  // Next request appends two messages and folds the tail — no consuming turn in
  // between, so the markers accumulate instead of resetting.
  const m2: CoreMessage[] = [
    ...m1,
    msg("p5", "fifth detailed work item epsilon content"),
    msg("p6", "sixth detailed work item zeta content"),
  ];
  first.state.messageRefs = assignRefs(m2, { existing: first.state.messageRefs, nextIndex: 8 }).map;
  // p5=8 p6=9
  const second = core.applyCompression({
    ranges: [{ startRef: "m00006", endRef: "m00009", summary: "fold the tail", topic: "tail" }],
    messages: m2,
    state: first.state,
    config: config(),
  });
  assert.equal(second.result.errors.length, 0, `unexpected errors: ${second.result.errors.join("; ")}`);
  assert.ok(second.result.blocksCreated >= 1, "the tail genuinely folds");
  assert.equal(second.state.pendingOrphanSweepMinRef, 1, "running MIN keeps the earliest fold start");
  assert.equal(second.state.pendingOrphanSweepMaxRef, 9, "running MAX tracks the newest frontier");

  const r = hideConsumedCompressCalls(second.state, m2, isMcp);
  assert.deepEqual(r.newlySweptCallIds, ["f1"], "union window [1,9] sweeps the pre-fold orphan once");
});

test("the full pipeline carries the max bound and consumes BOTH markers one-shot (#6116)", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("p1", "early cached prefix alpha"),
    ...failPair("f2"),
    msg("p2", "mid detailed work item beta content"),
    ...failPair("f3"),
  ];
  const state = createInitialState();
  seqRefs(state, messages);
  // refs: p1=1 c-f2=2 r-f2=3 p2=4 c-f3=5 r-f3=6 — a fold covering refs 2..3
  // committed last turn. Without the sync-blocks carry of the NEW field the max
  // would die on the first pipeline node and degrade to the unbounded sweep,
  // wrongly taking f3 (ref 5 > intended max 3).
  state.pendingOrphanSweepMinRef = 2;
  state.pendingOrphanSweepMaxRef = 3;

  const cfg = { ...config(), isCompressTool: isMcp };
  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 1000,
    renderTags: "none",
  });

  const ids = turn.messages.map((m) => m.id);
  assert.ok(!ids.includes("c-f2") && !ids.includes("r-f2"), "orphan inside the window swept inside the pipeline");
  assert.ok(ids.includes("c-f3") && ids.includes("r-f3"), "orphan above the carried max bound stays visible");
  assert.deepEqual(turn.state.sweptOrphanCallIds, ["f2"], "swept id folded into the persistent set");
  assert.equal(turn.state.pendingOrphanSweepMinRef, undefined, "min marker consumed one-shot");
  assert.equal(turn.state.pendingOrphanSweepMaxRef, undefined, "max marker consumed one-shot");
});
