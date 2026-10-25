import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { Config, CoreMessage } from "../src/types.js";

const COUNT_TOKENS = (text: string) => Math.ceil(text.length / 4);

function user(id: string, text = "u"): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "text",
    text: `${text}-${id} ` + "x".repeat(200),
  };
}
function assistantText(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "text",
    text: `answer-${id} ` + "y".repeat(200),
  };
}
function reasoning(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "reasoning",
    text: `think-${id} ` + "t".repeat(200),
  };
}
function toolCall(id: string, callId: string, toolName = "pwsh"): CoreMessage {
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
  toolName = "pwsh",
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

/** m1 task · m2 answer · m3 think · m4/m5 pwsh pair · m6 follow-up ·
 * m7 answer · m8/m9 bash pair · m10 latest user. Refs land on m00001..m00010
 * in order after the initial processTurn. */
function buildMessages(): CoreMessage[] {
  return [
    user("m1"),
    assistantText("m2"),
    reasoning("m3"),
    toolCall("m4", "call_0"),
    toolResult("m5", "call_0"),
    user("m6", "follow-up"),
    assistantText("m7"),
    toolCall("m8", "call_1", "bash"),
    toolResult("m9", "call_1", "bash"),
    user("m10", "latest"),
  ];
}

function config(over: Record<string, unknown> = {}): Config {
  const base = defaultConfig(150000);
  return {
    ...base,
    // disable the token-window rule and the built-in tool exclusion so the
    // fixture's small tail defines the recent zone precisely (last-N
    // messages + last user message only)
    preserveRecentTokens: 0,
    neverPreserveRecentTools: [],
    compress: {
      ...base.compress,
      minCompressRange: 1,
      minSummaryLength: 1,
      ...over,
    },
  };
}

/** m1 task · m2 answer · m3 think · m4/m5 pwsh pair · m6 follow-up ·
 * m7 answer. Refs land on m00001..m00007 in order after processTurn. */
function buildShortMessages(): CoreMessage[] {
  return [
    user("m1"),
    assistantText("m2"),
    reasoning("m3"),
    toolCall("m4", "call_0"),
    toolResult("m5", "call_0"),
    user("m6", "follow-up"),
    assistantText("m7"),
  ];
}

interface Fixture {
  core: ReturnType<typeof createCore>;
  state: import("../src/types.js").CompressionState;
  messages: CoreMessage[];
  ref: (rawId: string) => string;
}

function setup(cfgOverride?: Config): Fixture {
  const core = createCore({ countTokens: COUNT_TOKENS });
  const cfg = cfgOverride ?? config();
  const messages = buildMessages();
  const out = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount: COUNT_TOKENS,
  });
  const state = out.state;
  return {
    core,
    state,
    messages,
    ref: (rawId: string) => state.messageRefs.byRaw[rawId]!,
  };
}

const SUMMARY = "s".repeat(60);

describe("previewCompression (#3185)", () => {
  it("reports recent-zone exclusion with the rest still foldable", () => {
    const { core, state, messages, ref } = setup();
    const report = core.previewCompression({
      ranges: [{ startRef: "m00001", endRef: "m00009" }],
      messages,
      state,
      config: config(),
    });
    assert.equal(report.batchError, null);
    const r = report.ranges[0]!;
    assert.equal(r.error, null);
    // m8/m9 sit in the recent-N zone (preserveRecentMessages=3: m8,m9,m10)
    assert.deepEqual(r.excluded?.recentZone?.sort(), [
      ref("m8"),
      ref("m9"),
    ].sort());
    assert.ok(!r.excluded?.protectedTools?.length);
    for (const id of ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]) {
      assert.ok(
        r.wouldFold!.includes(ref(id)),
        `${id} (${ref(id)}) must be in wouldFold`,
      );
    }
    assert.equal(r.wouldFold!.length, 7);
    assert.ok(
      r.estimatedTokensSaved! > 0,
      "savings must be a positive estimate",
    );
  });

  it("matches the real call's exact error for a fully-protected range", () => {
    const { core, state, messages } = setup();
    const report = core.previewCompression({
      ranges: [{ startRef: "m00008", endRef: "m00010" }],
      messages,
      state,
      config: config(),
    });
    const r = report.ranges[0]!;
    assert.match(r.error!, /entirely within the protected zone/);
    const real = core.applyCompression({
      ranges: [{ startRef: "m00008", endRef: "m00010", summary: SUMMARY }],
      messages,
      state,
      config: config(),
    });
    assert.equal(real.result.blocksCreated, 0);
    // #3939 all-or-nothing: the real call wraps per-range failures in a
    // single batch rejection — the preview must carry the same text at the
    // batch level (per-range detail stays in r.error).
    assert.equal(report.batchError, real.result.errors[0]);
  });

  it("reports turn-integrity withdrawals with split counts (partial)", () => {
    // Protect the tool-call only; folding its turn's other members must
    // withdraw the WHOLE turn (reasoning + call + result) from the fold set.
    const core = createCore({ countTokens: COUNT_TOKENS });
    const cfg = config();
    const messages = buildShortMessages();
    const out = core.processTurn({
      messages,
      state: createInitialState(),
      config: cfg,
      tokenCount: COUNT_TOKENS,
    });
    const state = out.state;
    const ref = (rawId: string) => state.messageRefs.byRaw[rawId]!;
    const report = core.previewCompression({
      ranges: [{ startRef: "m00002", endRef: "m00005" }],
      messages,
      state,
      config: cfg,
      protectedMessageIds: new Set([ref("m4")]),
    });
    const r = report.ranges[0]!;
    assert.equal(r.error, null);
    assert.deepEqual(r.withdrawn?.refs.sort(), [
      ref("m3"),
      ref("m4"),
      ref("m5"),
    ].sort());
    assert.equal(r.withdrawn?.splitTurns, 1);
    assert.deepEqual(r.wouldFold, [ref("m2")]);
    // the warning counts removals from the fold set: the carved-out call was
    // never in it, and #3953's truncation already kept the later result
    // visible — so only the reasoning message's removal is counted: 1, not
    // the whole group's 3
    assert.ok(
      r.warnings?.some((w) => /Withdrawn 1 message/.test(w)),
      JSON.stringify(r.warnings),
    );
  });

  it("reports the exact split-turn error when the range empties out", () => {
    const core = createCore({ countTokens: COUNT_TOKENS });
    const cfg = config();
    const messages = buildShortMessages();
    const out = core.processTurn({
      messages,
      state: createInitialState(),
      config: cfg,
      tokenCount: COUNT_TOKENS,
    });
    const state = out.state;
    const ref = (rawId: string) => state.messageRefs.byRaw[rawId]!;
    const input = {
      ranges: [{ startRef: "m00003", endRef: "m00005" }],
      messages,
      state,
      config: cfg,
      protectedMessageIds: new Set([ref("m4")]),
    };
    const report = core.previewCompression(input);
    const r = report.ranges[0]!;
    assert.match(r.error!, /split 1 turn/);
    const real = core.applyCompression({
      ...input,
      ranges: [{ startRef: "m00003", endRef: "m00005", summary: SUMMARY }],
    });
    assert.equal(real.result.blocksCreated, 0);
    // #3939 all-or-nothing: batch-level rejection text is shared verbatim.
    assert.equal(report.batchError, real.result.errors[0]);
  });

  it("categorizes protected-tool exclusions separately from the recent zone", () => {
    // self-contained pwsh pair (no adjacent reasoning) so turn-integrity
    // stays out of the picture; bash pair sits in the recent zone tail.
    // Blocked pwsh messages get no refs, so the numbering is
    // m1=m00001 m2=m00002 m5=m00003 m6=m00004 m7=m00005 m8=m00006 m9=m00007 —
    // the range must end at m00004 (= raw m6), NOT m00006 (= raw m8, in-zone).
    const core = createCore({ countTokens: COUNT_TOKENS });
    const cfg = { ...config(), protectedTools: ["pwsh"] };
    const messages: CoreMessage[] = [
      user("m1"),
      assistantText("m2"),
      toolCall("m3", "c0"),
      toolResult("m4", "c0"),
      user("m5", "follow-up"),
      assistantText("m6"),
      toolCall("m7", "c1", "bash"),
      toolResult("m8", "c1", "bash"),
      user("m9", "latest"),
    ];
    const out = core.processTurn({
      messages,
      state: createInitialState(),
      config: cfg,
      tokenCount: COUNT_TOKENS,
    });
    const state = out.state;
    const ref = (rawId: string) => state.messageRefs.byRaw[rawId]!;
    const report = core.previewCompression({
      ranges: [{ startRef: "m00001", endRef: "m00004" }],
      messages,
      state,
      config: cfg,
    });
    const r = report.ranges[0]!;
    assert.equal(r.error, null);
    // protected-tool messages never receive a real ref (BLOCKED marker)
    assert.deepEqual(r.excluded?.protectedTools, ["BLOCKED", "BLOCKED"]);
    assert.ok(!r.excluded?.recentZone?.length);
    assert.deepEqual(
      r.wouldFold!.sort(),
      [ref("m1"), ref("m2"), ref("m5"), ref("m6")].sort(),
    );
  });

  it("surfaces the min-range gate as batchError with per-range detail", () => {
    const cfg = config({ minCompressRange: 100000 });
    const { core, state, messages } = setup(cfg);
    const report = core.previewCompression({
      ranges: [{ startRef: "m00001", endRef: "m00002" }],
      messages,
      state,
      config: cfg,
    });
    assert.match(report.batchError!, /too small/);
    assert.equal(report.ranges[0]!.error, null);
    const real = core.applyCompression({
      ranges: [{ startRef: "m00001", endRef: "m00002", summary: SUMMARY }],
      messages,
      state,
      config: cfg,
    });
    assert.equal(real.result.errors[0], report.batchError);
  });

  it("reports unknown refs instead of failing the whole batch silently", () => {
    const { core, state, messages } = setup();
    const report = core.previewCompression({
      ranges: [{ startRef: "m09999", endRef: "m10000" }],
      messages,
      state,
      config: config(),
    });
    assert.match(report.batchError!, /unknown/i);
    assert.match(report.ranges[0]!.error!, /m09999/);
  });

  it("marks already-covered ranges without proposing a duplicate block", () => {
    const { core, state, messages } = setup();
    const committed = core.applyCompression({
      ranges: [{ startRef: "m00001", endRef: "m00002", summary: SUMMARY }],
      messages,
      state,
      config: config(),
    });
    assert.equal(committed.result.blocksCreated, 1);
    // hosts pass the POST-FOLD view: folded messages are gone from the wire
    const block = committed.state.blocks.find((b) => b.active)!;
    const view = messages.filter(
      (m) => !block.effectiveMessageIds.includes(m.id),
    );
    const report = core.previewCompression({
      ranges: [{ startRef: "m00001", endRef: "m00002" }],
      messages: view,
      state: committed.state,
      config: config(),
    });
    const r = report.ranges[0]!;
    assert.equal(r.error, null);
    assert.equal(r.alreadyCovered, true);
    assert.ok(
      r.warnings?.some((w) => /already compressed/i.test(w)),
      JSON.stringify(r.warnings),
    );
  });

  it("is pure: caller state byte-identical, no blocks, no ref allocation", () => {
    const { core, state, messages } = setup();
    const before = JSON.stringify(state);
    const blocksBefore = state.blocks.length;
    core.previewCompression({
      ranges: [
        { startRef: "m00001", endRef: "m00009" },
        { startRef: "m00003", endRef: "m00004" },
        { startRef: "m00008", endRef: "m00010" },
      ],
      messages,
      state,
      config: config(),
    });
    assert.equal(JSON.stringify(state), before);
    assert.equal(state.blocks.length, blocksBefore);
  });

  it("is idempotent: repeated previews produce identical reports", () => {
    const { core, state, messages } = setup();
    const input = {
      ranges: [
        { startRef: "m00001", endRef: "m00007" },
        { startRef: "m00008", endRef: "m00010" },
      ],
      messages,
      state,
      config: config(),
    };
    const first = core.previewCompression(input);
    const second = core.previewCompression(input);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it("estimates savings from the frozen per-message token counts", () => {
    const { core, state, messages, ref } = setup();
    const report = core.previewCompression({
      ranges: [{ startRef: "m00001", endRef: "m00002" }],
      messages,
      state,
      config: config(),
    });
    const r = report.ranges[0]!;
    assert.equal(r.error, null);
    const expected = ["m1", "m2"].reduce(
      (sum, id) => sum + COUNT_TOKENS(messages.find((m) => m.id === id)!.text!),
      0,
    );
    assert.equal(r.estimatedTokensSaved, expected);
    assert.deepEqual(r.wouldFold.sort(), [ref("m1"), ref("m2")].sort());
  });
});
