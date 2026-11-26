import test from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
import { responsesToCore } from "../src/wire/responses.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

const message = (
  id: string,
  role: CoreMessage["role"] = "user",
): CoreMessage => ({ id, role, contentType: "text", text: id });
function state(): CompressionState {
  const s = createInitialState();
  for (let n = 1; n <= 2; n++)
    s.blocks.push({
      blockId: `b${n}`,
      runId: `r${n}`,
      tier: 1,
      summary: `Summary ${n}`,
      directMessageIds: [`absent-${n}`],
      effectiveMessageIds: [`absent-${n}`],
      directBlockIds: [],
      compressedTokens: 100,
      createdAt: 0,
      survivedCount: 1,
      generation: "old",
      active: true,
    });
  return s;
}
const input = () => [
  message("opening"),
  message("prior-history", "assistant"),
  message("old-task"),
  message("prior-work", "assistant"),
];
const ids = (ms: CoreMessage[]) => ms.map((m) => m.id);
const learn = { rememberFallbackAnchors: true };

test("unresolved summaries keep their successor through append-only turns and JSON restart", () => {
  const s = state(),
    a = input();
  const first = prune(a, s, learn);
  assert.deepEqual(ids(first), [
    "opening",
    "prior-history",
    "acp_summary_b1",
    "acp_summary_b2",
    "old-task",
    "prior-work",
  ]);
  const restored = JSON.parse(JSON.stringify(s));
  const next = prune(
    [...a, message("finished", "assistant"), message("new-task")],
    restored,
    learn,
  );
  assert.deepEqual(next.slice(0, first.length), first);
  assert.equal(restored.blocks[0].fallbackUserMessageId, "old-task");
});

test("standalone preview and head export do not learn or overwrite fallback", () => {
  const s = state();
  prune(input(), s);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, undefined);
  prune(input(), s, learn);
  const before = JSON.stringify(s);
  const out = prune([...input(), message("later")], s, {
    ...learn,
    headSummaryAnchors: true,
  });
  assert.equal(out[0]!.id, "acp_summary_b1");
  assert.equal(JSON.stringify(s), before);
});

test("real anchors and rendered carriers take priority; missing/covered successor relearns", () => {
  const s = state();
  prune(input(), s, learn);
  const actual = prune(
    [...input(), message("absent-1", "assistant"), message("new-task")],
    s,
    learn,
  );
  assert.ok(
    ids(actual).indexOf("acp_summary_b1") > ids(actual).indexOf("old-task"),
  );
  const rewritten = [message("opening"), message("replacement")];
  assert.equal(prune(rewritten, s, learn)[1]!.id, "acp_summary_b1");
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "replacement");
  s.blocks[1]!.effectiveMessageIds.push("replacement");
  prune([...rewritten, message("new-task")], s, learn);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "new-task");
  const existing = prune(
    [
      message("opening"),
      {
        id: "acp_summary_b1",
        role: "system",
        contentType: "text",
        text: "old",
      },
      message("other"),
    ],
    s,
    learn,
  );
  assert.equal(existing[1]!.id, "acp_summary_b1");
});

test("multimodal users anchor before the whole wire item; opening user retains unresolved exception", () => {
  const s = state();
  const split = [
    message("opening"),
    message("work", "assistant"),
    { ...message("question#text"), wireIndex: 2 },
    { ...message("question#image"), wireIndex: 2 },
  ];
  const out = prune(split, s, learn);
  assert.deepEqual(ids(out), [
    "opening",
    "work",
    "acp_summary_b1",
    "acp_summary_b2",
    "question#text",
    "question#image",
  ]);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "question#text");
  assert.equal(
    prune([message("only-user")], state(), learn)[0]!.id,
    "acp_summary_b1",
  );
});

test("fallback does not split a tool call/result exchange", () => {
  const s = state();
  const ms: CoreMessage[] = [
    message("opening"),
    {
      id: "call",
      role: "assistant",
      contentType: "tool-call",
      toolCallId: "t",
      toolName: "read",
      text: "{}",
    },
    {
      id: "result",
      role: "user",
      contentType: "tool-result",
      toolCallId: "t",
      text: "ok",
    },
    message("task"),
  ];
  const out = prune(ms, s, learn);
  assert.equal(ids(out).indexOf("result"), ids(out).indexOf("call") + 1);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "task");
});

test("actual Responses projection through processTurn learns durable fallback without mutating input state", () => {
  const s = state();
  const items = ["opening", "prior-history", "old-task", "prior-work"].map(
    (text, i) => ({
      type: "message" as const,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: text,
    }),
  );
  const a = responsesToCore({ input: items }).msgs;
  // The ledger interval keeps blocks live even though their original ids are
  // absent. This is a genuinely unresolved anchor after syncBlocks runs.
  a[1]!.ledgerSeq = 10;
  for (const b of s.blocks) {
    b.startSeq = 10;
    b.endSeq = 10;
  }
  const core = createCore();
  const config = defaultConfig(200_000);
  const run = (messages: CoreMessage[], state: CompressionState) =>
    core.processTurn({
      messages,
      state,
      config,
      tokenCount: 100,
      renderTags: "none",
    });
  const first = run(a, s);
  assert.ok(
    first.state.blocks.every(
      (b) => b.active && b.fallbackUserMessageId === a[2]!.id,
    ),
  );
  assert.equal(s.blocks[0]!.fallbackUserMessageId, undefined);
  const b = responsesToCore({
    input: [
      ...items,
      { type: "message", role: "assistant", content: "finished" },
      { type: "message", role: "user", content: "new-task" },
    ],
  }).msgs;
  b[1]!.ledgerSeq = 10;
  const next = run(b, JSON.parse(JSON.stringify(first.state)));
  assert.deepEqual(
    next.messages.slice(0, first.messages.length),
    first.messages,
  );
});

test("carrier roundtrip and temporary no-user view retain the learned successor", () => {
  const s = state(),
    a = input();
  const rendered = prune(a, s, learn);
  assert.deepEqual(prune(rendered, s, learn), rendered);
  prune([message("tool-only-view", "assistant")], s, learn);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "old-task");
  assert.deepEqual(
    prune([...a, message("new-task")], s, learn).slice(0, rendered.length),
    rendered,
  );
});

test("partially covered multimodal successor binds a surviving part, before the whole item", () => {
  const s = state();
  s.blocks[1]!.effectiveMessageIds.push("covered-part");
  const a = [
    message("opening"),
    message("work", "assistant"),
    { ...message("covered-part"), wireIndex: 2 },
    { ...message("visible-part"), wireIndex: 2 },
  ];
  const first = prune(a, s, learn);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "visible-part");
  assert.deepEqual(ids(first), [
    "opening",
    "work",
    "acp_summary_b1",
    "acp_summary_b2",
    "visible-part",
  ]);
  assert.deepEqual(
    prune([...a, message("later")], s, learn).slice(0, first.length),
    first,
  );
});

test("a covered remembered successor reselects once then stays stable", () => {
  const s = state(),
    a = input();
  prune(a, s, learn);
  s.blocks[1]!.effectiveMessageIds.push("old-task");
  const next = [...a, message("next-task")];
  const first = prune(next, s, learn);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "next-task");
  assert.deepEqual(
    prune([...next, message("later")], s, learn).slice(0, first.length),
    first,
  );
});
