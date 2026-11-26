import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { isNeverPreserveRecent, matchToolPattern } from "../src/protected.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function seededState(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

// Eight messages m00001..m00008, all long enough to clear minCompressRange when
// several are combined.
const EIGHT = [
  msg("a", "first detailed message body content alpha"),
  msg("b", "second detailed message body content beta"),
  msg("c", "third detailed message body content gamma"),
  msg("d", "fourth detailed message body content delta"),
  msg("e", "fifth detailed message body content epsilon"),
  msg("f", "sixth detailed message body content zeta"),
  msg("g", "seventh detailed message body content eta"),
  msg("h", "eighth detailed message body content theta"),
];

test("applyCompression no-ops when the range is ENTIRELY within the recent zone", () => {
  const core = createCore();
  const messages = [...EIGHT];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // m00006..m00008 are the last 3 → entirely protected. After filtering there
  // is nothing left to compress. #4521: that is the idempotent no-op class —
  // the range was legal to request (it aimed at the newest tail, exactly the
  // messages the model just produced), so refusing it whole-batch only fed
  // retry livelocks. Zero blocks, zero errors, guidance in warnings[].
  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00006",
        endRef: "m00008",
        summary: "trying to compress the recent zone",
        topic: "bad",
      },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(result.result.blocksCreated, 0, "no block created");
  assert.equal(result.result.errors.length, 0, "no failure — nothing was left to fold");
  assert.equal(result.result.noop, true, "flagged as the no-op class");
  assert.match(
    result.result.warnings.join(" "),
    /protected zone/i,
    `warning should mention the protected recent zone, got: ${JSON.stringify(result.result.warnings)}`,
  );
  assert.match(result.result.warnings.join(" "), /do not resend this range/);
});

test("applyCompression excludes protected tail and compresses the rest (partial overlap)", () => {
  const core = createCore();
  const messages = [...EIGHT];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // m00005 is outside the zone, m00006..m00007 are inside. The unprotected
  // head (m00005) must still be compressed; the protected tail is excluded
  // and surfaced as a warning rather than failing the whole range.
  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00005",
        endRef: "m00007",
        summary: "overlapping the recent zone",
        topic: "partial",
      },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(
    result.result.blocksCreated,
    1,
    "unprotected head still compressed",
  );
  assert.equal(
    result.result.errors.length,
    0,
    "no error — overlap is non-fatal",
  );
  assert.equal(result.result.warnings.length, 1, "a warning is surfaced");
  assert.match(result.result.warnings[0]!, /Excluded.*protected.*m0000[67]/i);
  // The created block must NOT cover the protected messages.
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.ok(
    !block.effectiveMessageIds.includes("f"),
    "m00006 raw id not covered",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("g"),
    "m00007 raw id not covered",
  );
  assert.ok(
    block.directMessageIds.includes("e"),
    "m00005 raw id IS compressed",
  );
});

test("applyCompression excludes the most recent user message and compresses the rest", () => {
  const core = createCore();
  // Preserve only 1 recent message; the last user message (m00003) is still
  // protected by Rule 3. The assistant message m00002 is compressible.
  const messages = [
    msg("a", "u1 text alpha", "user"),
    msg("b", "assistant reply beta", "assistant"),
    msg("c", "u2 text gamma — the latest user message", "user"),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 1 });

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00002",
        endRef: "m00003",
        summary: "grabbing the last user msg",
        topic: "partial",
      },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(
    result.result.blocksCreated,
    1,
    "assistant msg still compressed",
  );
  assert.equal(result.result.errors.length, 0);
  assert.equal(result.result.warnings.length, 1);
  assert.match(result.result.warnings[0]!, /Excluded.*protected.*m00003/i);
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.ok(block.directMessageIds.includes("b"), "m00002 compressed");
  assert.ok(!block.effectiveMessageIds.includes("c"), "m00003 stays visible");
});

test("applyCompression still allows compressing messages strictly before the recent zone", () => {
  const core = createCore();
  const messages = [...EIGHT];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // m00001..m00003 are well before the last 3 (m00006..m00008) → must succeed.
  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00003",
        summary: "compressing older messages is allowed",
        topic: "ok",
      },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(
    result.result.blocksCreated,
    1,
    "older range still compressible",
  );
  assert.equal(result.result.errors.length, 0);
  assert.equal(
    result.result.warnings.length,
    0,
    "no warnings for a clean range",
  );
});

test("applyCompression no-ops by default when the whole range is protected (no explicit set)", () => {
  // No explicit protectedMessageIds passed — applyCompression must compute the
  // soft-protected zone itself (recent-N + last user message). When the entire
  // range falls in that zone it folds nothing — #4521 no-op class, not a
  // failure (the zone always stays visible; refusing it fed retry loops).
  const core = createCore();
  const messages = [
    msg("a", "old user msg alpha", "user"),
    msg("b", "old assistant beta", "assistant"),
    msg("c", "current user intent gamma", "user"),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 2 });

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00002",
        endRef: "m00003",
        summary: "should be refused by default protection",
        topic: "bad",
      },
    ],
    messages,
    state,
    config: cfg,
    // intentionally NO protectedMessageIds
  });

  assert.equal(
    result.result.blocksCreated,
    0,
    "default protection applies without explicit set",
  );
  assert.equal(result.result.errors.length, 0);
  assert.equal(result.result.noop, true);
  assert.match(result.result.warnings.join(" "), /protected zone/i);
});

// --- decompress results are excluded from the recent-protected zone ---

function toolResult(
  id: string,
  toolName: string,
  text: string,
  toolCallId = "tc-" + id,
): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName,
    toolCallId,
    text,
  };
}

test("computeProtectedRefs excludes decompress tool results from the recent zone", async () => {
  // A decompress tool result sits at the tail. Without the NEVER_PRESERVE_RECENT
  // exclusion it would occupy the recent-N window and become un-compressible.
  const { computeProtectedRefs } = await import("../src/recommend.js");
  const messages: CoreMessage[] = [
    msg("a", "old alpha", "user"),
    msg("b", "old beta", "assistant"),
    msg("c", "old gamma", "user"),
    toolResult("d", "decompress", "x".repeat(20000)),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  const protectedRefs = computeProtectedRefs(messages, state, cfg);
  // m00004 is the decompress result — must NOT be in the protected zone.
  assert.ok(
    !protectedRefs.has("m00004"),
    "decompress result not protected by recent zone",
  );
  // The last USER message (m00003) is still protected by Rule 3.
  assert.ok(protectedRefs.has("m00003"), "last user message still protected");
});

test("applyCompression can compress a decompress tool result in the recent tail", () => {
  // The decompress result is the last message (within preserveRecentMessages=3).
  // It must still be compressible because it is excluded from the protected zone.
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", "first message alpha", "user"),
    msg("b", "second message beta", "assistant"),
    msg("c", "third message gamma", "user"),
    toolResult("d", "decompress", "restored content " + "x".repeat(200)),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00004",
        endRef: "m00004",
        summary: "compressing the decompress result",
        topic: "reclaim",
      },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.equal(
    result.result.blocksCreated,
    1,
    "decompress result is compressible despite being in the tail",
  );
  assert.equal(result.result.errors.length, 0);
  assert.equal(
    result.result.warnings.length,
    0,
    "no warning — it is genuinely outside the protected zone",
  );
});

test("warnings accumulate across multiple ranges in one batch", () => {
  const core = createCore();
  const messages = [
    ...EIGHT,
    msg("i", "ninth message iota", "user"),
    msg("j", "tenth message kappa", "assistant"),
  ];
  const state = seededState(messages);
  const cfg = config({ preserveRecentMessages: 3 });

  // Two ranges: the second now ends inside the recent zone, which under the
  // #3939 all-or-nothing contract would reject the whole batch (a fully-
  // protected range is a fatal apply error, pinned in issue3939-fold-boundary-
  // pins.test.ts), so it instead OVERLAPS the first range's span — overlap
  // warn+skip keeps the batch valid while still exercising multi-range
  // warning accumulation.
  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00004",
        endRef: "m00009",
        summary: "first partial range summary",
        topic: "a",
      },
      {
        startRef: "m00008",
        endRef: "m00010",
        summary: "second range overlaps the first",
        topic: "b",
      },
    ],
    messages,
    state,
    config: cfg,
  });

  assert.ok(
    result.result.blocksCreated >= 1,
    "at least the unprotected head compresses",
  );
  assert.ok(result.result.warnings.length >= 2, "warnings surfaced");
});

// --- neverPreserveRecentTools is configurable (billion-context#1277) ---

test("isNeverPreserveRecent defaults to the built-in list when patterns is omitted", () => {
  for (const name of ["decompress", "search_context", "read", "bash"]) {
    assert.equal(
      isNeverPreserveRecent(toolResult("x", name, "body")),
      true,
      `${name} excluded by default`,
    );
  }
  assert.equal(
    isNeverPreserveRecent(toolResult("y", "grep", "hits")),
    false,
    "other tools not excluded by default",
  );
  assert.equal(
    isNeverPreserveRecent(msg("z", "plain text")),
    false,
    "non-tool messages never excluded",
  );
});

test("isNeverPreserveRecent honors an explicit pattern list (glob suffix included)", () => {
  const readResult = toolResult("a", "read", "file body");
  const bashResult = toolResult("b", "bash", "output");
  const readFileResult = toolResult("c", "read_file", "file body");

  // An explicit list replaces the built-in default verbatim.
  assert.equal(isNeverPreserveRecent(bashResult, ["bash"]), true);
  assert.equal(
    isNeverPreserveRecent(readResult, ["bash"]),
    false,
    "read no longer excluded once the list is explicit",
  );
  // The empty list excludes nothing.
  assert.equal(isNeverPreserveRecent(readResult, []), false);
  assert.equal(isNeverPreserveRecent(bashResult, []), false);
  // Glob-suffix matching has the same semantics as protectedTools.
  assert.equal(isNeverPreserveRecent(readFileResult, ["read*"]), true);
  assert.equal(isNeverPreserveRecent(readResult, ["read*"]), true);
});

test("computeProtectedRefs flips recent-zone membership per configured list", async () => {
  const { computeProtectedRefs } = await import("../src/recommend.js");
  const messages: CoreMessage[] = [
    msg("a", "old alpha", "user"),
    msg("b", "old beta", "assistant"),
    msg("c", "old gamma", "user"),
    toolResult("d", "read", "x".repeat(20000)),
    msg("e", "latest user intent", "user"),
  ];
  const state = seededState(messages);

  // Default (field unset): read stays out of the zone → compressible in place.
  let refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 3 }),
  );
  assert.ok(
    !refs.has("m00004"),
    "default list keeps the read result outside the zone",
  );

  // Explicit list WITHOUT read: the replacement drops read's exclusion, so the
  // fresh read result is back inside the zone (this is the #1198 trade-off
  // users opt into).
  refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 3, neverPreserveRecentTools: ["bash"] }),
  );
  assert.ok(
    refs.has("m00004"),
    "explicit list without read gives the read result recent-zone protection",
  );

  // Explicit list WITH read: same as default for this message.
  refs = computeProtectedRefs(
    messages,
    state,
    config({
      preserveRecentMessages: 3,
      neverPreserveRecentTools: ["read", "bash"],
    }),
  );
  assert.ok(
    !refs.has("m00004"),
    "explicit list containing read keeps it compressible",
  );

  // Empty list: nothing excluded → the fresh read result sits IN the zone.
  refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 3, neverPreserveRecentTools: [] }),
  );
  assert.ok(
    refs.has("m00004"),
    "empty list gives the fresh read result full recent-zone protection",
  );
});

test("applyCompression A/B: empty list protects a fresh read result; default reclaims it immediately", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", "first message alpha", "user"),
    msg("b", "second message beta", "assistant"),
    msg("c", "third message gamma", "user"),
    toolResult("d", "read", "freshly read file body " + "x".repeat(200)),
    msg("e", "fourth message epsilon", "assistant"),
    msg("f", "fifth message zeta", "user"),
  ];
  // With preserveRecentMessages=3 and nothing excluded, visible tail = d,e,f
  // → m00004 is inside the protected zone under the empty list.
  // #4521: zone-only range = idempotent no-op (0 blocks, 0 errors, warning)
  // — still "protected with empty exclusion list", just not a failure.
  const refused = core.applyCompression({
    ranges: [
      {
        startRef: "m00004",
        endRef: "m00004",
        summary: "should be refused while in the recent zone",
        topic: "fresh",
      },
    ],
    messages,
    state: seededState(messages),
    config: config({ preserveRecentMessages: 3, neverPreserveRecentTools: [] }),
  });
  assert.equal(
    refused.result.blocksCreated,
    0,
    "fresh read result protected with empty exclusion list",
  );
  assert.equal(refused.result.errors.length, 0);
  assert.equal(refused.result.noop, true);
  assert.match(refused.result.warnings.join(" "), /protected zone/i);

  // Same session shape under the default list: read is out of the zone → reclaimable now.
  const allowed = core.applyCompression({
    ranges: [
      {
        startRef: "m00004",
        endRef: "m00004",
        summary: "reclaiming the spent read result",
        topic: "reclaim",
      },
    ],
    messages,
    state: seededState(messages),
    config: config({ preserveRecentMessages: 3 }),
  });
  assert.equal(
    allowed.result.blocksCreated,
    1,
    "default list still reclaims the read result immediately",
  );
  assert.equal(allowed.result.errors.length, 0);
});

test("empty list: a read result ages OUT of the recent zone and becomes compressible again", () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", "first message alpha", "user"),
    msg("b", "second message beta", "assistant"),
    msg("c", "third message gamma", "user"),
    toolResult("d", "read", "spent file body " + "x".repeat(200)),
    msg("e", "fourth message epsilon", "assistant"),
    msg("f", "fifth message zeta", "user"),
    msg("g", "sixth message eta", "assistant"),
    msg("h", "seventh message theta", "user"),
  ];
  const state = seededState(messages);
  // visible tail = f,g,h → m00004 has aged out of the last-3 window.
  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00004",
        endRef: "m00004",
        summary: "aging out of the zone",
        topic: "aged",
      },
    ],
    messages,
    state,
    config: config({ preserveRecentMessages: 3, neverPreserveRecentTools: [] }),
  });
  assert.equal(
    result.result.blocksCreated,
    1,
    "aged-out read result compressible even with empty exclusion list",
  );
  assert.equal(result.result.errors.length, 0);
});

test("validateConfig rejects a non-string-array neverPreserveRecentTools", () => {
  assert.deepEqual(
    validateConfig(
      defaultConfig(200000, {
        neverPreserveRecentTools: [1] as unknown as string[],
      }),
    ),
    ["neverPreserveRecentTools must be a string array"],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(200000, { neverPreserveRecentTools: ["read"] }),
    ),
    [],
  );
  assert.deepEqual(
    validateConfig(defaultConfig(200000, { neverPreserveRecentTools: [] })),
    [],
  );
  assert.deepEqual(
    validateConfig(defaultConfig(200000)),
    [],
    "unset stays valid (built-in default applies)",
  );
});

// --- preserveRecentTools: positive-facing subtraction knob (#1198/#1277) ----

test("preserveRecentTools subtracts from the built-in list without restating it", async () => {
  const { computeProtectedRefs } = await import("../src/recommend.js");
  const messages = [
    msg("a", "first message alpha"),
    msg("b", "second message beta"),
    msg("c", "third message gamma"),
    toolResult("d", "read", "freshly read file body " + "x".repeat(200)),
    msg("e", "fourth message epsilon"),
    msg("f", "fifth message zeta"),
  ];
  const state = seededState(messages);

  // Default: read is excluded from the zone → not protected.
  let refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 3 }),
  );
  assert.ok(
    !refs.has("m00004"),
    "default list keeps the fresh read result compressible",
  );

  // One-entry positive override: protect read, rest of the built-in untouched.
  refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 3, preserveRecentTools: ["read"] }),
  );
  assert.ok(
    refs.has("m00004"),
    'preserveRecentTools:["read"] gives the read result zone protection',
  );

  // A bash result at the same position stays excluded — only read was subtracted.
  const bashMessages = [
    msg("a", "first message alpha"),
    msg("b", "second message beta"),
    msg("c", "third message gamma"),
    toolResult("d", "bash", "command output " + "x".repeat(200)),
    msg("e", "fourth message epsilon"),
    msg("f", "fifth message zeta"),
  ];
  refs = computeProtectedRefs(
    bashMessages,
    seededState(bashMessages),
    config({ preserveRecentMessages: 3, preserveRecentTools: ["read"] }),
  );
  assert.ok(
    !refs.has("m00004"),
    "bash stays excluded — the subtraction is per-tool",
  );
});

test("preserveRecentTools combines with an explicit neverPreserveRecentTools list", async () => {
  const { computeProtectedRefs } = await import("../src/recommend.js");
  const messages = [
    msg("a", "first message alpha"),
    msg("b", "second message beta"),
    msg("c", "third message gamma"),
    toolResult("d", "read", "freshly read file body " + "x".repeat(200)),
    toolResult("e", "bash", "command output " + "y".repeat(200)),
    msg("f", "fifth message zeta"),
  ];
  const state = seededState(messages);
  const cfg = config({
    preserveRecentMessages: 3,
    neverPreserveRecentTools: ["read", "bash"],
    preserveRecentTools: ["read"],
  });
  const refs = computeProtectedRefs(messages, state, cfg);
  assert.ok(
    refs.has("m00004"),
    "read protected: subtracted from the explicit list",
  );
  assert.ok(
    !refs.has("m00005"),
    "bash still excluded: not in preserveRecentTools",
  );
});

test("preserveRecentTools supports glob suffixes and tolerates empty/no-match", async () => {
  const { computeProtectedRefs } = await import("../src/recommend.js");
  const messages = [
    msg("a", "first message alpha"),
    msg("b", "second message beta"),
    msg("c", "third message gamma"),
    toolResult("d", "bash", "command output " + "x".repeat(200)),
    msg("e", "fourth message epsilon"),
    msg("f", "fifth message zeta"),
  ];
  const state = seededState(messages);
  let refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 3, preserveRecentTools: ["bash*"] }),
  );
  assert.ok(
    refs.has("m00004"),
    "glob pattern bash* removes the built-in bash entry",
  );

  refs = computeProtectedRefs(
    messages,
    state,
    config({
      preserveRecentMessages: 3,
      preserveRecentTools: ["nonexistent_tool"],
    }),
  );
  assert.ok(!refs.has("m00004"), "no-match preserve pattern is a no-op");

  refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 3, preserveRecentTools: [] }),
  );
  assert.ok(
    !refs.has("m00004"),
    "empty preserve array is a no-op, not protect-everything",
  );
});

test('applyCompression: preserveRecentTools ["read"] is the one-line #1198 remedy', () => {
  const core = createCore();
  const messages: CoreMessage[] = [
    msg("a", "first message alpha"),
    msg("b", "second message beta"),
    msg("c", "third message gamma"),
    toolResult("d", "read", "freshly read file body " + "x".repeat(200)),
    msg("e", "fourth message epsilon"),
    msg("f", "fifth message zeta"),
  ];
  const refused = core.applyCompression({
    ranges: [
      {
        startRef: "m00004",
        endRef: "m00004",
        summary: "fold the fresh read",
        topic: "read",
      },
    ],
    messages,
    state: seededState(messages),
    config: config({
      preserveRecentMessages: 3,
      preserveRecentTools: ["read"],
    }),
  });
  assert.equal(
    refused.result.blocksCreated,
    0,
    "fresh read result protected by the subtraction knob",
  );
  // #4521: protection verdict lives in warnings (no-op class), not errors.
  assert.equal(refused.result.errors.length, 0);
  assert.equal(refused.result.noop, true);
  assert.match(refused.result.warnings.join(" "), /protected zone/i);
});

test("validateConfig checks preserveRecentTools shape and accepts []", () => {
  const bad = config({ preserveRecentTools: [42] as unknown as string[] });
  assert.ok(
    validateConfig(bad).some((e) => /preserveRecentTools/.test(e)),
    "non-string array rejected",
  );
  const empty = config({ preserveRecentTools: [] });
  assert.ok(
    !validateConfig(empty).some((e) => /preserveRecentTools/.test(e)),
    "empty array is a tolerated no-op",
  );
});

// --- case-insensitive tool-name matching across client casings (billion-context#1725) ---

test("matchToolPattern is case-insensitive for exact names", () => {
  assert.equal(
    matchToolPattern("read", "read"),
    true,
    "exact-case still matches",
  );
  assert.equal(matchToolPattern("Read", "read"), true, "tool casing differs");
  assert.equal(
    matchToolPattern("read", "READ"),
    true,
    "pattern casing differs",
  );
  assert.equal(matchToolPattern("BASH", "bash"), true);
  assert.equal(
    matchToolPattern("Grep", "read"),
    false,
    "different name still no match",
  );
});

test("matchToolPattern is case-insensitive for trailing-* glob prefixes", () => {
  assert.equal(matchToolPattern("ReadFile", "read*"), true);
  assert.equal(matchToolPattern("READ_FILE", "read*"), true);
  assert.equal(matchToolPattern("search_context", "SEARCH*"), true);
  assert.equal(matchToolPattern("write_file", "read*"), false);
});

test("isNeverPreserveRecent excludes capitalized built-in results by default (#1725)", () => {
  // Before the fix these all returned false (results stuck in the protected zone).
  assert.equal(
    isNeverPreserveRecent(toolResult("a", "Read", "body")),
    true,
    "Read excluded by default",
  );
  assert.equal(
    isNeverPreserveRecent(toolResult("b", "Bash", "out")),
    true,
    "Bash excluded by default",
  );
  assert.equal(isNeverPreserveRecent(toolResult("c", "DECOMPRESS", "x")), true);
  assert.equal(
    isNeverPreserveRecent(toolResult("d", "grep", "hits")),
    false,
    "non-listed tool unaffected",
  );
});

test("preserveRecentTools subtraction works regardless of casing (#1725)", () => {
  const readMsg = toolResult("a", "Read", "body");
  assert.equal(
    isNeverPreserveRecent(readMsg),
    true,
    "Read excluded by default",
  );
  // Before the fix this override was a silent no-op for a differently-cased name.
  assert.equal(
    isNeverPreserveRecent(readMsg, undefined, ["READ"]),
    false,
    'preserve ["READ"] re-protects the Read result',
  );
});

test("computeProtectedRefs keeps a fresh capitalized Read result compressible (#1725)", async () => {
  const { computeProtectedRefs } = await import("../src/recommend.js");
  const messages: CoreMessage[] = [
    msg("a", "old alpha", "user"),
    msg("b", "old beta", "assistant"),
    msg("c", "old gamma", "user"),
    toolResult("d", "Read", "x".repeat(20000)),
    msg("e", "latest user intent", "user"),
  ];
  const state = seededState(messages);
  const refs = computeProtectedRefs(
    messages,
    state,
    config({ preserveRecentMessages: 3 }),
  );
  assert.ok(
    !refs.has("m00004"),
    "capitalized Read result stays outside the protected recent zone by default",
  );
});
