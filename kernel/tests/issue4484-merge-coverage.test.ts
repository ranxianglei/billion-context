import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState, coveredMessageIds } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { computeIntegrityWithdrawals } from "../src/turn-integrity.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

// #4484: merging existing blocks must never drop their existing coverage. The
// turn-integrity gate used to withdraw ids carried only by consumed blocks,
// stranding them uncovered once those blocks deactivated (host then refused the
// fold via gate:coverage-regression). These fixtures mirror the two real trigger
// shapes (interior hard-protected tool; tail cut mid-tool-group); synthetic only.

const isToolProtected = (t?: string) =>
  t === "mcp__bili__acp_rule" || t === "mcp__bili__compress";
const isCompressTool = (t?: string) =>
  t === "mcp__bili__compress" || t === "compress";

const config = defaultConfig(255000, {
  preserveRecentMessages: 0,
  preserveRecentTokens: 0,
  isToolProtected,
  isCompressTool,
} as never);

const SUMMARY = "Synthetic summary for this compression test. ".repeat(4);
const LONG = "Synthetic historical content, safe for public reproduction. ".repeat(150);

function buildFixture(kind: "protected-rule" | "parallel-tail") {
  const core = createCore();
  const messages: CoreMessage[] = [
    { id: "old-user", role: "user", contentType: "text", text: LONG },
    { id: "old-assistant", role: "assistant", contentType: "text", text: "Previous work finished." },
    { id: "reasoning", role: "assistant", contentType: "reasoning", text: "Inspect the current state." },
    { id: "read-call", role: "assistant", contentType: "tool-call", toolName: "Read", toolCallId: "read-1", text: '{"path":"/tmp/example.txt"}' },
  ];
  let seedStartId: string;
  let seedEndId: string;
  let toolIds: string[];
  if (kind === "protected-rule") {
    messages.push(
      { id: "rule-call", role: "assistant", contentType: "tool-call", toolName: "mcp__bili__acp_rule", toolCallId: "rule-1", text: '{"operation":"list"}' },
      { id: "read-result", role: "tool", contentType: "tool-result", toolName: "Read", toolCallId: "read-1", text: LONG },
      { id: "rule-result", role: "tool", contentType: "tool-result", toolName: "mcp__bili__acp_rule", toolCallId: "rule-1", text: "No rules recorded." },
    );
    seedStartId = "read-call";
    seedEndId = "read-result";
    toolIds = ["read-call", "read-result"];
  } else {
    messages.push(
      { id: "bash-call", role: "assistant", contentType: "tool-call", toolName: "Bash", toolCallId: "bash-1", text: '{"command":"true"}' },
      { id: "todo-call", role: "assistant", contentType: "tool-call", toolName: "TodoList", toolCallId: "todo-1", text: '{"todos":[]}' },
      { id: "read-result", role: "tool", contentType: "tool-result", toolName: "Read", toolCallId: "read-1", text: LONG },
      { id: "bash-result", role: "tool", contentType: "tool-result", toolName: "Bash", toolCallId: "bash-1", text: LONG },
      { id: "todo-result", role: "tool", contentType: "tool-result", toolName: "TodoList", toolCallId: "todo-1", text: "Updated." },
    );
    seedStartId = "read-call";
    seedEndId = "bash-result";
    toolIds = ["read-call", "bash-call", "read-result", "bash-result"];
  }
  messages.push({ id: "new-user", role: "user", contentType: "text", text: "Continue." });

  const state = createInitialState();
  let nextRef = 1;
  for (const message of messages) {
    const ref = message.toolName === "mcp__bili__acp_rule" ? "BLOCKED" : `m${String(nextRef++).padStart(5, "0")}`;
    state.messageRefs.byRaw[message.id] = ref;
    if (ref !== "BLOCKED") state.messageRefs.byRef[ref] = message.id;
  }
  const seeded = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: state.messageRefs.byRaw["old-user"]!, endRef: state.messageRefs.byRaw["old-assistant"]!, summary: SUMMARY }],
  });
  if (seeded.result.blocksCreated !== 1 || seeded.result.errors.length !== 0) {
    throw new Error(`fixture seed failed: ${JSON.stringify(seeded.result)}`);
  }
  seeded.state.blocks.push({
    ...seeded.state.blocks[0]!,
    blockId: "b2",
    runId: "r2",
    directMessageIds: [...toolIds],
    effectiveMessageIds: [...toolIds],
    compressedTokens: toolIds.reduce((n, id) => n + Math.ceil(messages.find((m) => m.id === id)!.text.length / 4), 0),
    startRef: state.messageRefs.byRaw[seedStartId],
    endRef: state.messageRefs.byRaw[seedEndId],
  });
  seeded.state.nextBlockId = 3;
  seeded.state.nextRunId = 3;
  seeded.state.stats.compressionCount = 2;
  return { core, messages, state: seeded.state, toolIds };
}

function lostCoverage(before: Set<string>, state: CompressionState): string[] {
  const after = coveredMessageIds(state);
  return [...before].filter((id) => !after.has(id));
}

describe("#4484 merge preserves existing block coverage", () => {
  it("protected-rule interior: merging b1..b2 keeps the Read pair folded", () => {
    const { core, messages, state, toolIds } = buildFixture("protected-rule");
    const before = coveredMessageIds(state);
    const res = core.applyCompression({
      messages,
      state,
      config,
      ranges: [{ startRef: "b1", endRef: "b2", summary: SUMMARY }],
    });
    assert.equal(res.result.errors.length, 0, JSON.stringify(res.result.errors));
    assert.equal(res.result.blocksCreated, 1);
    const lost = lostCoverage(before, res.state);
    assert.deepEqual(lost, [], `regression: lost ${lost.join(", ")}`);
    const after = coveredMessageIds(res.state);
    for (const id of toolIds) assert.ok(after.has(id), `${id} must stay covered`);
    assert.equal(computeIntegrityWithdrawals(messages, after).withdrawn.size, 0);
  });

  it("parallel-tail cut: merging b1..b2 keeps both Read/Bash pairs folded", () => {
    const { core, messages, state, toolIds } = buildFixture("parallel-tail");
    const before = coveredMessageIds(state);
    const res = core.applyCompression({
      messages,
      state,
      config,
      ranges: [{ startRef: "b1", endRef: "b2", summary: SUMMARY }],
    });
    assert.equal(res.result.errors.length, 0, JSON.stringify(res.result.errors));
    assert.equal(res.result.blocksCreated, 1);
    const lost = lostCoverage(before, res.state);
    assert.deepEqual(lost, [], `regression: lost ${lost.join(", ")}`);
    const after = coveredMessageIds(res.state);
    for (const id of toolIds) assert.ok(after.has(id), `${id} must stay covered`);
    assert.equal(computeIntegrityWithdrawals(messages, after).withdrawn.size, 0);
  });

  it("impossible merge: fails fast up-front without touching existing coverage", () => {
    const core = createCore();
    const messages: CoreMessage[] = [
      { id: "old-user", role: "user", contentType: "text", text: LONG },
      { id: "old-assistant", role: "assistant", contentType: "text", text: "Previous work finished." },
      { id: "read-call", role: "assistant", contentType: "tool-call", toolName: "Read", toolCallId: "read-1", text: '{"path":"/tmp/example.txt"}' },
      { id: "read-result", role: "tool", contentType: "tool-result", toolName: "Read", toolCallId: "read-1", text: LONG },
      { id: "new-user", role: "user", contentType: "text", text: "Continue." },
    ];
    const state = createInitialState();
    let nextRef = 1;
    for (const m of messages) {
      const ref = `m${String(nextRef++).padStart(5, "0")}`;
      state.messageRefs.byRaw[m.id] = ref;
      state.messageRefs.byRef[ref] = m.id;
    }
    const seeded = core.applyCompression({
      messages,
      state,
      config,
      ranges: [{ startRef: state.messageRefs.byRaw["old-user"]!, endRef: state.messageRefs.byRaw["old-assistant"]!, summary: SUMMARY }],
    });
    if (seeded.result.blocksCreated !== 1 || seeded.result.errors.length !== 0) {
      throw new Error(`fixture seed failed: ${JSON.stringify(seeded.result)}`);
    }
    // b2 covers ONLY the call half of the Read pair — its tail cut mid-tool-group.
    // No consistent non-regressive candidate exists: folding the call splits its
    // pair, unfolding it strands a message whose only covering block is consumed.
    seeded.state.blocks.push({
      ...seeded.state.blocks[0]!,
      blockId: "b2",
      runId: "r2",
      directMessageIds: ["read-call"],
      effectiveMessageIds: ["read-call"],
      compressedTokens: 100,
      startRef: state.messageRefs.byRaw["read-call"]!,
      endRef: state.messageRefs.byRaw["read-call"]!,
    });
    seeded.state.nextBlockId = 3;
    seeded.state.nextRunId = 3;
    seeded.state.stats.compressionCount = 2;
    const before = coveredMessageIds(seeded.state);
    const res = core.applyCompression({
      messages,
      state: seeded.state,
      config,
      ranges: [{ startRef: "b1", endRef: "b2", summary: SUMMARY }],
    });
    assert.equal(res.result.errors.length, 1, JSON.stringify(res.result));
    assert.equal(res.result.blocksCreated, 0);
    assert.match(res.result.errors[0]!, /cannot satisfy turn integrity/);
    assert.deepEqual(lostCoverage(before, res.state), [], "state must stay untouched");
  });

  it("control: a clean merge (no split, no protected tool) loses nothing", () => {
    const core = createCore();
    const messages: CoreMessage[] = [
      { id: "old-user", role: "user", contentType: "text", text: LONG },
      { id: "old-assistant", role: "assistant", contentType: "text", text: "Previous work finished." },
      { id: "mid-user", role: "user", contentType: "text", text: LONG },
      { id: "mid-assistant", role: "assistant", contentType: "text", text: "More prior context." },
      { id: "new-user", role: "user", contentType: "text", text: "Continue." },
    ];
    const state = createInitialState();
    let nextRef = 1;
    for (const m of messages) {
      const ref = `m${String(nextRef++).padStart(5, "0")}`;
      state.messageRefs.byRaw[m.id] = ref;
      state.messageRefs.byRef[ref] = m.id;
    }
    const seeded = core.applyCompression({
      messages,
      state,
      config,
      ranges: [{ startRef: state.messageRefs.byRaw["old-user"]!, endRef: state.messageRefs.byRaw["old-assistant"]!, summary: SUMMARY }],
    });
    seeded.state.blocks.push({
      ...seeded.state.blocks[0]!,
      blockId: "b2",
      runId: "r2",
      directMessageIds: ["mid-user", "mid-assistant"],
      effectiveMessageIds: ["mid-user", "mid-assistant"],
      compressedTokens: 400,
      startRef: state.messageRefs.byRaw["mid-user"]!,
      endRef: state.messageRefs.byRaw["mid-assistant"]!,
    });
    seeded.state.nextBlockId = 3;
    seeded.state.nextRunId = 3;
    seeded.state.stats.compressionCount = 2;
    const before = coveredMessageIds(seeded.state);
    const res = core.applyCompression({
      messages,
      state: seeded.state,
      config,
      ranges: [{ startRef: "b1", endRef: "b2", summary: SUMMARY }],
    });
    assert.equal(res.result.errors.length, 0, JSON.stringify(res.result.errors));
    assert.equal(res.result.blocksCreated, 1);
    assert.deepEqual(lostCoverage(before, res.state), []);
  });
});
