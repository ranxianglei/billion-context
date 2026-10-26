import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createCore, defaultConfig } from "../src/index.js";
import { SUMMARY_HEADER, prune, summaryMessageId } from "../src/prune.js";
import {
  buildCompressibleRanges,
  computeProtectedRefs,
} from "../src/recommend.js";
import { coveredMessageIds, createInitialState } from "../src/state.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

// #498: prune/recommend rescanned the whole history per anchor / per message,
// adding hundreds of ms to ordinary requests in large sessions. These tests
// pin the pairing semantics the rewrite depends on (exact placement outcomes)
// and prove the hot paths stay correct — and finish in sane wall time — at
// the scale where the old algorithms degraded.

const LOOSE_WALL_MS = 10_000;

function user(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: `u-${id}` };
}
function reasoning(id: string): CoreMessage {
  return { id, role: "assistant", contentType: "reasoning", text: `r-${id}` };
}
function toolCall(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName: "read",
    toolCallId: callId,
    text: "{}",
  };
}
function toolResult(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName: "read",
    toolCallId: callId,
    text: `result-${callId}`,
  };
}

function block(
  id: number,
  effectiveMessageIds: string[],
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    blockId: `b${id}`,
    runId: `r${id}`,
    tier: 1,
    summary: `Summary ${id}`,
    directMessageIds: effectiveMessageIds,
    effectiveMessageIds,
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: 0,
    survivedCount: 1,
    generation: "old",
    active: true,
    ...overrides,
  };
}

/** Ids of tool calls never answered before the next non-tool message. */
function unansweredToolCalls(messages: CoreMessage[]): string[] {
  const violations: string[] = [];
  let calls: string[] = [];
  let answers: string[] = [];
  const flush = () => {
    for (const callId of calls) {
      if (!answers.includes(callId)) violations.push(callId);
    }
    calls = [];
    answers = [];
  };
  for (const m of messages) {
    if (m.contentType === "reasoning") continue;
    if (m.contentType === "tool-call" && typeof m.toolCallId === "string") {
      calls.push(m.toolCallId);
      continue;
    }
    if (m.contentType === "tool-result" && typeof m.toolCallId === "string") {
      answers.push(m.toolCallId);
      continue;
    }
    flush();
  }
  flush();
  return violations;
}

describe("prune anchor pairing — exact placement (#498)", () => {
  it("moves a multi-step chain: crossing one result exposes a farther call", () => {
    // Anchor at index 2 must move 2 → 5 (past ta's result) → 7 (past tb's
    // result, whose call sits between the original anchor and the first move).
    const messages: CoreMessage[] = [
      user("u0"),
      toolCall("c1", "ta"),
      user("u2"),
      toolCall("c3", "tb"),
      toolResult("o4", "ta"),
      user("u5"),
      toolResult("o6", "tb"),
      user("u7"),
    ];
    const state = createInitialState();
    state.blocks.push(block(1, ["u2"]));
    const out = prune(messages, state);
    assert.deepEqual(
      out.map((m) => m.id),
      ["u0", "c1", "c3", "o4", "u5", "o6", "acp_summary_b1", "u7"],
    );
  });

  it("uses the earliest result when a call id appears on multiple results", () => {
    const messages: CoreMessage[] = [
      user("u0"),
      toolCall("c1", "td"),
      toolResult("o2", "td"),
      toolResult("o3", "td"),
      user("u4"),
    ];
    const state = createInitialState();
    state.blocks.push(block(1, ["o2"]));
    const out = prune(messages, state);
    assert.deepEqual(
      out.map((m) => m.id),
      ["u0", "c1", "acp_summary_b1", "o3", "u4"],
    );
  });

  it("does not move past an unmatched tool call (orphaned call is stripped)", () => {
    const messages: CoreMessage[] = [
      user("u0"),
      toolCall("c1", "tx"),
      user("u2"),
    ];
    const state = createInitialState();
    state.blocks.push(block(1, ["u2"]));
    const out = prune(messages, state);
    // c1 has no result anywhere, so stripOrphanedToolCalls drops it; the
    // anchor must not have moved past a nonexistent result.
    assert.deepEqual(
      out.map((m) => m.id),
      ["u0", "acp_summary_b1"],
    );
  });

  it("snaps back to the assistant run start, then crosses the burst", () => {
    const messages: CoreMessage[] = [
      user("u0"),
      reasoning("r1"),
      toolCall("c2", "t1"),
      toolCall("c3", "t2"),
      toolResult("o4", "t1"),
      toolResult("o5", "t2"),
    ];
    const state = createInitialState();
    state.blocks.push(block(1, ["r1"]));
    const out = prune(messages, state);
    assert.deepEqual(
      out.map((m) => m.id),
      ["u0", "acp_summary_b1", "c2", "c3", "o4", "o5"],
    );
  });
});

describe("large-session scale (#498)", () => {
  // The issue's synthetic shape: 7250 reasoning/call/result triples under
  // 132 active tier-1 blocks.
  function buildSession() {
    const messages: CoreMessage[] = [user("m0")];
    for (let i = 0; i < 7250; i++) {
      messages.push(reasoning(`r${i}`));
      messages.push(toolCall(`c${i}`, `t${i}`));
      messages.push({
        ...toolResult(`o${i}`, `t${i}`),
        text: "x".repeat(1200),
      });
    }
    const state = createInitialState();
    messages.forEach((m, i) => {
      const ref = `m${String(i + 1).padStart(5, "0")}`;
      state.messageRefs.byRaw[m.id] = ref;
      state.messageRefs.byRef[ref] = m.id;
    });
    state.lastPassIds = messages.map((m) => m.id);
    for (let i = 0; i < 132; i++) {
      const ids = messages
        .slice(1 + i * 162, 1 + (i + 1) * 162)
        .map((m) => m.id);
      state.blocks.push(block(i + 1, ids));
    }
    state.nextBlockId = 133;
    state.nextRunId = 133;
    return { messages, state };
  }

  it("processTurn stays correct and fast at 21k messages / 132 blocks", () => {
    const { messages, state } = buildSession();
    const core = createCore();
    const config = defaultConfig(212992);
    const start = performance.now();
    const out = core.processTurn({
      messages,
      state: structuredClone(state),
      config,
      tokenCount: 148265,
      renderTags: "text-only",
    });
    const elapsed = performance.now() - start;

    assert.equal(out.messages.length, 499, "issue-repro pinned output length");
    const ids = out.messages.map((m) => m.id);
    for (let i = 1; i <= 132; i++) {
      assert.equal(
        ids.filter((id) => id === summaryMessageId(`b${i}`)).length,
        1,
        `exactly one rendered ${summaryMessageId(`b${i}`)}`,
      );
    }
    const first = ids.indexOf(summaryMessageId("b1"));
    const last = ids.lastIndexOf(summaryMessageId("b132"));
    assert.ok(first >= 0 && last > first, "summaries keep block order");
    assert.deepEqual(unansweredToolCalls(out.messages), []);
    assert.ok(elapsed < LOOSE_WALL_MS, `processTurn took ${elapsed}ms`);

    // Re-feeding the pruned view must be stable at the structure level:
    // summaries stay in place, nothing duplicates or drops. (Byte-identity of
    // summary text does not hold across passes — render-refs tags the summary
    // on re-feed and prune re-renders it; pre-existing, version-stable.)
    const again = core.processTurn({
      messages: structuredClone(out.messages),
      state: structuredClone(out.state),
      config,
      tokenCount: 148265,
      renderTags: "text-only",
    });
    assert.equal(again.messages.length, out.messages.length);
    assert.deepEqual(
      again.messages.map((m) => m.id),
      out.messages.map((m) => m.id),
    );
  });

  it("recommend paths stay correct and fast at scale", () => {
    const { messages, state } = buildSession();
    const config = defaultConfig(212992);
    const start = performance.now();
    const protectedRefs = computeProtectedRefs(messages, state, config);
    const ranges = buildCompressibleRanges(
      messages,
      state,
      config,
      protectedRefs,
    );
    const elapsed = performance.now() - start;

    const covered = coveredMessageIds(state);
    for (const range of ranges.compressible) {
      for (let i = range.startIndex; i <= range.endIndex; i++) {
        const id = messages[i]!.id;
        assert.ok(
          !covered.has(id),
          `covered message ${id} leaked into a compressible range`,
        );
      }
    }
    for (const ref of protectedRefs) {
      assert.match(ref, /^m\d{5}$/);
    }
    assert.ok(ranges.compressible.length > 0, "session still has open ranges");
    assert.ok(elapsed < LOOSE_WALL_MS, `recommend took ${elapsed}ms`);
  });
});

describe("covered-set exact-id semantics (#498)", () => {
  it("only ACTIVE blocks exclude messages from recommendations", () => {
    const messages: CoreMessage[] = [
      user("a"),
      user("b"),
      user("c"),
      user("d"),
    ];
    const state = createInitialState();
    messages.forEach((m, i) => {
      const ref = `m${String(i + 1).padStart(5, "0")}`;
      state.messageRefs.byRaw[m.id] = ref;
      state.messageRefs.byRef[ref] = m.id;
    });
    state.lastPassIds = messages.map((m) => m.id);
    state.blocks.push(block(1, ["a"]));
    state.blocks.push(block(2, ["b"], { active: false }));
    const config = {
      ...defaultConfig(200000),
      preserveRecentMessages: 0,
      preserveRecentTokens: 0,
    };
    const ranges = buildCompressibleRanges(
      messages,
      state,
      config,
      computeProtectedRefs(messages, state, config),
    );
    const listed = ranges.compressible.flatMap((r) => r.startRef);
    assert.ok(!listed.includes("m00001"), "active-covered message excluded");
    assert.ok(listed.includes("m00002"), "inactive-covered message stays");
  });

  it("synthetic summary text is treated as pruned regardless of coverage", () => {
    const messages: CoreMessage[] = [
      user("a"),
      {
        id: "sum",
        role: "user",
        contentType: "text",
        text: `${SUMMARY_HEADER} — leftover`,
      },
      user("c"),
    ];
    const state = createInitialState();
    messages.forEach((m, i) => {
      const ref = `m${String(i + 1).padStart(5, "0")}`;
      state.messageRefs.byRaw[m.id] = ref;
      state.messageRefs.byRef[ref] = m.id;
    });
    state.lastPassIds = messages.map((m) => m.id);
    const config = {
      ...defaultConfig(200000),
      preserveRecentMessages: 0,
      preserveRecentTokens: 0,
    };
    const ranges = buildCompressibleRanges(
      messages,
      state,
      config,
      computeProtectedRefs(messages, state, config),
    );
    const listed = ranges.compressible.flatMap((r) => r.startRef);
    assert.ok(!listed.includes("m00002"), "synthetic header excluded");
  });
});
