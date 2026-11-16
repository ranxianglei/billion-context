import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCore, createInitialState, defaultConfig, prune } from "../src/index.js";
import type { CoreMessage } from "../src/types.js";

describe("preserveFirstUser option in prune and processTurn", () => {
  const mkMsgs = (): CoreMessage[] => [
    { id: "u0", role: "user", contentType: "text", text: "opening task u0", ledgerSeq: 0 },
    { id: "a0", role: "assistant", contentType: "text", text: "reply a0", ledgerSeq: 1 },
    { id: "u1", role: "user", contentType: "text", text: "follow-up u1", ledgerSeq: 2 },
    { id: "a1", role: "assistant", contentType: "text", text: "reply a1", ledgerSeq: 3 },
  ];

  it("pins covered first user message by default (#2733)", () => {
    const state = createInitialState();
    state.blocks.push({
      blockId: "b1",
      runId: "r1",
      tier: 1,
      active: true,
      startRef: "m00001",
      endRef: "m00002",
      directMessageIds: ["u0", "a0"],
      directBlockIds: [],
      effectiveMessageIds: ["u0", "a0"],
      summary: "Summary b1",
      compressedTokens: 50,
      survivedCount: 0,
      generation: "young",
      createdAt: 1,
    });

    const out = prune(mkMsgs(), state);
    assert.equal(out.some((m) => m.id === "u0"), true);
    assert.equal(out.some((m) => m.id === "a0"), false);
  });

  it("drops covered first user when preserveFirstUser is false and a later uncovered user survives", () => {
    const state = createInitialState();
    state.blocks.push({
      blockId: "b1",
      runId: "r1",
      tier: 1,
      active: true,
      startRef: "m00001",
      endRef: "m00002",
      directMessageIds: ["u0", "a0"],
      directBlockIds: [],
      effectiveMessageIds: ["u0", "a0"],
      summary: "Summary b1",
      compressedTokens: 50,
      survivedCount: 0,
      generation: "young",
      createdAt: 1,
    });

    const out = prune(mkMsgs(), state, { preserveFirstUser: false });
    assert.equal(out.some((m) => m.id === "u0"), false);
    assert.equal(out.some((m) => m.id === "u1"), true);
    assert.equal(out.some((m) => m.id === "acp_summary_b1"), true);
  });

  it("respects seq-interval coverage when checking hasUncoveredUser under preserveFirstUser: false", () => {
    const state = createInitialState();
    state.blocks.push({
      blockId: "b1",
      runId: "r1",
      tier: 1,
      active: true,
      startRef: "m00001",
      endRef: "m00002",
      startSeq: 0,
      endSeq: 3,
      directMessageIds: ["old-u0", "old-a0"],
      directBlockIds: [],
      effectiveMessageIds: ["old-u0", "old-a0"],
      summary: "Summary covering all seq 0..3",
      compressedTokens: 50,
      survivedCount: 0,
      generation: "young",
      createdAt: 1,
    });

    // All users (u0 at seq 0, u1 at seq 2) are covered by seq interval 0..3,
    // so dynamic prune must fall back to pinning u0.
    const out = prune(mkMsgs(), state, { preserveFirstUser: false });
    assert.equal(out[0]?.id, "u0");
  });

  it("threads config.preserveFirstUser through processTurn pruneNode", () => {
    const core = createCore();
    const state = createInitialState();
    state.blocks.push({
      blockId: "b1",
      runId: "r1",
      tier: 1,
      active: true,
      startRef: "m00001",
      endRef: "m00002",
      directMessageIds: ["u0", "a0"],
      directBlockIds: [],
      effectiveMessageIds: ["u0", "a0"],
      summary: "Summary b1",
      compressedTokens: 50,
      survivedCount: 0,
      generation: "young",
      createdAt: 1,
    });
    const cfg = defaultConfig(200_000, {
      preserveFirstUser: false,
      preserveRecentMessages: 2,
      preserveRecentTokens: 100,
    });
    const turn = core.processTurn({ messages: mkMsgs(), state, config: cfg, tokenCount: 5_000 });
    assert.equal(turn.messages.some((m) => m.id === "u0"), false);
    assert.equal(turn.messages.some((m) => m.id === "u1"), true);
  });
});
