// #5109: hosts like dsh splice machine reminders (clock readings, progress
// rules) into the user channel AFTER the real request, so the literal "last
// user message" is often an injection. Pinning the injection strands the real
// request outside the protected recent zone, where an intra-turn fold drops
// it and the model answers from history instead of the live ask. The fix:
// the Rule-3 anchor skips host-declared injection carriers
// (virtualToolPathOf) — refusal of the anchor role ONLY, foldability is
// untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import { lastUserAnchor } from "../src/protected.js";
import { computeProtectedRefs } from "../src/recommend.js";
import type { CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function setup(messages: CoreMessage[]): {
  core: ReturnType<typeof createCore>;
  state: ReturnType<typeof createInitialState>;
} {
  const core = createCore();
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  return { core, state };
}

// The dsh time-context shape (deepseek-ai/deepseek-harness
// packages/context/time-context renderText; classified by the host as
// injected/time-context).
const CLOCK = "Time sampled while preparing turn 3, step 2: 2026-10-29T12:00:00.000Z\nElapsed since the preceding turn: 45s";

test("lastUserAnchor skips host-declared injections, covered ids, and summary carriers", () => {
  const covered = new Set(["p3"]);
  const config = {
    messagePathOf: (m: CoreMessage) =>
      m.id === "p8" || m.id === "p2" ? "injected/time-context" : undefined,
  };
  const messages: CoreMessage[] = [
    msg("p1", "earliest user", "user"),
    msg("p2", "injection before any real ask", "user"), // classified → skipped
    msg("p3", "already folded", "user"), // covered → skipped
    msg("p4", "assistant reply", "assistant"), // wrong role → skipped
    msg("p5", "real human request", "user"),
    msg("p6", "assistant ack", "assistant"),
    msg("p7", "[Compressed conversation section] — stale topic\nbody", "user"), // summary carrier → skipped
    msg("p8", CLOCK, "user"), // classified injection → skipped
  ];
  const anchor = lastUserAnchor(messages, covered, config);
  assert.equal(anchor?.id, "p5", "anchor is the newest HUMAN user request");

  const allInjected = { messagePathOf: () => "injected/time-context" };
  assert.equal(
    lastUserAnchor([msg("i1", CLOCK, "user")], new Set(), allInjected)?.id,
    undefined,
    "all-injection tail yields no anchor",
  );
});

test("Rule 3 protects the real user request, not the host injection after it (#5109)", () => {
  const messages: CoreMessage[] = [
    msg("p1", "old question", "user"),
    msg("p2", "old answer", "assistant"),
    msg("p3", "current live request: run the migration", "user"),
    msg("p4", CLOCK, "user"), // injection AFTER the real ask — old bug pinned THIS
    msg("p5", "assistant starts working", "assistant"),
  ];
  const { state } = setup(messages);
  const cfg = defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 });
  cfg.messagePathOf = (m: CoreMessage) => (m.id === "p4" ? "injected/time-context" : undefined);
  const protectedRefs = computeProtectedRefs(messages, state, cfg);
  assert.ok(protectedRefs.has("m00003"), "real user request is the protected anchor");
  assert.ok(!protectedRefs.has("m00004"), "injection is NOT protected by Rule 3 (stays foldable)");
});

test("no host classifier configured → anchor stays the literal last user message (byte-compatible)", () => {
  const messages: CoreMessage[] = [
    msg("p1", "question", "user"),
    msg("p2", "answer", "assistant"),
    msg("p3", "plain follow-up", "user"),
  ];
  const { state } = setup(messages);
  const cfg = defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 });
  const protectedRefs = computeProtectedRefs(messages, state, cfg);
  assert.ok(protectedRefs.has("m00003"), "literal last user message still protected");
});

test("fold receipt names the anchor when the zone brushes the protected range (#5109 diagnostics)", () => {
  // p7 = real request, p8 = classified injection, p9 = assistant reply.
  // Range m00002..m00008 covers p7 interior → #3953 truncation + the new
  // Last-user anchor line. p8 folds with the tail only if not protected —
  // here it survives via the #3953 truncation, and the receipt says which
  // message holds the anchor.
  const { core, state, messages } = (() => {
    const all: CoreMessage[] = [
      msg("p1", "start user body ".repeat(120), "user"),
      msg("p2", "body two ".repeat(120), "assistant"),
      msg("p3", "body three ".repeat(120), "user"),
      msg("p4", "body four ".repeat(120), "assistant"),
      msg("p5", "body five ".repeat(120), "user"),
      msg("p6", "body six ".repeat(120), "assistant"),
      msg("p7", "current live request: run the migration now", "user"),
      msg("p8", CLOCK, "user"),
      msg("p9", "assistant starts working", "assistant"),
    ];
    const s = setup(all);
    return { ...s, messages: all };
  })();
  const cfg = defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 });
  cfg.messagePathOf = (m: CoreMessage) => (m.id === "p8" ? "injected/time-context" : undefined);
  const result = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00008", summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
    messages,
    state,
    config: cfg,
  });
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks.find((b) => b.active)!;
  assert.ok(!block.effectiveMessageIds.includes("p7"), "real request never folds");
  const warn = result.result.warnings.find((w) => w.startsWith("Excluded"));
  assert.ok(warn, `expected an exclusion warning, got: ${JSON.stringify(result.result.warnings)}`);
  assert.match(warn, /Last-user anchor: m00007 "current live request: run the migration "/, "receipt names the anchor ref + first 40 chars");
});
