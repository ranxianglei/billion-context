import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { resolveBoundaries, BoundaryNotFoundError } from "../src/boundaries.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
import { assignRefs } from "../src/refs.js";
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
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

test("applyCompression creates a T1 block covering the resolved range", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "a and b summarized",
        topic: "intro",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
  assert.equal(result.state.blocks.length, 1);
  const block = result.state.blocks[0]!;
  assert.equal(block.tier, 1);
  assert.equal(block.active, true);
  assert.equal(block.topic, "intro");
  assert.deepEqual(block.effectiveMessageIds.sort(), ["a", "b"]);
  assert.deepEqual(block.directMessageIds.sort(), ["a", "b"]);
  assert.ok(result.result.tokensCompressed > 0);
});

test("prune after applyCompression removes covered messages and injects summary", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });

  const pruned = prune(messages, after);
  assert.deepEqual(
    pruned.map((m) => m.id),
    ["u", "acp_summary_b1", "c", "d"],
  );
  assert.ok(pruned[1]!.text!.includes("intro recap"));
});

test("resolveBoundaries normalizes reversed refs and records a transparency note", () => {
  const state = createInitialState();
  const messages = [msg("a", "x"), msg("b", "y"), msg("c", "z")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const reversed = resolveBoundaries({
    startRef: "m00003",
    endRef: "m00001",
    messages,
    state,
  });
  assert.equal(reversed.startIndex, 0);
  assert.equal(reversed.endIndex, 2);
  assert.deepEqual(reversed.messageIds, ["a", "b", "c"]);
  assert.equal(
    reversed.reversedNote,
    "note: refs were given reversed (m00003→m00001), normalized to m00001..m00003",
  );

  const forward = resolveBoundaries({
    startRef: "m00001",
    endRef: "m00003",
    messages,
    state,
  });
  assert.equal(forward.reversedNote, undefined);
});

test("gate verdict carries the reversal note instead of hiding it", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "x"), msg("b", "y"), msg("c", "z")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00001", summary: "reversed" }],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.state.blocks.length, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /too small \(3 tokens across 1 range\(s\), min 5000\)/,
  );
  assert.match(
    result.result.errors[0]!,
    /note: refs were given reversed \(m00003→m00001\), normalized to m00001\.\.m00003/,
  );
  assert.equal(result.result.notes, undefined);
});

test("successful compression of a reversed range reports the rewrite in notes", () => {
  const core = createCore();
  const state = createInitialState();
  const big = "w".repeat(4000);
  const messages = [
    msg("a", big),
    msg("b", big),
    msg("c", big),
    msg("d", big),
    msg("e", big),
    msg("f", big),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00006", endRef: "m00001", summary: "big reversed" }],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.deepEqual(result.result.notes, [
    "note: refs were given reversed (m00006→m00001), normalized to m00001..m00006",
  ]);
});

test("mixed batch appends the reversal note to the too-small verdict", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("a", "x"),
    msg("b", "y"),
    msg("c", "z"),
    msg("d", "w"),
    msg("e", "v"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "tiny ok" },
      { startRef: "m00005", endRef: "m00004", summary: "reversed pair" },
    ],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /too small \(4 tokens across 2 range\(s\), min 5000\)/,
  );
  assert.match(
    result.result.errors[0]!,
    /note: refs were given reversed \(m00005→m00004\), normalized to m00004\.\.m00005/,
  );
});

test("all-invalid batch reports per-range errors without fabricating a size verdict", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "x"), msg("b", "y"), msg("c", "z")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "foo", endRef: "bar", summary: "bad" }],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /Invalid boundary ref\(s\)/);
  assert.doesNotMatch(result.result.errors.join("\n"), /too small/i);
});

test("block-boundary compression produces T2 and consumes matching T1 blocks", () => {
  const core = createCore();
  let state = createInitialState();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
    msg("e", "epsilon"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const t1 = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "t1 block a-b" }],
    messages,
    state,
    config: config(),
  });
  state = t1.state;

  const t2 = core.applyCompression({
    ranges: [
      { startRef: "b1", endRef: "b1", summary: "t2 distillation of b1" },
    ],
    messages,
    state,
    config: config(),
  });

  const block = t2.state.blocks[1]!;
  assert.equal(block.tier, 2);
  assert.equal(block.blockId, "b2");
  const consumed = t2.state.blocks[0]!;
  assert.equal(consumed.active, false);
  assert.deepEqual(block.effectiveMessageIds.sort(), ["a", "b"]);
});

test("processTurn assigns refs, prunes, and returns nudge decision", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "hello world"), msg("b", "second message")];

  const result = core.processTurn({
    messages,
    state,
    config: config(),
    tokenCount: 50000,
  });

  assert.equal(result.state.messageRefs.byRaw["a"], "m00001");
  assert.equal(result.state.messageRefs.byRaw["b"], "m00002");
  assert.equal(result.messages.length, 2);
  assert.ok(result.nudge, "nudge decision returned");
  assert.ok(result.nudge!.contextUsage > 0);
});

test("search returns active blocks matching the query, ranked", () => {
  const core = createCore();
  const state = createInitialState();
  state.blocks.push(
    {
      blockId: "b1",
      runId: "r1",
      tier: 1,
      topic: "auth login",
      summary: "token refresh flow",
      directMessageIds: [],
      effectiveMessageIds: [],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
    {
      blockId: "b2",
      runId: "r1",
      tier: 1,
      topic: "deployment",
      summary: "docker compose",
      directMessageIds: [],
      effectiveMessageIds: [],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
  );

  const hits = core.search("auth token", state);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.blockId, "b1");
});

test("search finds keywords occurring fewer than three times in a summary (#2158)", () => {
  const core = createCore();
  const state = createInitialState();
  state.blocks.push(
    {
      blockId: "b1",
      runId: "r1",
      tier: 1,
      topic: "preflight overflow compress",
      summary: "handled the preflight overflow path and its retry budget",
      directMessageIds: [],
      effectiveMessageIds: [],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
    {
      blockId: "b2",
      runId: "r1",
      tier: 1,
      summary: "recorded probe alphaone, unique-marker-2026 独特中文短语甲乙丙 and review_github_issues.py once each",
      directMessageIds: [],
      effectiveMessageIds: [],
      directBlockIds: [],
      createdAt: 1,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
  );

  // Single occurrence in the summary, no topic: the minimum positive signal
  // (0.04) was silently dropped by the old 0.1 relevance floor.
  assert.deepEqual(core.search("unique-marker-2026", state).map((b) => b.blockId), ["b2"]);
  assert.deepEqual(core.search("alphaone", state).map((b) => b.blockId), ["b2"]);
  assert.deepEqual(core.search("独特中文短语甲乙丙", state).map((b) => b.blockId), ["b2"]);
  // The exact reported shape: a real filename occurring once in the summary.
  assert.deepEqual(core.search("review_github_issues.py", state).map((b) => b.blockId), ["b2"]);
  // Topic matches still outrank summary-only matches.
  assert.deepEqual(core.search("preflight", state).map((b) => b.blockId), ["b1"]);
  // Zero lexical overlap still returns nothing.
  assert.deepEqual(core.search("nonexistenttermxyz", state), []);
});

test("GC is fully removed: createCore() exposes no gc method", () => {
  const core = createCore() as unknown as Record<string, unknown>;
  assert.equal(core["gc"], undefined, "gc() must not exist — GC was removed");
});

test("blocks are never deactivated for age (no maxBlockAge behavior)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("old1", "content from old turn")];
  state.blocks.push({
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "old but still active",
    directMessageIds: ["old1"],
    effectiveMessageIds: ["old1"],
    directBlockIds: [],
    createdAt: 0,
    survivedCount: 999,
    generation: "old",
    active: true,
  });
  const result = core.processTurn({
    messages,
    state,
    config: config(),
    tokenCount: 95000,
  });
  assert.equal(
    result.state.blocks[0]!.active,
    true,
    "block must stay active regardless of age",
  );
});

test("applyCompression reports error for unknown boundary ref", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "x")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00099", endRef: "m00100", summary: "nope" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
});

test("batch compress attributes per-range errors and keeps partial success", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "x".repeat(60),
        topic: "ok",
      },
      {
        startRef: "m00003",
        endRef: "m00004",
        summary: "y".repeat(22),
        topic: "short",
      },
    ],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 0,
        maxSummaryLength: 0,
        minSummaryLength: 50,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 1, "valid range still compresses");
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /^range m00003\.\.m00004: Summary too short \(22 chars, min 50\)/,
  );
});

test("retrying a consumed range reports already-compressed guidance, not too-small", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);

  const retry = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages: pruned,
    state: after,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.equal(retry.result.errors.length, 1);
  assert.match(retry.result.errors[0]!, /already compressed/);
  assert.match(
    retry.result.errors[0]!,
    /already summarized in active block\(s\) b1/,
  );
  assert.doesNotMatch(
    retry.result.errors[0]!,
    /retry with startId\/endId set to active block IDs/,
  );
  assert.doesNotMatch(
    retry.result.errors[0]!,
    /Total compressible content too small/,
  );
});

test("consumed plus fresh-but-small range is not misreported as too small", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);

  const retry = core.applyCompression({
    ranges: [
      { startRef: "m00002", endRef: "m00003", summary: "intro recap" },
      { startRef: "m00004", endRef: "m00005", summary: "c and d" },
    ],
    messages: pruned,
    state: after,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.equal(retry.result.errors.length, 1);
  assert.match(retry.result.errors[0]!, /already compressed/);
  assert.match(
    retry.result.errors[0]!,
    /already summarized in active block\(s\) b1/,
  );
  assert.match(
    retry.result.errors[0]!,
    /\[diagnostics: session highest ref=m00005, unknown ranges in request=0\/2, session history=1 compression\(s\), 1 block\(s\)\]/,
  );
  assert.doesNotMatch(retry.result.errors[0]!, /renumber/i);
  assert.match(retry.result.errors[0]!, /[Rr]un acp_status/);
  assert.doesNotMatch(retry.result.errors[0]!, /Combine more messages/);
});

test("all-unknown batch reports stale refs instead of too-small (billion-context-pi#178)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00050", endRef: "m00060", summary: "stale A" },
      { startRef: "m00070", endRef: "m00080", summary: "stale B" },
    ],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 3);
  assert.match(
    result.result.errors[0]!,
    /None of the 2 requested range\(s\) resolved/,
  );
  assert.match(result.result.errors[0]!, /no compress reassigns them/);
  assert.match(
    result.result.errors[0]!,
    /cannot come from an earlier compress in this session/,
  );
  assert.match(
    result.result.errors[0]!,
    /\[diagnostics: session highest ref=m00005, unknown ranges in request=2\/2, session history=0 compression\(s\), 0 block\(s\)\]/,
  );
  assert.doesNotMatch(result.result.errors[0]!, /renumber/i);
  assert.match(result.result.errors[0]!, /Run acp_status/);
  assert.doesNotMatch(result.result.errors[0]!, /too small/);
  assert.match(result.result.errors[1]!, /does not exist in this session/);
  assert.match(result.result.errors[2]!, /does not exist in this session/);
});

test("consumed plus unknown ranges keep the already-compressed message", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);

  const retry = core.applyCompression({
    ranges: [
      { startRef: "m00002", endRef: "m00003", summary: "intro recap" },
      { startRef: "m00050", endRef: "m00060", summary: "stale" },
    ],
    messages: pruned,
    state: after,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.match(retry.result.errors[0]!, /already compressed/);
  assert.doesNotMatch(
    retry.result.errors[0]!,
    /None of the 2 requested range\(s\) resolved/,
  );
  assert.match(
    retry.result.errors.find((e) => e.startsWith("range m00050..m00060")) ?? "",
    /does not exist in this session/,
  );
});

test("first compress of a fresh session with foreign refs reports a new generation, not a prior compress (billion-context#387)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("u", "the task"), msg("a", "alpha"), msg("b", "beta")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00050", endRef: "m00060", summary: "foreign" }],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 2);
  assert.match(
    result.result.errors[0]!,
    /None of the 1 requested range\(s\) resolved/,
  );
  assert.match(
    result.result.errors[0]!,
    /cannot come from an earlier compress in this session/,
  );
  assert.match(result.result.errors[0]!, /switching model or upstream/);
  assert.match(result.result.errors[0]!, /native-compaction rebase/);
  assert.match(
    result.result.errors[0]!,
    /\[diagnostics: session highest ref=m00003, unknown ranges in request=1\/1, session history=0 compression\(s\), 0 block\(s\)\]/,
  );
  assert.doesNotMatch(result.result.errors[0]!, /renumber/i);
  assert.match(result.result.errors[1]!, /does not exist in this session/);
});

test("refs from before a native-compaction rebase report a new generation with zeroed history (billion-context#387)", () => {
  const core = createCore();
  const oldState = createInitialState();
  const oldMessages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  oldState.messageRefs = assignRefs(oldMessages, {
    existing: oldState.messageRefs,
    nextIndex: 1,
  }).map;
  const { state: afterOne } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "s1" }],
    messages: oldMessages,
    state: oldState,
    config: config(),
  });
  const { state: afterTwo } = core.applyCompression({
    ranges: [{ startRef: "m00004", endRef: "m00005", summary: "s2" }],
    messages: oldMessages,
    state: afterOne,
    config: config(),
  });
  assert.equal(afterTwo.stats.compressionCount, 2);

  const rebased = createInitialState();
  const freshMessages = [msg("u2", "new task"), msg("e", "epsilon")];
  rebased.messageRefs = assignRefs(freshMessages, {
    existing: rebased.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00004", endRef: "m00005", summary: "old refs" }],
    messages: freshMessages,
    state: rebased,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.match(
    result.result.errors[0]!,
    /None of the 1 requested range\(s\) resolved/,
  );
  assert.match(result.result.errors[0]!, /native-compaction rebase/);
  assert.match(result.result.errors[0]!, /refs restart at m00001/);
  assert.match(
    result.result.errors[0]!,
    /\[diagnostics: session highest ref=m00002, unknown ranges in request=1\/1, session history=0 compression\(s\), 0 block\(s\)\]/,
  );
  assert.doesNotMatch(result.result.errors[0]!, /renumber/i);
});

test("drifted message content dangles the old ref — reported as unanchorable, not already-compressed (billion-context#387)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const drifted = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d2", "delta (edited)"),
  ];
  state.messageRefs = assignRefs(drifted, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00004", endRef: "m00005", summary: "c and d" }],
    messages: drifted,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /cannot be anchored/);
  assert.match(result.result.errors[0]!, /no active block covers them/);
  assert.match(result.result.errors[0]!, /recorded as DEAD/);
  assert.match(result.result.errors[0]!, /Do not retry this range in any form/);
  assert.deepEqual(result.state.deadRefs, ["m00005"]);
  assert.match(
    result.result.errors[0]!,
    /\[diagnostics: session highest ref=m00006, unknown ranges in request=0\/1, session history=0 compression\(s\), 0 block\(s\)\]/,
  );
  assert.doesNotMatch(result.result.errors[0]!, /already compressed/);
  assert.doesNotMatch(result.result.errors[0]!, /renumber/i);
});

test("fresh small content without consumed ranges keeps the too-small message", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "a and b" }],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.match(
    result.result.errors[0]!,
    /^Total compressible content too small \(\d+ tokens across 1 range\(s\), min 5000\)/,
  );
});

test("consumed plus fresh content above threshold proceeds with a warning", () => {
  const core = createCore();
  const state = createInitialState();
  const big = "z".repeat(24000);
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", big),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);

  const retry = core.applyCompression({
    ranges: [
      { startRef: "m00002", endRef: "m00003", summary: "intro recap" },
      { startRef: "m00004", endRef: "m00005", summary: "big block" },
    ],
    messages: pruned,
    state: after,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(retry.result.blocksCreated, 1);
  assert.equal(retry.result.errors.length, 0);
  assert.ok(
    retry.result.warnings.some((w) =>
      /Skipped range \(m00002\.\.m00003\) — already compressed/.test(w),
    ),
    `expected consumed warning in: ${JSON.stringify(retry.result.warnings)}`,
  );
});

test("empty summary is attributed to its range", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /^range m00001\.\.m00002: Summary is empty/,
  );
});

test("invalid refs are reported per-range without failing the batch", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      // Over the widened cap (9,999,999) → invalid shape, reported per-range.
      // (m999999 was the pre-#483 out-of-range sentinel; it is a valid ref now.)
      { startRef: "m10000000", endRef: "m00002", summary: "bad ref" },
      { startRef: "m00001", endRef: "m00002", summary: "good summary" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1, "valid range still compresses");
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /^range m10000000\.\.m00002: Invalid boundary ref/,
  );
});

test("unknown ref (valid format, never allocated) names the ref and suggests acp_status", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00099", endRef: "m00100", summary: "nope" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /does not exist in this session/);
  assert.match(result.result.errors[0]!, /run acp_status/);
});

test("consumed ranges warn+skip when minCompressRange is 0", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);

  const retry = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "intro recap" }],
    messages: pruned,
    state: after,
    config: config(),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.equal(retry.result.errors.length, 0);
  assert.ok(
    retry.result.warnings.some((w) =>
      /Skipped range \(m00002\.\.m00003\) — already compressed/.test(w),
    ),
    `expected consumed warning in: ${JSON.stringify(retry.result.warnings)}`,
  );
});

test("resolveBoundaries throws typed BoundaryNotFoundError with kind and endpoint", () => {
  const state = createInitialState();
  const messages = [
    msg("u", "the task"),
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  assert.throws(
    () =>
      resolveBoundaries({
        startRef: "m00099",
        endRef: "m00001",
        messages,
        state,
      }),
    (e: unknown) =>
      e instanceof BoundaryNotFoundError &&
      e.kind === "unknown" &&
      e.endpoint === "start",
  );

  const core = createCore();
  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00003", summary: "a and b" }],
    messages,
    state,
    config: config(),
  });
  const pruned = prune(messages, after);
  assert.throws(
    () =>
      resolveBoundaries({
        startRef: "m00002",
        endRef: "m00003",
        messages: pruned,
        state: after,
      }),
    (e: unknown) =>
      e instanceof BoundaryNotFoundError &&
      e.kind === "consumed" &&
      e.endpoint === "start",
  );
});

test("consumed block anchor snaps to the active owning block instead of failing the call (#32 livelock)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("a", "old one"),
    msg("b", "old two"),
    msg("c", "raw c"),
    msg("d", "raw d"),
    msg("e", "raw e"),
    msg("f", "raw f"),
    msg("g", "raw g"),
    msg("h", "raw h"),
    msg("i", "raw i"),
    msg("j", "raw j"),
    msg("k", "recent one"),
    msg("l", "recent two"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state.blocks.push(
    {
      blockId: "b2",
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: "s2",
      directMessageIds: ["a"],
      effectiveMessageIds: ["a", "b"],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: false,
    },
    {
      blockId: "b50",
      runId: "r1",
      tier: 2,
      topic: "t",
      summary: "t2 distill",
      directMessageIds: [],
      effectiveMessageIds: ["a", "b"],
      directBlockIds: ["b2"],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
    {
      blockId: "b110",
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: "s110",
      directMessageIds: ["k"],
      effectiveMessageIds: ["k", "l"],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
  );
  state.nextBlockId = 111;

  const result = core.applyCompression({
    ranges: [
      { startRef: "b2", endRef: "b110", summary: "distilled span", topic: "t" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1, JSON.stringify(result.result));
  assert.equal(result.result.errors.length, 0);
  assert.ok(
    result.result.warnings.some((w) =>
      w.includes('startId="b2" was consumed by a higher-tier block'),
    ),
    `expected snap warning in: ${JSON.stringify(result.result.warnings)}`,
  );
  const created = result.state.blocks.find((b) => b.blockId === "b111");
  assert.ok(created, "new block allocated after b110");
  assert.equal(created!.tier, 2);
  assert.deepEqual(created!.directBlockIds, ["b110"]);
  assert.equal(
    result.state.blocks.find((b) => b.blockId === "b110")!.active,
    false,
  );
  assert.equal(
    result.state.blocks.find((b) => b.blockId === "b50")!.active,
    true,
  );
});

test("consumed message anchor snaps to the active block covering it", () => {
  const core = createCore();
  const state = createInitialState();
  const full = [
    msg("a", "old one"),
    msg("b", "old two"),
    msg("c", "raw c"),
    msg("d", "raw d"),
    msg("e", "raw e"),
    msg("f", "raw f"),
    msg("g", "raw g"),
    msg("h", "raw h"),
    msg("i", "raw i"),
    msg("j", "raw j"),
    msg("k", "recent one"),
    msg("l", "recent two"),
  ];
  state.messageRefs = assignRefs(full, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state.blocks.push(
    {
      // Consumed child kept in state (kernel invariant: applySingleRange
      // deactivates but never deletes) so b50's inheritance is resolvable.
      blockId: "b2",
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: "s2",
      directMessageIds: ["a", "b"],
      effectiveMessageIds: ["a", "b"],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: false,
    },
    {
      blockId: "b50",
      runId: "r1",
      tier: 2,
      topic: "t",
      summary: "t2 distill",
      directMessageIds: ["c"],
      effectiveMessageIds: ["a", "b", "c"],
      directBlockIds: ["b2"],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
    {
      blockId: "b110",
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: "s110",
      directMessageIds: ["k"],
      effectiveMessageIds: ["k", "l"],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
  );
  const visible = full.slice(2);

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "b110",
        summary: "distilled span",
        topic: "t",
      },
    ],
    messages: visible,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1, JSON.stringify(result.result));
  assert.equal(result.result.errors.length, 0);
  assert.ok(
    result.result.warnings.some((w) =>
      w.includes('startId="m00001" refers to a message already compressed'),
    ),
    `expected snap warning in: ${JSON.stringify(result.result.warnings)}`,
  );
});

test("gate error names the covering block when anchors stay consumed", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "x"), msg("b", "y"), msg("k", "z")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state.blocks.push(
    {
      blockId: "b2",
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: "s2",
      directMessageIds: ["a"],
      effectiveMessageIds: ["a", "b"],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: false,
    },
    {
      blockId: "b110",
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: "s110",
      directMessageIds: ["k"],
      effectiveMessageIds: ["k"],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    },
  );

  const result = core.applyCompression({
    ranges: [
      { startRef: "b2", endRef: "b110", summary: "distilled span", topic: "t" },
    ],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /Requested range\(s\) already compressed \(e\.g\. b2\.\.b110\)/,
  );
  assert.match(
    result.result.errors[0]!,
    /its content is already summarized in active block\(s\) b110 — use search_context or decompress b110 if you need details from it/,
  );
  assert.doesNotMatch(
    result.result.errors[0]!,
    /retry with startId\/endId set to active block IDs/,
  );
});
