// #4521: long sessions died in compress retry livelocks — the model kept
// aiming at the newest tail (refs minted after the last banner delivery, or
// the protected zone itself) and every legal-looking call came back FAILED:
// endId above the highest allocated ref (whole batch refused), ranges already
// covered by a fold (livelock throw), ranges inside the protected zone
// (zone fatal). Live incident: session 01a18a4d, four consecutive refusals
// between 20:09:23 and 20:09:46 over ranges that were 100% legal targets for
// "compress what just happened". These tests pin the retry-livelock kills:
// (a) endId above highest CLAMPS to the highest visible message instead of
//     refusing (start anchors keep the hard refusal — that is a real
//     targeting error),
// (b) a range entirely inside the protected zone is an idempotent no-op
//     (errors empty, noop flagged, guidance in warnings),
// (c) a range whose every message is content-filtered (protected tool pairs)
//     is the same no-op class,
// (d) the armed-but-silent nudge window emits a status line naming the
//     highest allocated ref and the offered ranges, so the model stops
//     guessing refs it cannot see.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

const LIMIT = 872_000;

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.75,
      minContextLimitPct: 0.05,
      frequency: 1,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.06,
      growthFloor: 50_000,
      growthCap: 50_000,
      minGrowthFloor: 22_500,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 1 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: LIMIT,
    ...overrides,
  };
}

function text(id: string, role: CoreMessage["role"], len = 3000): CoreMessage {
  return { id, role, contentType: "text", text: "x".repeat(len) };
}

function toolCall(id: string, callId: string, toolName = "bash"): CoreMessage {
  return { id, role: "assistant", contentType: "tool-call", toolName, toolCallId: callId, text: `args-${callId}` };
}

function toolResult(id: string, callId: string, toolName = "bash", len = 3000): CoreMessage {
  return { id, role: "tool", contentType: "tool-result", toolName, toolCallId: callId, text: "x".repeat(len) };
}

function seed(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  return state;
}

test("#4521: endId above highest allocated ref clamps down instead of refusing the batch", () => {
  const core = createCore();
  const messages = [text("u0", "user"), text("a1", "assistant"), text("a2", "assistant"), text("a3", "assistant")];
  const state = seed(messages);

  const r = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00099", summary: "work recap" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(r.result.errors.length, 0, r.result.errors.join("; "));
  assert.equal(r.result.blocksCreated, 1);
  assert.ok(
    r.result.warnings.some((w) => /clamped to it/.test(w) && /highest allocated ref \(m00004\)/.test(w)),
    `expected clamp warning, got: ${JSON.stringify(r.result.warnings)}`,
  );
  const block = r.state.blocks.find((b) => b.active);
  assert.ok(block, "a block was created");
  assert.deepEqual(
    [...block.directMessageIds].sort(),
    ["a1", "a2", "a3"],
    "the range folded up to the last visible message",
  );
});

test("#4521: startId above highest allocated ref keeps the hard refusal (real targeting error)", () => {
  const core = createCore();
  const messages = [text("u0", "user"), text("a1", "assistant"), text("a2", "assistant")];
  const state = seed(messages);

  const r = core.applyCompression({
    ranges: [{ startRef: "m00099", endRef: "m00104", summary: "phantom work" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(r.result.blocksCreated, 0);
  assert.ok(r.result.errors.length > 0, "a start anchor beyond the frontier is a real error");
  assert.match(r.result.errors.join("; "), /above this session's highest allocated ref/);
  assert.doesNotMatch(r.result.errors.join("; "), /clamped/);
  assert.notEqual(r.result.noop, true, "not the no-op class — the guidance matters here");
});

test("#4521: a range entirely inside the protected zone is a no-op, not a batch failure", () => {
  const core = createCore();
  const messages = [text("u0", "user"), text("a1", "assistant"), text("a2", "assistant"), text("a3", "assistant")];
  const state = seed(messages);

  const r = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: "newest work" }],
    messages,
    state,
    config: config({ preserveRecentMessages: 4 }),
  });

  assert.equal(r.result.errors.length, 0, r.result.errors.join("; "));
  assert.equal(r.result.blocksCreated, 0);
  assert.equal(r.result.noop, true);
  assert.ok(
    r.result.warnings.some((w) => /protected zone/.test(w) && /do not resend this range/.test(w)),
    `expected zone no-op warning, got: ${JSON.stringify(r.result.warnings)}`,
  );
  assert.equal(r.state.blocks.length, 0, "nothing was folded");
});

test("#4521: a range of pure protected tool pairs is the same no-op class", () => {
  const core = createCore();
  const messages = [
    toolCall("c1", "call1"),
    toolResult("r1", "call1"),
    toolCall("c2", "call2"),
    toolResult("r2", "call2"),
  ];
  const state = seed(messages);

  const r = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: "tool work" }],
    messages,
    state,
    config: config({ protectedTools: ["bash"] }),
  });

  assert.equal(r.result.errors.length, 0, r.result.errors.join("; "));
  assert.equal(r.result.blocksCreated, 0);
  assert.equal(r.result.noop, true);
  assert.ok(
    r.result.warnings.some((w) => /protected or filtered/.test(w) && /do not resend this range/.test(w)),
    `expected filter no-op warning, got: ${JSON.stringify(r.result.warnings)}`,
  );
});

test("#4521: armed-but-silent nudge window emits a status line naming the highest ref and offered ranges", () => {
  const core = createCore();
  const cfg = config();
  const messages = Array.from({ length: 40 }, (_, i) =>
    text(`m${i}`, i % 2 === 0 ? "user" : "assistant", 24_000),
  );
  let state = createInitialState();

  // First turn injects via the first-sight mass bypass (240K pending ≥
  // threshold, no baseline yet) — the banner carries the refs.
  const warm = core.processTurn({ messages, state, config: cfg, tokenCount: 600_000 });
  assert.equal(warm.nudge?.shouldInject, true, "first-sight mass injects");
  assert.equal(warm.statusLine, undefined, "no status line beside a delivered banner");
  state = warm.state;

  // Next turn: growth 10K < 22.5K floor, usage 70% < 75% band → the round
  // stays armed (offered ranges exist) but the banner is withheld — the
  // window where refs used to go stale in the model's view and compress
  // calls guessed beyond the highest allocated ref.
  const idle = core.processTurn({ messages, state, config: cfg, tokenCount: 610_000 });
  assert.equal(idle.nudge?.shouldInject, false, `armed-but-silent window, got reason: ${idle.nudge?.reason}`);
  assert.ok((idle.nudge?.compressibleRanges?.length ?? 0) > 0, "plan carries offered ranges");
  assert.ok(idle.statusLine, "status line emitted in the armed-but-silent window");
  assert.match(idle.statusLine!, /highest allocated ref m00040/);
  assert.match(idle.statusLine!, /compressible now: m\d+–m\d+/);
  assert.match(idle.statusLine!, /never guess them/);
});
