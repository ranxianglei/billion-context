import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { remintCoveredLiveIds } from "../src/instance-reid.js";
import { prune } from "../src/prune.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

const R_HASH = "h_1111111111111111";
const A_HASH = "h_2222222222222222";
const U_OPEN = "h_0000000000000000";
const U_LIVE = "h_3333333333333333";
const A_LIVE = "h_4444444444444444";

function msg(
  id: string,
  role: CoreMessage["role"],
  contentType: CoreMessage["contentType"],
  text: string,
  extra: Partial<CoreMessage> = {},
): CoreMessage {
  return { id, role, contentType, text, ...extra };
}

function folded(ids: string[]): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "folded summary",
    directMessageIds: ids,
    effectiveMessageIds: ids,
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
  };
}

describe("covered reasoning host-drop/restore leak", () => {
  it("does not remint or leak covered reasoning when host omits thinking for one turn and restores it next turn", () => {
    const core = createCore();
    const state = createInitialState();
    state.blocks.push(folded([R_HASH, A_HASH]));
    const cfg = defaultConfig(100_000);

    const open = msg(U_OPEN, "user", "text", "open");
    const rFolded = msg(R_HASH, "assistant", "reasoning", "folded thinking", {
      wireIndex: 1,
    });
    const aFolded = msg(A_HASH, "assistant", "text", "folded answer", {
      wireIndex: 1,
    });
    const summary = msg("acp_summary_b1", "system", "text", "[Compressed conversation section] …");
    const uLive = msg(U_LIVE, "user", "text", "live follow-up", { wireIndex: 2 });
    const aLive = msg(A_LIVE, "assistant", "text", "live assistant", { wireIndex: 3 });

    const passA = core.processTurn({
      messages: [open, aFolded, aLive, uLive],
      state,
      config: cfg,
      tokenCount: 200,
    });
    assert.ok(!passA.messages.some((m) => m.id.startsWith(A_HASH)));

    const passB = core.processTurn({
      messages: [open, rFolded, aFolded, aLive, uLive],
      state: passA.state,
      config: cfg,
      tokenCount: 200,
    });
    const ids = passB.messages.map((m) => m.id);
    assert.ok(
      !ids.some((id) => id.startsWith(R_HASH)),
      `covered reasoning must not leak back onto wire (got ${JSON.stringify(ids)})`,
    );
    assert.ok(
      !ids.some((id) => id.startsWith(A_HASH)),
      `covered companion must stay pruned (got ${JSON.stringify(ids)})`,
    );
    assert.ok(ids.includes(A_LIVE), "uncovered assistant stays intact");
  });

  it("does not remint folded reasoning whose companion is covered and already in prior pass", () => {
    const state = createInitialState();
    state.blocks.push(folded([R_HASH, A_HASH]));
    state.lastPassIds = [U_OPEN, A_HASH, U_LIVE];

    const rFolded = msg(R_HASH, "assistant", "reasoning", "folded thinking", {
      wireIndex: 1,
    });
    const aFolded = msg(A_HASH, "assistant", "text", "folded answer", {
      wireIndex: 1,
    });
    const out = remintCoveredLiveIds(
      [msg(U_OPEN, "user", "text", "open"), rFolded, aFolded, msg(U_LIVE, "user", "text", "next")],
      state,
    );
    assert.equal(out[1]!.id, R_HASH);
  });

  it("still remints a genuine duplicate assistant turn when both reasoning and companion are absent from prior", () => {
    const state = createInitialState();
    state.blocks.push(folded([R_HASH, A_HASH]));
    state.lastPassIds = [U_OPEN, U_LIVE];

    const out = remintCoveredLiveIds(
      [
        msg(U_OPEN, "user", "text", "open"),
        msg(R_HASH, "assistant", "reasoning", "folded thinking"),
        msg(A_HASH, "assistant", "text", "folded answer"),
      ],
      state,
    );
    assert.equal(out[1]!.id, `${R_HASH}_1`);
    assert.equal(out[2]!.id, `${A_HASH}_1`);
  });

  it("still remints colliding reasoning when its companion is uncovered", () => {
    const state = createInitialState();
    state.blocks.push(folded([R_HASH, A_HASH]));
    state.lastPassIds = [U_OPEN, U_LIVE];

    const out = remintCoveredLiveIds(
      [
        msg(U_OPEN, "user", "text", "open"),
        msg(R_HASH, "assistant", "reasoning", "generic thinking"),
        msg(A_LIVE, "assistant", "text", "new uncovered answer"),
      ],
      state,
    );
    assert.equal(out[1]!.id, `${R_HASH}_1`);
  });

  it("stripOrphanedReasoning does not glue surviving reasoning onto an unrelated later assistant across pruned messages", () => {
    const state = createInitialState();
    state.blocks.push(folded(["a1", "u1"]));

    const messages: CoreMessage[] = [
      msg("u0", "user", "text", "open"),
      msg("r1", "assistant", "reasoning", "old thinking from folded turn", {
        wireIndex: 1,
      }),
      msg("a1", "assistant", "text", "old covered answer", { wireIndex: 1 }),
      msg("u1", "user", "text", "covered follow-up", { wireIndex: 2 }),
      msg("r2", "assistant", "reasoning", "live thinking", { wireIndex: 3 }),
      msg("a2", "assistant", "tool-call", "live call", {
        wireIndex: 3,
        toolName: "read",
        toolCallId: "tc_live",
      }),
      msg("tr2", "user", "tool-result", "result", {
        wireIndex: 4,
        toolName: "read",
        toolCallId: "tc_live",
      }),
    ];

    const pruned = prune(messages, state);
    const ids = pruned.map((m) => m.id);
    assert.ok(!ids.includes("r1"), `straddled r1 must be stripped (got ${JSON.stringify(ids)})`);
    assert.ok(ids.includes("r2"), "live r2 stays paired with a2");
    assert.ok(ids.includes("a2"), "live a2 stays intact");
  });

  it("stripOrphanedReasoning strips straddled reasoning even when the next live turn has no reasoning of its own", () => {
    const state = createInitialState();
    state.blocks.push(folded(["a1", "u1"]));

    const messages: CoreMessage[] = [
      msg("u0", "user", "text", "open"),
      msg("r1", "assistant", "reasoning", "old thinking from folded turn"),
      msg("a1", "assistant", "text", "old covered answer"),
      msg("u1", "user", "text", "covered follow-up"),
      msg("a2", "assistant", "text", "live answer without thinking"),
    ];

    const pruned = prune(messages, state);
    const ids = pruned.map((m) => m.id);
    assert.ok(!ids.includes("r1"), `straddled r1 must not attach to a2 (got ${JSON.stringify(ids)})`);
    assert.ok(ids.includes("a2"), "live a2 stays intact");
  });
});
