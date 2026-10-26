import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { assignRefs } from "../src/refs.js";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { createInitialState } from "../src/state.js";
import type { CompressionState, Config, CoreMessage } from "../src/types.js";

// #3769 regression: orphaned failed compress calls are hidden only where a committed
// fold already broke the cached prefix (at/after its earliest start ref), tracked in a
// persistent monotonic set — never rotated away on a quiet turn. These cases pin that timing.

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

test("a third failed compress appended to history does NOT rewrite mid-history on a quiet turn (#3769)", () => {
  const state = createInitialState();
  const messages: CoreMessage[] = [];
  messages.push(msg("p1", "early context"));
  messages.push(...failPair("f1"));
  messages.push(msg("p2", "mid context"));
  messages.push(...failPair("f2"));
  messages.push(msg("p3", "newer context"));
  messages.push(...failPair("f3"));
  seqRefs(state, messages);

  const inbound = messages.map((m) => m.id);
  const r = hideConsumedCompressCalls(state, messages, isMcp);

  assert.equal(r.hidden, 0, "quiet turn sweeps nothing");
  assert.equal(r.newlySweptCallIds.length, 0, "no fold -> nothing newly swept");
  assert.deepEqual(
    r.messages.map((m) => m.id),
    inbound,
    "outbound ids identical to inbound: oldest failure NOT rotated away mid-history",
  );
});

test("a fold sweeps orphans at/after its start but keeps earlier ones in the cached prefix (#3769)", () => {
  const state = createInitialState();
  const messages: CoreMessage[] = [];
  messages.push(msg("p1", "early"));
  messages.push(...failPair("f1"));
  messages.push(msg("p2", "mid"));
  messages.push(...failPair("f2"));
  messages.push(msg("p3", "late"));
  messages.push(...failPair("f3"));
  seqRefs(state, messages);
  // refs: p1=1 f1c=2 f1r=3 p2=4 f2c=5 f2r=6 p3=7 f3c=8 f3r=9
  state.pendingOrphanSweepMinRef = 5;

  const r = hideConsumedCompressCalls(state, messages, isMcp);
  assert.deepEqual(r.newlySweptCallIds, ["f2", "f3"], "only orphans at/after fold start swept");
  const ids = r.messages.map((m) => m.id);
  assert.ok(ids.includes("c-f1"), "orphan before fold start stays visible");
  assert.ok(!ids.includes("c-f2") && !ids.includes("c-f3"), "orphans at/after fold start removed");
});

test("once swept, an orphan stays hidden on later quiet turns (persistent, restart-safe) (#3769)", () => {
  const state = createInitialState();
  const messages: CoreMessage[] = [];
  messages.push(msg("p1", "early"));
  messages.push(...failPair("f1"));
  messages.push(msg("p2", "mid"));
  messages.push(...failPair("f2"));
  seqRefs(state, messages);

  state.pendingOrphanSweepMinRef = 5;
  const first = hideConsumedCompressCalls(state, messages, isMcp);
  assert.deepEqual(first.newlySweptCallIds, ["f2"], "the fold sweep removes only f2");

  state.sweptOrphanCallIds = [...first.newlySweptCallIds];
  state.pendingOrphanSweepMinRef = undefined;

  const second = hideConsumedCompressCalls(state, messages, isMcp);
  assert.equal(second.newlySweptCallIds.length, 0, "quiet turn adds nothing");
  const ids = second.messages.map((m) => m.id);
  assert.ok(!ids.includes("c-f2"), "previously-swept orphan stays hidden");
  assert.ok(ids.includes("c-f1"), "unswept orphan remains visible");
});

test("failures do not roll-clean per attempt: N quiet turns sweep nothing, one fold sweeps once (#3769)", () => {
  const base: CoreMessage[] = [msg("p1", "early")];
  for (let t = 1; t <= 3; t++) {
    const state = createInitialState();
    const messages: CoreMessage[] = [...base];
    for (let k = 1; k <= t; k++) messages.push(...failPair(`f${k}`));
    seqRefs(state, messages);

    const r = hideConsumedCompressCalls(state, messages, isMcp);
    assert.equal(r.hidden, 0, `turn ${t}: no fold -> nothing swept despite ${t} failures`);
    assert.equal(r.newlySweptCallIds.length, 0, `turn ${t}: no new sweep`);
  }

  const state = createInitialState();
  const messages: CoreMessage[] = [...base];
  for (let k = 1; k <= 3; k++) messages.push(...failPair(`f${k}`));
  seqRefs(state, messages);
  state.pendingOrphanSweepMinRef = 1;
  const r = hideConsumedCompressCalls(state, messages, isMcp);
  assert.deepEqual(r.newlySweptCallIds, ["f1", "f2", "f3"], "one fold sweeps all eligible orphans at once");
});

test("a real fold writes the sweep marker and the next pass removes the orphan behind it (#3769)", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("h1", "first detailed work item alpha content"),
    msg("h2", "second detailed work item beta content"),
    msg("h3", "third detailed work item gamma content"),
    ...failPair("f1"),
    msg("h4", "fourth detailed work item delta content"),
    msg("last", "latest user intent theta"),
  ];
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
  assert.equal(out.state.pendingOrphanSweepMinRef, 1, "marker points at the fold's earliest start ref");

  const r = hideConsumedCompressCalls(out.state, messages, isMcp);
  assert.deepEqual(r.newlySweptCallIds, ["f1"], "orphan behind the fold is swept");
  assert.ok(!r.messages.some((m) => m.toolCallId === "f1"), "swept orphan removed from outbound");
});

test("a block-boundary fold marks the sweep by covered message refs, not the block number (#3769)", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("p1", "early cached prefix alpha"),
    ...failPair("f1"),
    msg("p2", "mid detailed work item beta content"),
    msg("p3", "mid detailed work item gamma content"),
    msg("p4", "mid detailed work item delta content"),
    msg("p5", "mid detailed work item epsilon content"),
    msg("p6", "latest user intent theta"),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  // refs: p1=1 c-f1=2 r-f1=3 p2=4 p3=5 p4=6 p5=7 p6=8

  const first = core.applyCompression({
    ranges: [{ startRef: "m00004", endRef: "m00005", summary: "fold the mid pair", topic: "mid" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(first.result.errors.length, 0, `unexpected errors: ${first.result.errors.join("; ")}`);
  assert.ok(first.result.blocksCreated >= 1, "the mid pair folds");
  const blockId = first.state.blocks[first.state.blocks.length - 1].blockId;

  const out = core.applyCompression({
    ranges: [{ startRef: blockId, endRef: "m00006", summary: "distill the block plus its tail", topic: "distill" }],
    messages,
    state: first.state,
    config: config(),
  });
  assert.equal(out.result.errors.length, 0, `unexpected errors: ${out.result.errors.join("; ")}`);
  assert.ok(out.result.blocksCreated >= 1, "the block-boundary range folds");
  // Parsing the new block's startRef string ("b1") yields the BLOCK number 1, which
  // would sweep the cached-prefix orphan f1 (ref 2). Covered-ref derivation must say 4.
  assert.equal(out.state.pendingOrphanSweepMinRef, 4, "marker sits at the earliest covered message ref");

  const r = hideConsumedCompressCalls(out.state, messages, isMcp);
  assert.deepEqual(r.newlySweptCallIds, [], "cached-prefix orphan before the fold is untouched");
  assert.ok(r.messages.some((m) => m.toolCallId === "f1"), "f1 remains visible");
});

test("an upgraded pre-fold-gate state keeps its rotation-hidden orphan hidden (#3769)", () => {
  const state = createInitialState();
  const messages: CoreMessage[] = [
    msg("p1", "early"),
    ...failPair("f1"),
    msg("p2", "mid"),
    ...failPair("f2"),
    msg("p3", "late"),
    ...failPair("f3"),
  ];
  seqRefs(state, messages);
  // refs: p1=1 c-f1=2 r-f1=3 p2=4 c-f2=5 r-f2=6 p3=7 c-f3=8 r-f3=9

  // Exact shape of a state the old keep-two kernel persisted: with three failures
  // the rotation had already removed f1 from mid-history and remembered its refs.
  // sweptOrphanCallIds / pendingOrphanSweepMinRef do not exist yet.
  state.hiddenOrphanRefs = ["m00002", "m00003"];

  const first = hideConsumedCompressCalls(state, messages, isMcp);
  assert.deepEqual(first.newlySweptCallIds, [], "nothing newly swept without a fold");
  const ids = first.messages.map((m) => m.id);
  assert.ok(!ids.includes("c-f1") && !ids.includes("r-f1"), "previously-hidden pair does not resurface on upgrade");
  assert.ok(ids.includes("c-f2") && ids.includes("c-f3"), "recent failures stay visible");

  // Pipeline write-back (hide-compress-calls node) then another quiet turn: the
  // legacy set self-perpetuates through rememberHiddenRef, no new field required.
  state.hiddenOrphanRefs = first.hiddenOrphanRefs;
  const second = hideConsumedCompressCalls(state, messages, isMcp);
  const ids2 = second.messages.map((m) => m.id);
  assert.ok(!ids2.includes("c-f1") && !ids2.includes("r-f1"), "still hidden on the next quiet turn");
});

test("a re-sent pair quoting an active block's range is its carrier: the fold sweep leaves it visible (#3769/#1567)", () => {
  // Plugin-style fold: the block is minted a server-side callId the client can
  // never echo, so the client's re-sent pair for that exact fold is fate=orphan
  // by id — yet it IS the block's summary carrier (the host strips the in-place
  // anchor only while the pair rides the history). Sweeping it would strand the
  // fold with zero wire carriers. Both arg shapes must be recognized, mirroring
  // the host carrier index (flat {startId,endId} AND {content:[…]}).
  const core = createCore();
  const build = (callId: string, callText: string): CoreMessage[] => [
    msg("h1", "first detailed work item alpha content"),
    msg("h2", "second detailed work item beta content"),
    msg("h3", "third detailed work item gamma content"),
    {
      id: `c-${callId}`,
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: callId,
      text: callText,
    },
    {
      id: `r-${callId}`,
      role: "tool",
      contentType: "tool-result",
      toolCallId: callId,
      text: "compressed the head",
    },
    msg("last", "latest user intent theta"),
  ];
  const fold = (messages: CoreMessage[], state: CompressionState) =>
    core.applyCompression({
      ranges: [
        { startRef: "m00001", endRef: "m00003", summary: "fold the spent head", topic: "head", compressCallId: "plugin_1234" },
      ],
      messages,
      state,
      config: config(),
    });

  const carriers: Array<[string, string]> = [
    ["flat {startId,endId}", JSON.stringify({ startId: "m00001", endId: "m00003", topic: "head", summary: "fold the spent head" })],
    ["{content:[…]} array", JSON.stringify({ content: [{ startId: "m00001", endId: "m00003", topic: "head", summary: "fold the spent head" }] })],
  ];
  for (const [label, callText] of carriers) {
    const messages = build("call_echo_1", callText);
    const state = createInitialState();
    state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
    const out = fold(messages, state);
    assert.equal(out.result.errors.length, 0, `${label}: unexpected errors: ${out.result.errors.join("; ")}`);
    assert.ok(out.result.blocksCreated >= 1, `${label}: the head genuinely folds`);

    const r = hideConsumedCompressCalls(out.state, messages, isMcp);
    assert.deepEqual(r.newlySweptCallIds, [], `${label}: carrier pair exempt from the fold sweep`);
    assert.ok(r.messages.some((m) => m.toolCallId === "call_echo_1"), `${label}: carrier pair stays visible (#1567)`);
  }

  // Negative control: a failure whose quoted range matches NO block is still swept.
  const messages = build(
    "call_fail_9",
    JSON.stringify({ content: [{ startId: "mX", endId: "mY", summary: "s" }] }),
  );
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  const out = fold(messages, state);
  assert.equal(out.result.errors.length, 0, `negative: unexpected errors: ${out.result.errors.join("; ")}`);
  const r = hideConsumedCompressCalls(out.state, messages, isMcp);
  assert.deepEqual(r.newlySweptCallIds, ["call_fail_9"], "true failure residue at/after the fold is swept");
});

test("the fold marker survives the full pipeline: sync-blocks carries it to the hide node (#3769)", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("p1", "early cached prefix alpha"),
    ...failPair("f2"),
    msg("p2", "mid detailed work item beta content"),
  ];
  const state = createInitialState();
  seqRefs(state, messages);
  // refs: p1=1 c-f2=2 r-f2=3 p2=4 — a fold starting at ref 2 committed last turn.
  // Before the sync-blocks carry fix this marker died on the FIRST pipeline node
  // (syncBlocks rebuilt state without the #3769 fields), so the sweep never fired.
  state.pendingOrphanSweepMinRef = 2;

  const cfg = { ...config(), isCompressTool: isMcp };
  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 1000,
    renderTags: "none",
  });

  const ids = turn.messages.map((m) => m.id);
  assert.ok(!ids.includes("c-f2") && !ids.includes("r-f2"), "orphan at/after fold start swept inside the pipeline");
  assert.deepEqual(turn.state.sweptOrphanCallIds, ["f2"], "swept id folded into the persistent set");
  assert.equal(turn.state.pendingOrphanSweepMinRef, undefined, "one-shot marker consumed");

  const quiet = core.processTurn({
    messages: [...messages, msg("p3", "latest user intent theta")],
    state: turn.state,
    config: cfg,
    tokenCount: 1000,
    renderTags: "none",
  });
  const ids2 = quiet.messages.map((m) => m.id);
  assert.ok(!ids2.includes("c-f2"), "previously-swept orphan stays hidden on the next pipeline pass");
});
