import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCore,
  defaultConfig,
  defaultCountTokens,
  type CoreMessage,
  type SessionState,
} from "../src/index.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import {
  collectLatestProtected,
  isMessageLatestProtected,
} from "../src/protected.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { applyAbsorb, isAbsorbCandidate } from "../src/absorb.js";

function msg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function todoCall(id: string, callId: string, rev: number): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName: "todo_list",
    toolCallId: callId,
    text: JSON.stringify({ action: "update", revision: rev }),
  };
}

function todoResult(id: string, callId: string, rev: number): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolCallId: callId,
    text: JSON.stringify({
      revision: rev,
      todos: [{ id: "t1", content: `task ${rev}`, status: "pending" }],
    }),
  };
}

function emptyState(): SessionState {
  return {
    blocks: [],
    prune: { byMessageId: {}, activeBlockIds: [] },
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {
      lastPerMessageNudgeTokens: 0,
      lastNudgeShownTokens: 0,
      pendingNudgeTurn: null,
      baselineTokens: 0,
    },
    stats: { totalTokensCompressed: 0 },
    compressionTiming: {},
  };
}

const validSummary =
  "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

function latestCfg(overrides: Record<string, unknown> = {}) {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    protectedLatestTools: ["todo_list"],
    ...overrides,
  });
}

test("collectLatestProtected: no patterns → empty set", () => {
  const messages = [todoCall("c1", "t1", 1), todoResult("r1", "t1", 1)];
  const latest = collectLatestProtected(messages, {});
  assert.equal(latest.callIds.size, 0);
  assert.equal(latest.msgIds.size, 0);
});

test("collectLatestProtected: picks the LAST matching call per pattern", () => {
  const messages = [
    todoCall("c1", "t1", 1),
    todoResult("r1", "t1", 1),
    msg("u", "continue"),
    todoCall("c2", "t2", 2),
    todoResult("r2", "t2", 2),
  ];
  const latest = collectLatestProtected(messages, {
    protectedLatestTools: ["todo_list"],
  });
  assert.deepEqual([...latest.callIds], ["t2"]);
  assert.equal(latest.msgIds.size, 0);
});

test("collectLatestProtected: glob suffix pattern matches", () => {
  const messages = [todoCall("c1", "t1", 1)];
  const latest = collectLatestProtected(messages, {
    protectedLatestTools: ["todo_*"],
  });
  assert.deepEqual([...latest.callIds], ["t1"]);
});

test("collectLatestProtected: call without toolCallId is protected by message id", () => {
  const call: CoreMessage = {
    id: "c1",
    role: "assistant",
    contentType: "tool-call",
    toolName: "todo_list",
    text: "{}",
  };
  const latest = collectLatestProtected([call], {
    protectedLatestTools: ["todo_list"],
  });
  assert.deepEqual([...latest.msgIds], ["c1"]);
  assert.equal(latest.callIds.size, 0);
});

test("collectLatestProtected: no matching call → empty", () => {
  const latest = collectLatestProtected([msg("u", "hi")], {
    protectedLatestTools: ["todo_list"],
  });
  assert.equal(latest.callIds.size, 0);
  assert.equal(latest.msgIds.size, 0);
});

test("isMessageLatestProtected: matches latest call and its paired result only", () => {
  const c1 = todoCall("c1", "t1", 1);
  const r1 = todoResult("r1", "t1", 1);
  const c2 = todoCall("c2", "t2", 2);
  const r2 = todoResult("r2", "t2", 2);
  const latest = collectLatestProtected([c1, r1, c2, r2], {
    protectedLatestTools: ["todo_list"],
  });
  assert.ok(isMessageLatestProtected(c2, latest), "latest call");
  assert.ok(isMessageLatestProtected(r2, latest), "latest result (paired)");
  assert.ok(!isMessageLatestProtected(c1, latest), "older call");
  assert.ok(!isMessageLatestProtected(r1, latest), "older result");
  assert.ok(!isMessageLatestProtected(msg("u", "hi"), latest), "text msg");
});

test("processTurn: only the latest todo_list pair is BLOCKED; older pairs keep refs", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", "start"),
    todoCall("c1", "t1", 1),
    todoResult("r1", "t1", 1),
    msg("b", "middle"),
    todoCall("c2", "t2", 2),
    todoResult("r2", "t2", 2),
  ];
  const result = core.processTurn({
    messages,
    state: emptyState(),
    config: latestCfg(),
    tokenCount: 0,
    countTokens: defaultCountTokens,
  });
  assert.equal(result.state.messageRefs.byRaw["a"], "m00001");
  assert.equal(result.state.messageRefs.byRaw["c1"], "m00002");
  assert.equal(result.state.messageRefs.byRaw["r1"], "m00003");
  assert.equal(result.state.messageRefs.byRaw["b"], "m00004");
  assert.equal(result.state.messageRefs.byRaw["c2"], "BLOCKED");
  assert.equal(result.state.messageRefs.byRaw["r2"], "BLOCKED");
});

test("applyCompression: latest pair excluded from block, older pair folded", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", "x".repeat(6000)),
    todoCall("c1", "t1", 1),
    todoResult("r1", "t1", 1),
    msg("b", "x".repeat(6000)),
    todoCall("c2", "t2", 2),
    todoResult("r2", "t2", 2),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00006", summary: validSummary }],
    messages,
    state,
    config: latestCfg(),
  });
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);
  const block = result.state.blocks[0]!;
  assert.ok(block.directMessageIds.includes("c1"), "older call folded");
  assert.ok(block.directMessageIds.includes("r1"), "older result folded");
  assert.ok(block.effectiveMessageIds.includes("c1"));
  assert.ok(block.effectiveMessageIds.includes("r1"));
  assert.ok(!block.directMessageIds.includes("c2"), "latest call excluded");
  assert.ok(!block.directMessageIds.includes("r2"), "latest result excluded");
  assert.ok(
    !block.effectiveMessageIds.includes("c2"),
    "latest call not covered",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("r2"),
    "latest result not covered",
  );
});

test("applyCompression: superseded pair is folded once a newer pair exists", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", "x".repeat(6000)),
    todoCall("c1", "t1", 1),
    todoResult("r1", "t1", 1),
    msg("b", "x".repeat(6000)),
    todoCall("c2", "t2", 2),
    todoResult("r2", "t2", 2),
    msg("d", "x".repeat(6000)),
    todoCall("c3", "t3", 3),
    todoResult("r3", "t3", 3),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00006", summary: validSummary }],
    messages,
    state,
    config: latestCfg(),
  });
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[0]!;
  assert.ok(block.directMessageIds.includes("c1"), "first pair folded");
  assert.ok(block.directMessageIds.includes("r1"));
  assert.ok(block.directMessageIds.includes("c2"), "superseded pair folded");
  assert.ok(block.directMessageIds.includes("r2"));
  assert.ok(!block.directMessageIds.includes("c3"), "latest pair untouched");
  assert.ok(!block.directMessageIds.includes("r3"));
});

test("applyCompression: protectedTools (hard) excludes ALL pairs, unlike protectedLatestTools", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", "x".repeat(6000)),
    todoCall("c1", "t1", 1),
    todoResult("r1", "t1", 1),
    msg("b", "x".repeat(6000)),
    todoCall("c2", "t2", 2),
    todoResult("r2", "t2", 2),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00006", summary: validSummary }],
    messages,
    state,
    config: latestCfg({
      protectedLatestTools: [],
      protectedTools: ["todo_list"],
    }),
  });
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("c1"),
    "hard: first call excluded",
  );
  assert.ok(
    !block.directMessageIds.includes("r1"),
    "hard: first result excluded",
  );
  assert.ok(
    !block.directMessageIds.includes("c2"),
    "hard: latest call excluded",
  );
  assert.ok(
    !block.directMessageIds.includes("r2"),
    "hard: latest result excluded",
  );
});

test("buildCompressibleRanges: latest pair protected, older pair compressible", () => {
  const messages: CoreMessage[] = [
    msg("a", "x".repeat(2000)),
    todoCall("c1", "t1", 1),
    todoResult("r1", "t1", 1),
    msg("b", "x".repeat(2000)),
    todoCall("c2", "t2", 2),
    todoResult("r2", "t2", 2),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const ranges = buildCompressibleRanges(messages, state, latestCfg());
  // Older pair stays compressible. (Groups split at a user message once a
  // group reaches 3 messages — pre-existing behavior — so a..r1 and b are
  // two ranges.)
  assert.equal(ranges.compressible.length, 2, "older pair stays compressible");
  assert.equal(ranges.compressible[0]!.startRef, "m00001");
  assert.equal(ranges.compressible[0]!.endRef, "m00003");
  assert.equal(ranges.compressible[0]!.count, 3);
  assert.equal(ranges.compressible[1]!.startRef, "m00004");
  assert.equal(ranges.compressible[1]!.endRef, "m00004");
  assert.equal(ranges.compressible[1]!.count, 1);
  assert.equal(
    ranges.protected.length,
    1,
    "latest pair is one protected range",
  );
  const pr = ranges.protected[0]!;
  assert.equal(pr.startRef, "m00005");
  assert.equal(pr.endRef, "m00006");
  assert.deepEqual(pr.tools, ["todo_list"]);
});

test("isAbsorbCandidate: latest-protected result is not a candidate, older is", () => {
  const messages: CoreMessage[] = [
    todoCall("c1", "t1", 1),
    todoResult("r1", "t1", 1),
    todoCall("c2", "t2", 2),
    todoResult("r2", "t2", 2),
  ];
  const config = latestCfg({
    absorb: {
      enabled: true,
      toolName: "absorb",
      minToolTokens: 0,
      contextThresholdPct: 0,
      excludeTools: [],
    },
  });
  const latest = collectLatestProtected(messages, config);
  assert.ok(!isAbsorbCandidate(messages[3]!, config, latest), "latest result");
  assert.ok(isAbsorbCandidate(messages[1]!, config, latest), "older result");
});

test("applyAbsorb: rejects the latest-protected result, accepts the older one", () => {
  const messages: CoreMessage[] = [
    todoCall("c1", "t1", 1),
    todoResult("r1", "t1", 1),
    todoCall("c2", "t2", 2),
    todoResult("r2", "t2", 2),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const config = latestCfg({
    absorb: {
      enabled: true,
      toolName: "absorb",
      minToolTokens: 0,
      contextThresholdPct: 0,
      excludeTools: [],
    },
  });
  const rejected = applyAbsorb({
    ref: "m00004",
    summary: "distilled essentials of the result",
    messages,
    state,
    config,
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.resultText, /protected/);
  const accepted = applyAbsorb({
    ref: "m00002",
    summary: "distilled essentials of the result",
    messages,
    state,
    config,
  });
  assert.equal(accepted.ok, true);
});
