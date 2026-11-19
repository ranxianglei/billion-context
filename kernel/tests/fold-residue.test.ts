import { test } from "node:test";
import assert from "node:assert/strict";
import { prune } from "../src/prune.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { absorbStaleExclusions } from "../src/absorb-stale.js";
import { isNudgeEchoText } from "../src/nudge-text.js";
import type { CompressionBlock, Config, CoreMessage } from "../src/types.js";

// Fold-residue fixes (session 01a1e75a, 2026-11-17..19):
//  - B1: the first-user pin must not freeze an opening user message that is
//    merely an echo of bili's own rendered nudge text (a pasted evidence
//    blob / a resumed session carrying an old receipt).
//  - B2: a message excluded from a fold by the protected-zone carve (recent-N
//    / last-user anchor) is recorded on the block and absorbed back into its
//    coverage once it leaves the zone — otherwise it orphans forever
//    (sub-threshold, gap-bounded, receipt says "do not re-target").

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolCall(id: string, toolName: string, toolCallId: string): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName, toolCallId };
}

function toolResult(
  id: string,
  text: string,
  toolCallId: string,
): CoreMessage {
  return { id, role: "tool", contentType: "tool-result", toolCallId, text };
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

function block(
  blockId: string,
  effectiveMessageIds: string[],
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    blockId,
    runId: "run-test",
    tier: "normal",
    topic: "topic",
    summary: `summary of ${effectiveMessageIds.join(", ")}`,
    directMessageIds: effectiveMessageIds,
    effectiveMessageIds: [...effectiveMessageIds],
    directBlockIds: [],
    compressedTokens: 10,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

const NUDGE_TEXT =
  "PRIORITY — when the summary must be compact, preserve in this order: " +
  "1. user goal 2. decisions 3. exact artifacts.\n" +
  "Active blocks (2): b1 1–10 · b2 11–20\n\n" +
  "Compressible ranges (1, oldest first):\nm00005–m00010 old work\n" +
  "💡 If you compress, fold the ranges you keep in ONE call.";

test("isNudgeEchoText: two co-occurring nudge markers => echo", () => {
  assert.ok(isNudgeEchoText(NUDGE_TEXT), "full nudge text is an echo");
  assert.ok(
    isNudgeEchoText("…Active blocks (3): b1 1–5 · b2 6–9 · b3 10–12\nCompressible ranges (1, oldest first):"),
    "ledger + range offer alone are enough",
  );
  assert.ok(
    !isNudgeEchoText("please fix the bug in src/index.ts"),
    "ordinary user text is not an echo",
  );
  assert.ok(
    !isNudgeEchoText("Active blocks (3): b1 1–5"),
    "a single marker is not conclusive",
  );
  assert.ok(!isNudgeEchoText(undefined), "no text is not an echo");
});

test("B1: pin skips a nudge-echo first user when another user message follows", () => {
  const u1 = msg("u1", NUDGE_TEXT);
  const u2 = msg("u2", "later real task");
  const a1 = msg("a1", "assistant answer", "assistant");
  const messages = [u1, u2, a1];
  const state = seededState(messages);
  // b1 covered the echo at fold time — exactly the 01a1e75a shape.
  state.blocks.push(block("b1", ["u1"]));
  const out = prune(messages, state, { injectSummaries: true });
  assert.ok(
    !out.some((m) => (m.text ?? "").startsWith("PRIORITY —")),
    "the nudge echo is folded away (no longer pinned)",
  );
  assert.ok(out.some((m) => m.id === "u2"), "the later user message survives");
  assert.ok(
    out.some((m) => m.id === "acp_summary_b1"),
    "the block's summary carrier is rendered",
  );
});

test("B1: pin still protects a nudge-echo first user when it is the ONLY user message", () => {
  const u1 = msg("u1", NUDGE_TEXT);
  const a1 = msg("a1", "assistant answer", "assistant");
  const messages = [u1, a1];
  const state = seededState(messages);
  state.blocks.push(block("b1", ["u1"]));
  const out = prune(messages, state, { injectSummaries: true });
  assert.ok(
    out.some((m) => (m.text ?? "").startsWith("PRIORITY —")),
    "strict providers need at least one user message — the pin holds",
  );
});

test("B1: pin is untouched for a normal first user (regression)", () => {
  const u1 = msg("u1", "original task: ship the thing");
  const u2 = msg("u2", "later real task");
  const messages = [u1, u2];
  const state = seededState(messages);
  state.blocks.push(block("b1", ["u1"]));
  const out = prune(messages, state, { injectSummaries: true });
  assert.ok(
    out.some((m) => m.id === "u1"),
    "a task-bearing first user stays pinned",
  );
});

test("B2: stale last-user anchor is absorbed once it leaves the protected zone", () => {
  const u1 = msg("u1", "old question (was last user at fold time)");
  const u2 = msg("u2", "newer user message moved the anchor");
  const messages = [u1, u2];
  const state = seededState(messages);
  const b = block("b1", ["m00001-other"], {
    excludedMessageIds: ["u1"],
    startSeq: 1,
    endSeq: 1,
  });
  b.effectiveMessageIds = ["other"];
  b.directMessageIds = ["other"];
  state.blocks.push(b);
  const reports = absorbStaleExclusions(state, messages, config(), (t) => t.length / 4);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].refs, ["m00001"]);
  assert.ok(b.effectiveMessageIds.includes("u1"), "absorbed into coverage");
  assert.equal(b.excludedMessageIds, undefined, "no residue left pending");
  assert.equal(b.startSeq, undefined, "ledger interval claim invalidated");
  assert.equal(b.endSeq, undefined, "ledger interval claim invalidated");
});

test("B2: a still-protected (current last user) exclusion is NOT absorbed", () => {
  const u1 = msg("u1", "current last user — still in the zone");
  const a1 = msg("a1", "assistant reply", "assistant");
  const messages = [u1, a1];
  const state = seededState(messages);
  const b = block("b1", ["x"], { excludedMessageIds: ["u1"] });
  b.effectiveMessageIds = ["x"];
  b.directMessageIds = ["x"];
  state.blocks.push(b);
  // preserveRecentMessages: 1 switches on the last-user anchor rule
  // (Rule 3 is coupled to preserveN > 0) — u1 is the anchor, still protected.
  const reports = absorbStaleExclusions(state, messages, config({ preserveRecentMessages: 1 }), (t) => t.length / 4);
  assert.equal(reports.length, 0, "nothing absorbed while the anchor holds");
  assert.deepEqual(b.excludedMessageIds, ["u1"], "pending list untouched");
});

test("B2: tool-call exclusion is absorbed only when its result half is covered or co-absorbed", () => {
  // Half 1: result already inside the block's coverage -> call is admitted.
  {
    const u1 = msg("u1", "older user text");
    const call = toolCall("c", "read", "tc1");
    const res = toolResult("r", "file contents", "tc1");
    const u2 = msg("u2", "newer user moved the anchor");
    const messages = [u1, call, res, u2];
    const state = seededState(messages);
    const b = block("b1", ["r"], { excludedMessageIds: ["c"] });
    b.effectiveMessageIds = ["r"];
    b.directMessageIds = ["r"];
    state.blocks.push(b);
    const reports = absorbStaleExclusions(state, messages, config(), (t) => t.length / 4);
    assert.equal(reports.length, 1, "call admitted — its result is covered");
    assert.ok(b.effectiveMessageIds.includes("c"));
  }
  // Half 2: result NOT covered anywhere -> call must stay pending.
  {
    const u1 = msg("u1", "older user text");
    const call = toolCall("c", "read", "tc1");
    const res = toolResult("r", "file contents", "tc1");
    const u2 = msg("u2", "newer user moved the anchor");
    const messages = [u1, call, res, u2];
    const state = seededState(messages);
    const b = block("b1", ["u1"], { excludedMessageIds: ["c"] });
    state.blocks.push(b);
    const reports = absorbStaleExclusions(state, messages, config(), (t) => t.length / 4);
    assert.equal(reports.length, 0, "stranding the result is not allowed");
    assert.deepEqual(b.excludedMessageIds, ["c"]);
  }
  // Half 3: BOTH halves excluded from the same fold -> co-absorbed.
  {
    const u1 = msg("u1", "older user text");
    const call = toolCall("c", "read", "tc1");
    const res = toolResult("r", "file contents", "tc1");
    const u2 = msg("u2", "newer user moved the anchor");
    const messages = [u1, call, res, u2];
    const state = seededState(messages);
    const b = block("b1", ["u1"], { excludedMessageIds: ["c", "r"] });
    state.blocks.push(b);
    const reports = absorbStaleExclusions(state, messages, config(), (t) => t.length / 4);
    assert.equal(reports.length, 1, "pair co-absorbed in one pass");
    assert.ok(b.effectiveMessageIds.includes("c"));
    assert.ok(b.effectiveMessageIds.includes("r"));
  }
});
