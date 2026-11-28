import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// #6762: the kernel nudge decision (NudgeInput) has no tool-failure signal, so
// the pressure band (usage >= maxContextLimitPct) re-fires on EVERY turn —
// including a turn whose LAST message is a FAILED tool result. On such a turn
// the model is about to act on a fresh failure, and a pressure-band nudge
// pushes it to compress; the failure context (the error message, the failed
// command) is the first thing a fold drops, so the model "forgets" the error
// and retries blindly. The fix holds the PRESSURE-BAND injection for that one
// round only (self-recovering: the nudge re-arms on the next turn); the growth
// band is untouched — it has a cadence and does not re-fire every turn, so the
// "re-fires on a failed turn" pathology is pressure-specific.
//
// These tests pin both directions (#3617 gate discipline):
//   (A) pressure band HELD when the latest tool result FAILED (EMERGENCY);
//   (B) negative: a SUCCESS tool result tail does NOT hold (no over-suppress);
//   (C) negative: a plain text tail does NOT hold;
//   (D) the OVER-LIMIT band (not EMERGENCY) is held too;
//   (E) self-recovery: the held turn's successor (success tail) injects;
//   (F) the GROWTH band is unaffected by a failed tail (pressure-band-only).

function buildConfig(overrides: Partial<Config> = {}): Config {
  const base = {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.9,
      minContextLimitPct: 0.45,
      frequency: 1,
      iterationThreshold: 15,
      force: "soft" as const,
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
  return { ...base, ...overrides };
}

function textMessage(
  role: CoreMessage["role"],
  id: string,
  text: string,
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolCallMessage(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    text: "",
    toolName: "bash",
    toolCallId: "call_1",
  };
}

function toolResultMessage(id: string, isError: boolean): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    text: isError ? "command failed: exit 1" : "ok",
    toolCallId: "call_1",
    toolIsError: isError,
  };
}

// 8 text messages (≈ 44k T1 pending, well above the default minPressureBenefit
// of 5000) + a final tool call/result pair. The LAST message is the result —
// failed, success, or a plain text tail — so the nudge decision sees each shape.
function makeMessages(tail: "failed" | "success" | "text"): CoreMessage[] {
  const msgs = Array.from({ length: 8 }, (_, i) =>
    textMessage(i % 2 === 0 ? "user" : "assistant", `m${i}`, `message ${i} `.repeat(2000)),
  );
  if (tail === "text") {
    msgs.push(textMessage("assistant", "m8", "message 8 ".repeat(2000)));
    msgs.push(textMessage("user", "m9", "message 9 ".repeat(2000)));
  } else {
    msgs.push(toolCallMessage("m8"));
    msgs.push(toolResultMessage("m9", tail === "failed"));
  }
  return msgs;
}

test("#6762 (A): pressure band HELD when the latest tool result FAILED (EMERGENCY)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages("failed");
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(turn.nudge.breakdown.emergencyOverride, 1, "99% >= 98% → emergency band");
  assert.equal(turn.nudge.breakdown.toolFailureHold, 1, "failed tail arms the hold");
  assert.equal(
    turn.nudge.shouldInject,
    false,
    `held despite pending >= floor: ${turn.nudge.reason}`,
  );
  assert.match(turn.nudge.reason, /^EMERGENCY:/);
  assert.match(turn.nudge.reason, /latest tool result FAILED/);
  assert.match(turn.nudge.reason, /re-arms on the next turn/);
});

test("#6762 (B): negative — a SUCCESS tool result tail does NOT hold", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages("success");
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(turn.nudge.breakdown.emergencyOverride, 1);
  assert.equal(turn.nudge.breakdown.toolFailureHold, 0, "success tail does not arm the hold");
  assert.equal(
    turn.nudge.shouldInject,
    true,
    `injects on a success tail: ${turn.nudge.reason}`,
  );
  assert.match(turn.nudge.reason, /^EMERGENCY/);
  assert.doesNotMatch(turn.nudge.reason, /FAILED/);
});

test("#6762 (C): negative — a plain text tail does NOT hold", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages("text");
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(turn.nudge.breakdown.emergencyOverride, 1);
  assert.equal(turn.nudge.breakdown.toolFailureHold, 0, "text tail does not arm the hold");
  assert.equal(turn.nudge.shouldInject, true, `injects on a text tail: ${turn.nudge.reason}`);
});

test("#6762 (D): the OVER-LIMIT band (not EMERGENCY) is held too", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages("failed");
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 10000 }).state;
  // 95% usage: >= maxContextLimitPct (90%) but < emergencyThresholdPct (98%).
  const turn = core.processTurn({ messages, state, config, tokenCount: 95000 });
  assert.equal(turn.nudge.breakdown.overLimit, 1, "95% >= 90% → over-limit band");
  assert.equal(turn.nudge.breakdown.emergencyOverride, 0, "below emergency threshold");
  assert.equal(turn.nudge.breakdown.toolFailureHold, 1, "failed tail arms the hold");
  assert.equal(turn.nudge.shouldInject, false, `held in the over-limit band: ${turn.nudge.reason}`);
  assert.match(turn.nudge.reason, /^OVER-LIMIT:/);
  assert.match(turn.nudge.reason, /latest tool result FAILED/);
});

test("#6762 (E): self-recovery — the held turn's successor (success tail) injects", () => {
  const core = createCore();
  const config = buildConfig();
  // Turn 1: failed tail at high usage → held.
  let state = createInitialState();
  const failed = makeMessages("failed");
  state = core.processTurn({ messages: failed, state, config, tokenCount: 10000 }).state;
  const held = core.processTurn({ messages: failed, state, config, tokenCount: 99000 });
  assert.equal(held.nudge.shouldInject, false, `turn 1 held: ${held.nudge.reason}`);
  assert.equal(held.nudge.breakdown.toolFailureHold, 1);

  // Turn 2: the model handled the failure — the tail is now a SUCCESS result.
  // Same high usage; the hold is off, so the pressure band injects.
  const success = makeMessages("success");
  const next = core.processTurn({ messages: success, state: held.state, config, tokenCount: 99000 });
  assert.equal(next.nudge.breakdown.toolFailureHold, 0, "success tail clears the hold");
  assert.equal(
    next.nudge.shouldInject,
    true,
    `turn 2 re-arms: ${next.nudge.reason}`,
  );
});

test("#6762 (F): the GROWTH band is unaffected by a failed tail (pressure-band-only)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages("failed");
  let state = createInitialState();
  // Turn 1: stamp the baseline at LOW usage (20% < 90% maxContextLimitPct) —
  // no pressure.
  state = core.processTurn({ messages, state, config, tokenCount: 20000 }).state;
  // Turn 2: growth 10k >= floor 5k at 30% usage (still below pressure). The
  // growth leg fires T1 even though the tail is a failed tool result — the
  // hold is pressure-band-only.
  const turn = core.processTurn({ messages, state, config, tokenCount: 30000 });
  assert.equal(turn.nudge.breakdown.overLimit, 0, "30% < 90% → no pressure band");
  assert.equal(turn.nudge.breakdown.toolFailureHold, 0, "no pressure → no hold");
  assert.equal(
    turn.nudge.shouldInject,
    true,
    `growth band fires despite the failed tail: ${turn.nudge.reason}`,
  );
  assert.equal(turn.nudge.tier, 1, `T1 growth: ${turn.nudge.reason}`);
});
