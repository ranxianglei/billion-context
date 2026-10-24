import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { isMessageProtected } from "../src/protected.js";
import { computeTurnRetention } from "../src/turn-retention.js";
import { SUMMARY_HEADER } from "../src/prune.js";
import type { Config, CoreMessage } from "../src/types.js";

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
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function seededState(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

// Five text turns: tNu/tNa pairs → refs m00001..m00010 (t1u..t5a).
const FIVE_TURNS: CoreMessage[] = [
  msg("t1u", "user instruction one"),
  msg("t1a", "assistant reply one", "assistant"),
  msg("t2u", "user instruction two"),
  msg("t2a", "assistant reply two", "assistant"),
  msg("t3u", "user instruction three"),
  msg("t3a", "assistant reply three", "assistant"),
  msg("t4u", "user instruction four"),
  msg("t4a", "assistant reply four", "assistant"),
  msg("t5u", "user instruction five"),
  msg("t5a", "assistant reply five", "assistant"),
];

test("computeTurnRetention: off when unset / 0 / negative (#4593)", () => {
  const state = createInitialState();
  assert.equal(computeTurnRetention(FIVE_TURNS, state, {}), null);
  assert.equal(computeTurnRetention(FIVE_TURNS, state, { preserveRecentTurns: 0 }), null);
  assert.equal(computeTurnRetention(FIVE_TURNS, state, { preserveRecentTurns: -1 }), null);
});

test("computeTurnRetention: the window starts AT the (N+1)-th-from-last user message (#4593)", () => {
  const state = createInitialState();
  // Boundaries at idx 0,2,4,6,8.
  assert.deepEqual(computeTurnRetention(FIVE_TURNS, state, { preserveRecentTurns: 1 }), {
    boundaryIndex: 8,
    turns: 1,
  });
  assert.deepEqual(computeTurnRetention(FIVE_TURNS, state, { preserveRecentTurns: 2 }), {
    boundaryIndex: 6,
    turns: 2,
  });
  assert.deepEqual(computeTurnRetention(FIVE_TURNS, state, { preserveRecentTurns: 4 }), {
    boundaryIndex: 2,
    turns: 4,
  });
});

test("computeTurnRetention: fractional N floors like host parse (#4593)", () => {
  const state = createInitialState();
  assert.deepEqual(computeTurnRetention(FIVE_TURNS, state, { preserveRecentTurns: 1.9 }), {
    boundaryIndex: 8,
    turns: 1,
  });
});

test("computeTurnRetention: fewer than N+1 turns protects everything (#4593)", () => {
  const state = createInitialState();
  assert.deepEqual(computeTurnRetention(FIVE_TURNS, state, { preserveRecentTurns: 6 }), {
    boundaryIndex: 0,
    turns: 6,
  });
  assert.deepEqual(computeTurnRetention(FIVE_TURNS.slice(0, 4), state, { preserveRecentTurns: 5 }), {
    boundaryIndex: 0,
    turns: 5,
  });
});

test("computeTurnRetention: consecutive user messages count as ONE boundary (#4593)", () => {
  const state = createInitialState();
  const batched = [
    msg("a", "runtime context snapshot"),
    msg("b", "the instruction"),
    msg("c", "reply", "assistant"),
  ];
  // One boundary (idx 0); N=1 needs two → whole conversation retained.
  assert.deepEqual(computeTurnRetention(batched, state, { preserveRecentTurns: 1 }), {
    boundaryIndex: 0,
    turns: 1,
  });
  const batchedPlus = [...batched, msg("d", "next instruction"), msg("e", "reply two", "assistant")];
  // Boundaries [0, 3]; N=1 → window starts at idx 3.
  assert.deepEqual(computeTurnRetention(batchedPlus, state, { preserveRecentTurns: 1 }), {
    boundaryIndex: 3,
    turns: 1,
  });
});

test("computeTurnRetention: summary carriers are not turn boundaries (#4593)", () => {
  const state = createInitialState();
  const msgs = [
    msg("s", `${SUMMARY_HEADER}\nold folded content`),
    msg("a", "real instruction"),
    msg("b", "reply", "assistant"),
  ];
  // Single real boundary (idx 1); N=1 → fewer than 2 → all retained.
  assert.deepEqual(computeTurnRetention(msgs, state, { preserveRecentTurns: 1 }), {
    boundaryIndex: 0,
    turns: 1,
  });
});

test("#4593: folding older turns succeeds while the last N turns stay verbatim", () => {
  const core = createCore();
  const messages = [...FIVE_TURNS];
  const state = seededState(messages);
  const cfg = config({ preserveRecentTurns: 2 });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: "turns one and two", topic: "old" }],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.errors.length, 0, JSON.stringify(result.result.errors));
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.deepEqual([...block.directMessageIds].sort(), ["t1a", "t1u", "t2a", "t2u"]);
  for (const id of ["t3u", "t3a", "t4u", "t4a", "t5u", "t5a"]) {
    assert.ok(!block.directMessageIds.includes(id), `${id} must stay verbatim`);
  }
});

test("#4593: a range crossing the turn boundary truncates there with an auditable warning", () => {
  const core = createCore();
  const messages = [...FIVE_TURNS];
  const state = seededState(messages);
  const cfg = config({ preserveRecentTurns: 2 });

  // m00003..m00008 = t2u..t4a; the retained suffix starts at t4u (m00007).
  const result = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00008", summary: "crossing the boundary", topic: "cross" }],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.errors.length, 0, JSON.stringify(result.result.errors));
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.deepEqual([...block.directMessageIds].sort(), ["t2a", "t2u", "t3a", "t3u"]);
  const warning = result.result.warnings.join("\n");
  assert.match(warning, /last 2 turns/);
  assert.match(warning, /last-turns retention/);
});

test("#4593: a range entirely inside the retained turns is rejected naming the turn zone", () => {
  const core = createCore();
  const messages = [...FIVE_TURNS];
  const state = seededState(messages);
  const cfg = config({ preserveRecentTurns: 2 });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00007", endRef: "m00010", summary: "inside the zone", topic: "bad" }],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /entirely.*protected.*zone/i);
  assert.match(result.result.errors[0]!, /last 2 turns/);
});

test("#4593: protectUserMessages hard-excludes user messages (BLOCKED refs + auditable carve)", () => {
  const core = createCore();
  const messages = [...FIVE_TURNS];
  const cfg = config({ protectUserMessages: true });

  // Ref assignment itself must render user messages BLOCKED.
  const assigned = assignRefs(messages, {
    existing: createInitialState().messageRefs,
    nextIndex: 1,
    isProtected: (m) => isMessageProtected(m, cfg),
  });
  assert.equal(assigned.map.byRaw["t1u"], "BLOCKED");
  assert.equal(assigned.map.byRaw["t3u"], "BLOCKED");
  // BLOCKED refs consume no numbers: assistants take m00001..m00005.
  assert.equal(assigned.map.byRaw["t1a"], "m00001");
  assert.equal(assigned.map.byRaw["t5a"], "m00005");

  const state = seededState(messages);
  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00006", summary: "folding around the instructions", topic: "mixed" }],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.errors.length, 0, JSON.stringify(result.result.errors));
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.deepEqual([...block.directMessageIds].sort(), ["t1a", "t2a", "t3a"]);
  const warning = result.result.warnings.join("\n");
  assert.match(warning, /protectUserMessages/);
  assert.match(warning, /user message/);
});

test("#4593: a range containing only protected user messages is rejected", () => {
  const core = createCore();
  const messages = [
    msg("u1", "instruction one"),
    msg("u2", "instruction two"),
    msg("a1", "reply", "assistant"),
  ];
  const state = seededState(messages);
  const cfg = config({ protectUserMessages: true });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "users only", topic: "none" }],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /no compressible messages/);
});

test("#4593: preserveRecentTurns unions with preserveRecentMessages (one soft set)", () => {
  const core = createCore();
  const messages = [...FIVE_TURNS];
  const state = seededState(messages);
  // Last 2 messages (t5u/t5a) + last 4 turns (from t2u) → union starts at t2u.
  const cfg = config({ preserveRecentMessages: 2, preserveRecentTurns: 4 });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: "up to the union edge", topic: "union" }],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.errors.length, 0, JSON.stringify(result.result.errors));
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.deepEqual([...block.directMessageIds].sort(), ["t1a", "t1u"]);
  const warning = result.result.warnings.join("\n");
  assert.match(warning, /last 4 turns/);
});

test("#4593: defaults are off — legacy behavior unchanged without the flags", () => {
  const core = createCore();
  const messages = [...FIVE_TURNS];
  const state = seededState(messages);
  const cfg = config();

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: "legacy fold", topic: "legacy" }],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.errors.length, 0, JSON.stringify(result.result.errors));
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.ok(block.directMessageIds.includes("t1u"), "old user messages fold normally by default");
  const flagged = result.result.warnings.filter((w) => /turns?|user message/i.test(w));
  assert.equal(flagged.length, 0, JSON.stringify(flagged));
});
