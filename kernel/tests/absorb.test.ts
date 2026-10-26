import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAbsorb,
  appendAbsorbPrompts,
  buildAbsorbPrompt,
  buildAbsorbSystemPrompt,
  hideAbsorbedMessages,
  isAbsorbCandidate,
  parseAbsorbInput,
  DEFAULT_ABSORB_CONFIG,
  ABSORB_PROMPT_MARKER,
} from "../src/absorb.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { assignRefs, refForRaw } from "../src/refs.js";
import { isRenderedSummaryMessage } from "../src/prune.js";
import type { CompressionState, Config, CoreMessage } from "../src/types.js";

const countTokens = (text: string) => Math.ceil(text.length / 4);

function bigResult(id: string, callId: string, toolName = "read"): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName,
    toolCallId: callId,
    text: "x".repeat(4800),
  };
}

function smallResult(
  id: string,
  callId: string,
  toolName = "read",
): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName,
    toolCallId: callId,
    text: "ok",
  };
}

function toolCall(id: string, callId: string, toolName = "read"): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: `args-${callId}`,
  };
}

function session(): CoreMessage[] {
  return [
    { id: "u1", role: "user", contentType: "text", text: "run the build" },
    toolCall("c1", "call1"),
    bigResult("r1", "call1"),
    toolCall("c2", "call2", "bash"),
    smallResult("r2", "call2", "bash"),
  ];
}

// mediaOnly is pinned false here on purpose: these tests exercise the absorb
// MECHANISM (prompting/hiding/stats/skip rules) in isolation over text results.
// The #3402 media-scope gate (default true) is covered by dedicated tests at
// the bottom of this file — mixing it in would make every fixture need a payload.
function absorbConfig(
  overrides: Partial<Config["absorb"]> = {},
): Config["absorb"] {
  return {
    enabled: true,
    toolName: "absorb",
    minToolTokens: 1000,
    contextThresholdPct: 0,
    excludeTools: [],
    mediaOnly: false,
    ...overrides,
  };
}

function mediaResult(id: string, callId: string, toolName = "screenshot"): CoreMessage {
  return Object.assign(smallResult(id, callId, toolName), {
    imageBase64: "iVBORw0KGgoAAAANSUhEUg==",
  });
}

function stateWithRefs(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

test("appendAbsorbPrompts: disabled config is a no-op", () => {
  const messages = session();
  const state = stateWithRefs(messages);
  const config = defaultConfig(200000);
  const result = appendAbsorbPrompts(
    messages,
    state,
    config,
    5000,
    countTokens,
  );
  assert.equal(result.promptedCount, 0);
  assert.equal(result.messages, messages);
});

test("appendAbsorbPrompts: appends prompt to large un-absorbed tool result, citing its ref", () => {
  const messages = session();
  const state = stateWithRefs(messages);
  const config = defaultConfig(200000, { absorb: absorbConfig() });
  const result = appendAbsorbPrompts(
    messages,
    state,
    config,
    5000,
    countTokens,
  );
  assert.equal(result.promptedCount, 1);
  const r1 = result.messages.find((m) => m.id === "r1")!;
  assert.ok(r1.text!.includes(ABSORB_PROMPT_MARKER));
  const ref = refForRaw(state.messageRefs, "r1")!;
  assert.ok(r1.text!.includes(`ref: "${ref}"`));
  assert.ok(r1.text!.startsWith("x".repeat(10)));
  const r2 = result.messages.find((m) => m.id === "r2")!;
  assert.ok(!r2.text!.includes(ABSORB_PROMPT_MARKER));
});

test("appendAbsorbPrompts: skips ACP tools, protected tools, and excluded tools", () => {
  const messages: CoreMessage[] = [
    toolCall("c1", "call1", "read"),
    bigResult("r1", "call1", "read"),
    toolCall("c2", "call2", "search_context"),
    bigResult("r2", "call2", "search_context"),
    toolCall("c3", "call3", "grep"),
    bigResult("r3", "call3", "grep"),
    toolCall("c4", "call4", "absorb"),
    bigResult("r4", "call4", "absorb"),
  ];
  const state = stateWithRefs(messages);
  const config = defaultConfig(200000, {
    absorb: absorbConfig({ excludeTools: ["gr*"] }),
    protectedTools: ["read"],
  });
  const result = appendAbsorbPrompts(
    messages,
    state,
    config,
    5000,
    countTokens,
  );
  assert.equal(result.promptedCount, 0);
  assert.ok(!isAbsorbCandidate(messages[1]!, config));
  assert.ok(!isAbsorbCandidate(messages[3]!, config));
  assert.ok(!isAbsorbCandidate(messages[5]!, config));
  assert.ok(!isAbsorbCandidate(messages[7]!, config));
});

test("appendAbsorbPrompts: respects the context-usage gate", () => {
  const messages = session();
  const state = stateWithRefs(messages);
  const config = defaultConfig(10000, {
    absorb: absorbConfig({ contextThresholdPct: 0.5 }),
  });
  const below = appendAbsorbPrompts(messages, state, config, 4000, countTokens);
  assert.equal(below.promptedCount, 0);
  const at = appendAbsorbPrompts(messages, state, config, 5000, countTokens);
  assert.equal(at.promptedCount, 1);
});

test("appendAbsorbPrompts: never double-appends (idempotent marker check)", () => {
  const messages = session();
  const state = stateWithRefs(messages);
  const config = defaultConfig(200000, { absorb: absorbConfig() });
  const once = appendAbsorbPrompts(messages, state, config, 5000, countTokens);
  const twice = appendAbsorbPrompts(
    once.messages,
    state,
    config,
    5000,
    countTokens,
  );
  assert.equal(twice.promptedCount, 0);
  const r1 = twice.messages.find((m) => m.id === "r1")!;
  assert.equal(r1.text!.split(ABSORB_PROMPT_MARKER).length - 1, 1);
});

test("applyAbsorb: happy path records the pair and updates stats", () => {
  const messages = session();
  const state = stateWithRefs(messages);
  const config = defaultConfig(200000, { absorb: absorbConfig() });
  const ref = refForRaw(state.messageRefs, "r1")!;
  const outcome = applyAbsorb({
    ref,
    summary: "build ok, 45 tests",
    absorbCallId: "abs-call-1",
    messages,
    state,
    config,
  });
  assert.ok(outcome.ok, outcome.resultText);
  assert.equal(outcome.state.absorbed!.length, 1);
  const record = outcome.state.absorbed![0]!;
  assert.equal(record.toolCallId, "call1");
  assert.equal(record.callMessageId, "c1");
  assert.equal(record.resultMessageId, "r1");
  assert.equal(record.absorbCallId, "abs-call-1");
  assert.ok(record.tokensReclaimed >= 1000);
  assert.equal(outcome.state.stats.absorbedTokens, record.tokensReclaimed);
});

test("applyAbsorb: rejects empty summary, unknown ref, non-tool-result, ACP tool, protected tool", () => {
  const messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "hi" },
    toolCall("c1", "call1", "read"),
    bigResult("r1", "call1", "read"),
    toolCall("c2", "call2", "search_context"),
    bigResult("r2", "call2", "search_context"),
    toolCall("c3", "call3", "todo"),
    bigResult("r3", "call3", "todo"),
  ];
  const state = stateWithRefs(messages);
  const config = defaultConfig(200000, {
    absorb: absorbConfig(),
    protectedTools: ["todo"],
  });
  const refUser = refForRaw(state.messageRefs, "u1")!;
  const refAcp = refForRaw(state.messageRefs, "r2")!;
  const refProtected = refForRaw(state.messageRefs, "r3")!;

  const empty = applyAbsorb({
    ref: refUser,
    summary: "  ",
    messages,
    state,
    config,
  });
  assert.equal(empty.ok, false);

  const unknown = applyAbsorb({
    ref: "m99999",
    summary: "s",
    messages,
    state,
    config,
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.resultText.includes("does not exist"));

  const notToolResult = applyAbsorb({
    ref: refUser,
    summary: "s",
    messages,
    state,
    config,
  });
  assert.equal(notToolResult.ok, false);
  assert.ok(notToolResult.resultText.includes("not a tool result"));

  const acp = applyAbsorb({
    ref: refAcp,
    summary: "s",
    messages,
    state,
    config,
  });
  assert.equal(acp.ok, false);
  assert.ok(acp.resultText.includes("ACP-managed"));

  const protectedTool = applyAbsorb({
    ref: refProtected,
    summary: "s",
    messages,
    state,
    config,
  });
  assert.equal(protectedTool.ok, false);
  assert.ok(protectedTool.resultText.includes("protected"));
});

test("applyAbsorb: second absorb of the same target is idempotent", () => {
  const messages = session();
  const state = stateWithRefs(messages);
  const config = defaultConfig(200000, { absorb: absorbConfig() });
  const ref = refForRaw(state.messageRefs, "r1")!;
  const first = applyAbsorb({ ref, summary: "s1", messages, state, config });
  assert.ok(first.ok);
  const second = applyAbsorb({
    ref,
    summary: "s2",
    messages,
    state: first.state,
    config,
  });
  assert.ok(second.ok);
  assert.ok(second.resultText.includes("already absorbed"));
  assert.equal(second.state.absorbed!.length, 1);
  assert.equal(
    second.state.stats.absorbedTokens,
    first.state.stats.absorbedTokens,
  );
});

test("applyAbsorb: warns when the summary is not smaller than the original", () => {
  const messages = session();
  const state = stateWithRefs(messages);
  const config = defaultConfig(200000, { absorb: absorbConfig() });
  const ref = refForRaw(state.messageRefs, "r1")!;
  const outcome = applyAbsorb({
    ref,
    summary: "y".repeat(messages[2]!.text!.length),
    messages,
    state,
    config,
  });
  assert.ok(outcome.ok);
  assert.ok(outcome.resultText.includes("distill harder"));
});

test("hideAbsorbedMessages: drops both halves of the recorded pair only", () => {
  const messages = session();
  const state = stateWithRefs(messages);
  const config = defaultConfig(200000, { absorb: absorbConfig() });
  const ref = refForRaw(state.messageRefs, "r1")!;
  const absorbed = applyAbsorb({
    ref,
    summary: "s",
    messages,
    state,
    config,
  }).state;
  const visible = hideAbsorbedMessages(messages, absorbed);
  assert.deepEqual(
    visible.map((m) => m.id),
    ["u1", "c2", "r2"],
  );
});

test("full processTurn: prompt appears, then pair is hidden after absorb while the absorb call survives", () => {
  const core = createCore({ countTokens });
  const config = defaultConfig(10000, { absorb: absorbConfig() });
  let state = createInitialState();
  let messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "read the file" },
    toolCall("c1", "call1", "read"),
    bigResult("r1", "call1", "read"),
  ];

  const turn1 = core.processTurn({ messages, state, config, tokenCount: 3000 });
  state = turn1.state;
  const prompted = turn1.messages.find((m) => m.id === "r1")!;
  assert.ok(prompted.text!.includes(ABSORB_PROMPT_MARKER));
  const ref = refForRaw(state.messageRefs, "r1")!;

  messages = [
    ...messages,
    toolCall("c2", "call2", "absorb"),
    {
      id: "r2",
      role: "tool",
      contentType: "tool-result",
      toolName: "absorb",
      toolCallId: "call2",
      text: "absorbed m00003",
    },
  ];
  const outcome = applyAbsorb({
    ref,
    summary: "file defines foo(a,b) at src/foo.ts:12",
    absorbCallId: "call2",
    messages,
    state,
    config,
  });
  assert.ok(outcome.ok);
  state = outcome.state;

  const turn2 = core.processTurn({ messages, state, config, tokenCount: 3200 });
  const ids = turn2.messages.map((m) => m.id);
  assert.ok(!ids.includes("c1"), "original tool-call hidden");
  assert.ok(!ids.includes("r1"), "original tool-result hidden");
  assert.ok(ids.includes("c2"), "absorb call kept");
  assert.ok(ids.includes("r2"), "absorb result kept");
  assert.ok(
    !turn2.messages
      .find((m) => m.id === "r2")!
      .text!.includes(ABSORB_PROMPT_MARKER),
  );
  for (const m of turn2.messages) {
    if (m.contentType === "tool-result" && m.toolName !== "absorb") {
      assert.ok(!m.text!.includes(ABSORB_PROMPT_MARKER), "no prompts remain");
    }
  }
  assert.equal(turn2.messages.filter(isRenderedSummaryMessage).length, 0);
});

test("absorbed records survive applyCompression cloning", () => {
  const core = createCore({ countTokens });
  const messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "go" },
    toolCall("c1", "call1", "read"),
    bigResult("r1", "call1", "read"),
    { id: "u2", role: "user", contentType: "text", text: "done" },
  ];
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config: defaultConfig(200000),
    tokenCount: 100,
  }).state;
  const config = defaultConfig(200000, {
    absorb: absorbConfig(),
    compress: {
      minCompressRange: 0,
      maxSummaryLength: 20000,
      minSummaryLength: 0,
    },
  });
  const ref = refForRaw(state.messageRefs, "r1")!;
  state = applyAbsorb({ ref, summary: "s", messages, state, config }).state;
  const applied = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "sum of the range" },
    ],
    messages,
    state,
    config,
  });
  assert.equal(applied.result.blocksCreated, 1);
  assert.equal(applied.state.absorbed!.length, 1);
  assert.equal(applied.state.stats.absorbedTokens, state.stats.absorbedTokens);
});

test("parseAbsorbInput: object, aliases, JSON string, and rejects malformed", () => {
  const warns: string[] = [];
  const plain = parseAbsorbInput(
    { ref: "m00003", summary: "s" },
    "call9",
    (w) => warns.push(w),
  );
  assert.deepEqual(plain, {
    ref: "m00003",
    summary: "s",
    absorbCallId: "call9",
  });

  const aliased = parseAbsorbInput({ of: "m00004", content: "s2" });
  assert.deepEqual(aliased, { ref: "m00004", summary: "s2" });

  const jsonString = parseAbsorbInput('{"messageId":"m00005","summary":"s3"}');
  assert.deepEqual(jsonString, { ref: "m00005", summary: "s3" });

  assert.equal(parseAbsorbInput("not json"), null);
  assert.equal(parseAbsorbInput({ ref: 1, summary: "s" }), null);
  assert.equal(parseAbsorbInput(null), null);
  assert.ok(
    warns.length === 0 ||
      warns.every((w) => w.startsWith("[acp-absorb-input]")),
  );
});

test("buildAbsorbPrompt and buildAbsorbSystemPrompt carry the tool name and marker", () => {
  const prompt = buildAbsorbPrompt("m00007", 1234, "acp_absorb");
  assert.ok(prompt.includes(ABSORB_PROMPT_MARKER));
  assert.ok(prompt.includes('ref: "m00007"'));
  assert.ok(prompt.includes("acp_absorb"));
  assert.ok(prompt.includes("~1.2K tokens"));
  const system = buildAbsorbSystemPrompt("acp_absorb");
  assert.ok(system.includes("acp_absorb"));
  assert.ok(system.includes(ABSORB_PROMPT_MARKER));
});

test("absorb config validation reports range errors", () => {
  const config = defaultConfig(200000, {
    absorb: absorbConfig({ minToolTokens: -5, contextThresholdPct: 1.5 }),
  });
  const errors = validateConfig(config);
  assert.ok(
    errors.some((e) => e.includes("absorb.minToolTokens")),
    "expected minToolTokens error",
  );
  assert.ok(errors.some((e) => e.includes("absorb.contextThresholdPct")));
});

// --- #3402 media-scope gate (revival of absorb, scoped to image-bearing results) ---

test("isAbsorbCandidate: mediaOnly gates on hasMediaPayload", () => {
  const textRes = bigResult("r1", "call1");
  const mediaRes = mediaResult("r2", "call2");
  const on = defaultConfig(200000, { absorb: absorbConfig({ mediaOnly: true }) });
  const off = defaultConfig(200000, { absorb: absorbConfig({ mediaOnly: false }) });
  assert.equal(isAbsorbCandidate(textRes, on), false, "mediaOnly on + no media → not a candidate");
  assert.equal(isAbsorbCandidate(mediaRes, on), true, "mediaOnly on + media → candidate");
  assert.equal(isAbsorbCandidate(textRes, off), true, "mediaOnly off + no media → candidate (old behavior)");
  assert.equal(isAbsorbCandidate(mediaRes, off), true, "mediaOnly off + media → candidate");
});

test("appendAbsorbPrompts: mediaOnly marks image results (even small) and skips text results", () => {
  const build = (): CoreMessage[] => [
    toolCall("c1", "call1", "read"),
    bigResult("r1", "call1", "read"),
    toolCall("c2", "call2", "screenshot"),
    mediaResult("r2", "call2", "screenshot"),
  ];
  const onMsgs = build();
  const onState = stateWithRefs(onMsgs);
  const onCfg = defaultConfig(200000, { absorb: absorbConfig({ mediaOnly: true }) });
  const onRes = appendAbsorbPrompts(onMsgs, onState, onCfg, 5000, countTokens);
  assert.ok(!onRes.messages.find((m) => m.id === "r1")!.text!.includes(ABSORB_PROMPT_MARKER), "text-only result NOT marked under mediaOnly");
  assert.ok(onRes.messages.find((m) => m.id === "r2")!.text!.includes(ABSORB_PROMPT_MARKER), "small image result IS marked (exempt from minToolTokens)");
  assert.equal(onRes.promptedCount, 1);

  const offMsgs = build();
  const offState = stateWithRefs(offMsgs);
  const offCfg = defaultConfig(200000, { absorb: absorbConfig({ mediaOnly: false }) });
  const offRes = appendAbsorbPrompts(offMsgs, offState, offCfg, 5000, countTokens);
  assert.ok(offRes.messages.find((m) => m.id === "r1")!.text!.includes(ABSORB_PROMPT_MARKER), "old behavior: large text result marked");
  assert.ok(!offRes.messages.find((m) => m.id === "r2")!.text!.includes(ABSORB_PROMPT_MARKER), "old behavior: tiny result below bar stays unmarked");
});

test("applyAbsorb: mediaOnly rejects a non-media target (mirror of screening)", () => {
  const messages: CoreMessage[] = [
    toolCall("c1", "call1", "read"),
    bigResult("r1", "call1", "read"),
    toolCall("c2", "call2", "screenshot"),
    mediaResult("r2", "call2", "screenshot"),
  ];
  const state = stateWithRefs(messages);
  const cfg = defaultConfig(200000, { absorb: absorbConfig({ mediaOnly: true }) });
  const refused = applyAbsorb({ ref: refForRaw(state.messageRefs, "r1")!, summary: "s", messages, state, config: cfg });
  assert.equal(refused.ok, false);
  assert.ok(refused.resultText.includes("no media payload"));
  const accepted = applyAbsorb({ ref: refForRaw(state.messageRefs, "r2")!, summary: "s", messages, state, config: cfg });
  assert.ok(accepted.ok, accepted.resultText);
  assert.equal(accepted.state.absorbed!.length, 1);
});

test("kernel ships mediaOnly neutral; the media-scoped default is host policy", () => {
  // The engine exposes the capability with a neutral default (unset → legacy
  // full-text when enabled) so engine goldens stay untouched; bili's product
  // stance (media-scoped by default, #3402) is applied one layer up in
  // resolveAbsorbSettings — pinned in tests/absorb.test.ts ("maps settings
  // absorb onto kernel AbsorbConfig").
  assert.equal(defaultConfig(100000).absorb?.mediaOnly, undefined);
  assert.equal(DEFAULT_ABSORB_CONFIG.mediaOnly, undefined);
});
