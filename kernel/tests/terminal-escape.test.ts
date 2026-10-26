import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import { truncateLargeToolOutputs } from "../src/truncate-tools.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
  type: CoreMessage["contentType"] = "text",
): CoreMessage {
  return { id, role, contentType: type, text };
}

function stateWithRefs(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

/** #452 shape: irreducible floor (system prompt) exceeds the limit; every
 *  other message is tiny, below minCompressRange, and inside the recent-5
 *  protected zone — nothing compressible above the benefit floor, nothing
 *  truncatable. */
function floorSession(limit = 100000) {
  const messages: CoreMessage[] = [
    msg("sys", "S".repeat(80000), "system"),
    msg("u1", "small request"),
    msg("a1", "ok", "assistant"),
  ];
  return { messages, tokenCount: Math.round(limit * 0.96) };
}

test("terminalEscape fires after N consecutive stuck events (default 3)", () => {
  const core = createCore();
  const cfg = defaultConfig(100000);
  const { messages, tokenCount } = floorSession();

  const r1 = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount,
  });
  assert.equal(r1.terminalEscape, undefined);
  assert.equal(r1.state.terminalStreak, 1);
  assert.ok(r1.truncationSkipped, "zero-candidate diagnostic must be exposed");
  assert.match(r1.truncationSkipped!, /no truncatable content/);

  const r2 = core.processTurn({
    messages,
    state: r1.state,
    config: cfg,
    tokenCount,
  });
  assert.equal(r2.terminalEscape, undefined);
  assert.equal(r2.state.terminalStreak, 2);

  const r3 = core.processTurn({
    messages,
    state: r2.state,
    config: cfg,
    tokenCount,
  });
  assert.ok(
    r3.terminalEscape,
    "terminalEscape must fire on the 3rd stuck event",
  );
  assert.equal(r3.terminalEscape!.stuckEvents, 3);
  assert.match(
    r3.terminalEscape!.message,
    /compression cannot reduce this context below the limit/i,
  );
  assert.match(
    r3.terminalEscape!.message,
    /start a new session or use native compaction/i,
  );
  assert.ok(Math.abs(r3.terminalEscape!.usage - 0.96) < 0.01);
  assert.equal(r3.terminalEscape!.modelContextLimit, 100000);

  // maxPending is exposed for hosts/repro diagnostics (#300)
  assert.equal(r3.nudge!.breakdown.maxPending, 0);
});

test("terminalEscapeAfter is configurable; 0 disables the signal", () => {
  const core = createCore();
  const { messages, tokenCount } = floorSession();

  const fast = core.processTurn({
    messages,
    state: createInitialState(),
    config: defaultConfig(100000, {
      truncate: { threshold: 0.95, terminalEscapeAfter: 1 },
    }),
    tokenCount,
  });
  assert.ok(
    fast.terminalEscape,
    "terminalEscapeAfter:1 fires on the first event",
  );
  assert.equal(fast.terminalEscape!.stuckEvents, 1);

  const off = defaultConfig(100000, {
    truncate: { threshold: 0.95, terminalEscapeAfter: 0 },
  });
  let state = createInitialState();
  for (let i = 0; i < 4; i++) {
    const r = core.processTurn({ messages, state, config: off, tokenCount });
    assert.equal(r.terminalEscape, undefined, `turn ${i + 1}: disabled`);
    state = r.state;
  }
  assert.equal(state.terminalStreak, 4, "streak still tracked while disabled");
});

test("streak resets when usage drops below truncate.threshold", () => {
  const core = createCore();
  const cfg = defaultConfig(100000);
  const { messages } = floorSession();
  const hot = Math.round(100000 * 0.96);

  let state = createInitialState();
  for (let i = 0; i < 3; i++) {
    state = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: hot,
    }).state;
  }
  assert.equal(state.terminalStreak, 3);

  const cool = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: Math.round(100000 * 0.9),
  });
  assert.equal(cool.state.terminalStreak, 0);
  assert.equal(cool.terminalEscape, undefined);
});

test("successful applyCompression resets terminalStreak", () => {
  const core = createCore();
  const cfg = defaultConfig(100000);
  const messages: CoreMessage[] = [
    msg("u1", "x".repeat(20000)),
    msg("a1", "done", "assistant"),
  ];
  const state = stateWithRefs(messages);
  state.terminalStreak = 3;

  const out = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "User made a long request; assistant completed it fully.",
      },
    ],
    messages,
    state,
    config: cfg,
    protectedMessageIds: new Set<string>(),
  });
  assert.equal(out.result.blocksCreated, 1);
  assert.equal(out.state.terminalStreak, 0);
});

test("broadened truncation: oversized user/assistant text is a last-resort candidate", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const messages: CoreMessage[] = [
    msg("big-u", "T".repeat(30000)),
    msg("s1", "ok", "assistant"),
    msg("s2", "next"),
    msg("s3", "fine", "assistant"),
    msg("s4", "more"),
    msg("s5", "last", "assistant"),
  ];
  const base = {
    minOutputTokens: 1000,
    protectRecentMessages: 3,
  };

  const legacy = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    base,
  );
  assert.equal(legacy.truncatedCount, 0, "default behavior unchanged");
  assert.equal(legacy.candidatesFound, 0);

  const broad = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    { ...base, includeTextMessages: true },
  );
  assert.equal(broad.truncatedCount, 1);
  assert.ok(broad.savedTokens > 0);
  assert.ok(broad.messages[0]!.text!.includes("[truncated for context space"));
  assert.ok(!broad.messages[1]!.text!.includes("[truncated for context space"));
});

test("tool-results take priority over text (two-stage ordering)", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const messages: CoreMessage[] = [
    msg("tr1", "L".repeat(30000), "tool", "tool-result"),
    msg("tr2", "L".repeat(30000), "tool", "tool-result"),
    msg("txt", "T".repeat(30000), "assistant"),
    msg("p1", "recent"),
    msg("p2", "recent"),
    msg("p3", "recent"),
  ];
  const opts = {
    minOutputTokens: 1000,
    keepPrefixChars: 2000,
    keepSuffixChars: 2000,
    protectRecentMessages: 3,
    includeTextMessages: true,
  };

  const both = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    opts,
  );
  assert.equal(both.truncatedCount, 2, "both tool-results close the gap");
  assert.ok(!both.messages[2]!.text!.includes("[truncated for context space"));

  const single = truncateLargeToolOutputs(
    [messages[0]!, messages[2]!, messages[3]!, messages[4]!, messages[5]!],
    90000,
    cfg,
    (t) => t.length,
    opts,
  );
  assert.equal(
    single.truncatedCount,
    2,
    "text stage kicks in when tool results are insufficient",
  );
  assert.ok(single.messages[1]!.text!.includes("[truncated for context space"));
});

test("rendered block summaries and header-prefixed system text are never truncated", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });
  const summaryMsg = msg(
    "acp_summary_b1",
    "[Compressed conversation section]\n" + "Z".repeat(30000),
    "system",
  );
  const hostHeader = msg(
    "host-copy",
    "[Compressed conversation section] host copy " + "Y".repeat(30000),
    "system",
  );
  const messages: CoreMessage[] = [
    summaryMsg,
    hostHeader,
    msg("txt", "T".repeat(30000), "assistant"),
    msg("p1", "recent"),
    msg("p2", "recent"),
    msg("p3", "recent"),
  ];
  const result = truncateLargeToolOutputs(
    messages,
    90000,
    cfg,
    (t) => t.length,
    {
      minOutputTokens: 1000,
      protectRecentMessages: 3,
      includeTextMessages: true,
    },
  );
  assert.equal(result.truncatedCount, 1);
  assert.ok(
    !result.messages[0]!.text!.includes("[truncated for context space"),
  );
  assert.ok(
    !result.messages[1]!.text!.includes("[truncated for context space"),
  );
  assert.ok(result.messages[2]!.text!.includes("[truncated for context space"));
});

test("candidatesFound distinguishes zero candidates from unsavable candidates", () => {
  const cfg = defaultConfig(100000, { truncate: { threshold: 0.5 } });

  const none = truncateLargeToolOutputs(
    [msg("sys", "S".repeat(80000), "system")],
    90000,
    cfg,
    (t) => t.length,
    { minOutputTokens: 1000, includeTextMessages: true },
  );
  assert.equal(none.candidatesFound, 0);
  assert.equal(none.truncatedCount, 0);

  const short = truncateLargeToolOutputs(
    [
      msg("tr", "L".repeat(3000), "tool", "tool-result"),
      msg("p1", "recent"),
      msg("p2", "recent"),
      msg("p3", "recent"),
    ],
    90000,
    cfg,
    (t) => t.length,
    {
      minOutputTokens: 1000,
      keepPrefixChars: 2000,
      keepSuffixChars: 2000,
      protectRecentMessages: 3,
    },
  );
  assert.equal(short.candidatesFound, 1);
  assert.equal(
    short.truncatedCount,
    0,
    "prefix+suffix retention leaves nothing to save",
  );
});

test("processTurn broadens truncation: oversized assistant text truncated at >=95%", () => {
  const core = createCore();
  const cfg = defaultConfig(100000);
  const messages: CoreMessage[] = [
    msg("sys", "S".repeat(60000), "system"),
    msg("big-a", "A".repeat(40000), "assistant"),
    msg("u1", "hi"),
    msg("a2", "yo", "assistant"),
    msg("u2", "bye"),
    msg("a3", "see ya", "assistant"),
    msg("u3", "again"),
    msg("a4", "still here", "assistant"),
  ];
  const result = core.processTurn({
    messages,
    state: createInitialState(),
    config: cfg,
    tokenCount: 96000,
  });
  const truncated = result.messages.filter((m) =>
    m.text?.includes("[truncated for context space"),
  );
  assert.ok(
    truncated.some((m) => m.id === "big-a"),
    "assistant text truncated",
  );
  assert.ok(!truncated.some((m) => m.id === "sys"), "system prompt intact");
  assert.equal(
    result.terminalEscape,
    undefined,
    "truncation saved tokens -> not stuck",
  );
  assert.equal(result.state.terminalStreak, 0);
});
