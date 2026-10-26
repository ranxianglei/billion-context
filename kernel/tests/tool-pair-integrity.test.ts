import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { summaryMessageId } from "../src/prune.js";
import type { CoreMessage } from "../src/types.js";

function user(id: string, text = "u"): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "text",
    text: `${text}-${id} ` + "x".repeat(200),
  };
}
function toolCall(id: string, callId: string, toolName = "read"): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: `call-${callId}`,
  };
}
function toolResult(
  id: string,
  callId: string,
  toolName = "read",
): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "tool-result",
    toolName,
    toolCallId: callId,
    text: `result-${callId} ` + "r".repeat(200),
  };
}

const config = (over: Record<string, unknown> = {}) => ({
  ...defaultConfig(150000),
  compress: {
    ...defaultConfig(150000).compress,
    minCompressRange: 1,
    minSummaryLength: 1,
    ...over,
  },
});

/**
 * The shape a strict upstream validates, derived from the provider's own
 * rejection text ("an assistant message with 'tool_calls' must be followed by
 * tool messages responding to each 'tool_call_id'"): every tool call must be
 * answered by tool results before any other message follows. Returns the
 * unanswered call ids.
 */
function unansweredToolCalls(rendered: CoreMessage[]): string[] {
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
  for (const m of rendered) {
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

function reasoning(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "reasoning",
    text: `think-${id} ` + "t".repeat(200),
  };
}
function assistantText(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "text",
    text: `say-${id} ` + "s".repeat(200),
  };
}

const SUMMARY_ID_PREFIX = "acp_summary_";

/**
 * A rendered summary placed between two assistant cores splits one assistant
 * wire message: consecutive assistant cores (reasoning, text, tool calls)
 * merge into a single message, so the calls would reach a strict-echo provider
 * without the reasoning run they were produced with ("The `reasoning_content`
 * in the thinking mode must be passed back to the API").
 */
function splitsAssistantRun(rendered: CoreMessage[]): boolean {
  return rendered.some((m, at) => {
    if (!m.id.startsWith(SUMMARY_ID_PREFIX)) return false;
    return (
      rendered[at - 1]?.role === "assistant" &&
      rendered[at + 1]?.role === "assistant"
    );
  });
}

describe("tool-pair integrity", () => {
  it("keeps the summary out of a parallel burst's call/result span", () => {
    const core = createCore();
    const messages: CoreMessage[] = [
      user("m1"),
      toolCall("m2", "c-grep", "grep"),
      toolCall("m3", "c-read", "read"),
      toolResult("m4", "c-read", "read"),
      toolResult("m5", "c-grep", "grep"),
      user("m6"),
    ];
    const out = core.processTurn({
      messages,
      state: createInitialState(),
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    const res = core.applyCompression({
      state: out.state,
      messages,
      config: config(),
      protectedMessageIds: new Set(),
      ranges: [
        { startRef: "m00003", endRef: "m00004", summary: "S".repeat(400) },
      ],
    });
    assert.equal(
      res.result.blocksCreated,
      1,
      `errors=${JSON.stringify(res.result.errors)}`,
    );
    const block = res.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.deepEqual(
      [...block.effectiveMessageIds].sort(),
      ["m3", "m4"],
      "the read pair folds",
    );

    const view = core.processTurn({
      messages,
      state: res.state,
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    const viewIds = view.messages.map((m) => m.id);
    const summaryIndex = viewIds.indexOf(summaryMessageId(block.blockId));
    const grepCallIndex = viewIds.indexOf("m2");
    const grepResultIndex = viewIds.indexOf("m5");
    assert.ok(
      grepCallIndex >= 0,
      `surviving grep call kept: ${JSON.stringify(viewIds)}`,
    );
    assert.ok(
      grepResultIndex >= 0,
      `surviving grep result kept: ${JSON.stringify(viewIds)}`,
    );
    assert.ok(
      !(summaryIndex > grepCallIndex && summaryIndex < grepResultIndex),
      `summary must not land inside the surviving call/result span: ${JSON.stringify(viewIds)}`,
    );
    assert.ok(
      !splitsAssistantRun(view.messages),
      `summary must not split an assistant message: ${JSON.stringify(viewIds)}`,
    );
    assert.deepEqual(unansweredToolCalls(view.messages), []);
  });

  it("refuses a range whose only foldable half of a pair is the call", () => {
    const core = createCore();
    const messages: CoreMessage[] = [
      user("m1"),
      toolCall("m2", "c-a", "read"),
      toolResult("m3", "c-a", "read"),
      user("m4"),
      user("m5"),
    ];
    const out = core.processTurn({
      messages,
      state: createInitialState(),
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    const refs = out.state.messageRefs.byRaw;
    const res = core.applyCompression({
      state: out.state,
      messages,
      config: config(),
      protectedMessageIds: new Set([refs["m3"]!]),
      ranges: [
        { startRef: "m00002", endRef: "m00003", summary: "S".repeat(400) },
      ],
    });
    assert.equal(res.result.blocksCreated, 0);
    assert.equal(res.result.errors.length, 1);
    assert.match(res.result.errors[0]!, /split 1 tool call\/result pair/);
  });

  it("withdraws the call and warns when the range also carries other messages", () => {
    const core = createCore();
    const messages: CoreMessage[] = [
      user("m1"),
      toolCall("m2", "c-a", "read"),
      toolResult("m3", "c-a", "read"),
      user("m4"),
      user("m5"),
      user("m6"),
    ];
    const out = core.processTurn({
      messages,
      state: createInitialState(),
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    const refs = out.state.messageRefs.byRaw;
    const res = core.applyCompression({
      state: out.state,
      messages,
      config: config(),
      protectedMessageIds: new Set([refs["m3"]!]),
      ranges: [
        { startRef: "m00002", endRef: "m00004", summary: "S".repeat(400) },
      ],
    });
    assert.equal(
      res.result.blocksCreated,
      1,
      `errors=${JSON.stringify(res.result.errors)}`,
    );
    assert.ok(
      res.result.warnings.some((w) => /tool call\/result pair/.test(w)),
      JSON.stringify(res.result.warnings),
    );
    const block = res.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.ok(
      !block.effectiveMessageIds.includes("m2"),
      "the unanswerable call must not fold",
    );
    const view = core.processTurn({
      messages,
      state: res.state,
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    const visible = new Set(view.messages.map((m) => m.id));
    assert.ok(
      visible.has("m2") && visible.has("m3"),
      `pair stays visible: ${JSON.stringify([...visible])}`,
    );
    assert.deepEqual(unansweredToolCalls(view.messages), []);
  });

  it("keeps the summary out of an assistant turn's reasoning run", () => {
    const core = createCore();
    // One turn, five parallel calls, results in completion order — the shape
    // omp produces. The fold covers the two read pairs and leaves the grep
    // pair visible, so the summary anchor lands inside the turn.
    const messages: CoreMessage[] = [
      user("m1"),
      reasoning("m2"),
      assistantText("m3"),
      toolCall("m4", "c-r1", "read"),
      toolCall("m5", "c-g", "grep"),
      toolCall("m6", "c-r2", "read"),
      toolResult("m7", "c-r1", "read"),
      toolResult("m8", "c-r2", "read"),
      toolResult("m9", "c-g", "grep"),
      user("m10"),
    ];
    const out = core.processTurn({
      messages,
      state: createInitialState(),
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    const refs = out.state.messageRefs.byRaw;
    const res = core.applyCompression({
      state: out.state,
      messages,
      config: config(),
      protectedMessageIds: new Set([refs["m5"]!, refs["m9"]!]),
      ranges: [
        { startRef: "m00004", endRef: "m00009", summary: "S".repeat(400) },
      ],
    });
    assert.equal(
      res.result.blocksCreated,
      1,
      `errors=${JSON.stringify(res.result.errors)}`,
    );
    const block = res.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.deepEqual(
      [...block.effectiveMessageIds].sort(),
      ["m4", "m6", "m7", "m8"],
      "the read pairs fold, the protected grep pair stays",
    );

    const view = core.processTurn({
      messages,
      state: res.state,
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    const viewIds = view.messages.map((m) => m.id);
    const summaryIndex = viewIds.indexOf(summaryMessageId(block.blockId));
    assert.ok(
      summaryIndex >= 0,
      `summary rendered: ${JSON.stringify(viewIds)}`,
    );
    assert.ok(
      summaryIndex < viewIds.indexOf("m2"),
      `summary must precede the turn it starts inside of: ${JSON.stringify(viewIds)}`,
    );
    assert.ok(
      !splitsAssistantRun(view.messages),
      `summary must not split an assistant message: ${JSON.stringify(viewIds)}`,
    );
    assert.deepEqual(unansweredToolCalls(view.messages), []);
  });
});
