// #2419: host-declared message-level hard protection (Config.isMessageProtected).
// The dsh skill catalog rides as an ordinary user-role text message and DSH
// never resends it while its fingerprint is unchanged — folding it loses skill
// visibility permanently. These tests pin the generic mechanism: any message
// matching the host predicate is excluded from compression exactly like a
// protectedTools hit, for every content type, in both the assignRefs path
// (BLOCKED ref — never advertised) and the applyCompression path (excluded
// from effectiveMessageIds — stays visible).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs, BLOCKED_REF } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import type { Config, CoreMessage } from "../src/types.js";

const CATALOG_MARKER = "\x3cavailable_skills\x3e";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function setupRefs(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

const longText = "x".repeat(6000);
const catalogText = `\x3csystem-reminder\x3e ${CATALOG_MARKER} skill-a: does A; skill-b: does B \x3c/system-reminder\x3e`;
const validSummary =
  "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

function cfg(overrides: Partial<Config> = {}): Config {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    ...overrides,
  });
}

const catalogGuard = (m: CoreMessage) =>
  m.contentType === "text" && m.text?.includes(CATALOG_MARKER) === true;

test("isMessageProtected: predicate-protected user text message is excluded from the range", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    msg("catalog", catalogText),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({ isMessageProtected: catalogGuard });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: validSummary }],
    messages,
    state,
    config,
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("catalog"),
    "catalog must be excluded from the compressed set",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("catalog"),
    "catalog must be excluded from effective coverage (stays visible)",
  );
  assert.ok(block.directMessageIds.includes("a"), "regular msg 'a' folded");
  assert.ok(block.directMessageIds.includes("d"), "regular msg 'd' folded");
  assert.equal(
    block.summary,
    validSummary,
    "summary is exactly what the author wrote — no protected content appended",
  );
});

test("isMessageProtected: applies to every content type, not just user text", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    msg("assistant-catalog", catalogText, "assistant"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({ isMessageProtected: catalogGuard });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.effectiveMessageIds.includes("assistant-catalog"),
    "assistant-role message matching the predicate is protected too",
  );
  assert.ok(block.effectiveMessageIds.includes("a"), "msg 'a' folded");
  assert.ok(block.effectiveMessageIds.includes("d"), "msg 'd' folded");
});

test("isMessageProtected: without the predicate the same message folds normally", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    msg("catalog", catalogText),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg(); // no isMessageProtected

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    block.effectiveMessageIds.includes("catalog"),
    "unset predicate = byte-identical behavior: catalog folds like any other message",
  );
});

test("isMessageProtected: predicate-protected message gets a BLOCKED ref via processTurn (never advertised)", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    msg("catalog", catalogText),
    msg("d", longText),
  ];
  const state = createInitialState();
  const config = cfg({ isMessageProtected: catalogGuard });

  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 1000,
  });

  assert.equal(
    turn.state.messageRefs.byRaw["catalog"],
    BLOCKED_REF,
    "protected message must carry the BLOCKED ref (no mNNNNN allocated)",
  );
  assert.notEqual(
    turn.state.messageRefs.byRaw["a"],
    BLOCKED_REF,
    "unprotected message keeps a normal ref",
  );
  assert.notEqual(
    turn.state.messageRefs.byRaw["d"],
    BLOCKED_REF,
    "unprotected message keeps a normal ref",
  );
});

test("isMessageProtected: legacy refs assigned before protection still cannot be folded (upgrade path)", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    msg("catalog", catalogText),
    msg("d", longText),
  ];
  // Simulates a session whose state predates the guard: refs were assigned
  // with NO protection, so the catalog holds a live m-ref.
  const state = setupRefs(messages);
  assert.notEqual(state.messageRefs.byRaw["catalog"], BLOCKED_REF);
  const config = cfg({ isMessageProtected: catalogGuard });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.effectiveMessageIds.includes("catalog"),
    "pre-existing ref does not make the message foldable once protected",
  );
  assert.ok(block.effectiveMessageIds.includes("a"), "msg 'a' folded");
  assert.ok(block.effectiveMessageIds.includes("d"), "msg 'd' folded");
});

test("isMessageProtected: range consisting solely of protected messages fails with a clear error", () => {
  const core = createCore();
  const messages = [msg("catalog", catalogText)];
  const state = setupRefs(messages);
  const config = cfg({ isMessageProtected: catalogGuard });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00001", summary: validSummary }],
    messages,
    state,
    config,
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may be created");
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /no compressible messages/,
    "an entirely-protected range must fail loudly, not fake-compress",
  );
});
