// #5217: the EMERGENCY truncate latch keys clips by message ref, but
// BLOCKED_REF ("BLOCKED") is a SHARED sentinel — every protected message maps
// to it (refs.ts assignRefs), so many live raw ids resolve to the same key.
// A clip stored under "BLOCKED" therefore replays onto EVERY protected message
// in view, wholesale replacing their text: for tool-call messages that means
// function.arguments become unrelated prose (non-JSON → upstream 400 on every
// turn, permanent across restarts because the entry rides persisted state and
// its ref stays "live" while any protected message exists). Both directions are
// pinned here: no clip may be STORED under the sentinel, and a pre-existing
// poisoned entry must never be APPLIED — and must retire so already-poisoned
// sessions self-heal without a manual store edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { createInitialState } from "../src/state.js";
import type { CoreMessage } from "../src/types.js";

const WINDOW = 100_000;
// The protected tool-result is sized so ONE clip closes most but not all of
// the gap to the 90% target — the last-resort TEXT stage must then run too,
// giving the negative control its unprotected latched clip (#3939 two-stage
// applyTo: tool results first, text only if the target is still missed).
const BIG_RESULT = "bash-output ".repeat(3000); // ~36k chars, past the keep window
const BIG_TEXT = "gamma-delta ".repeat(6000); // unprotected oversized user text
const BASH_ARGS = JSON.stringify({ command: "cat big.log" });
const POISON =
  "<system-reminder>skill catalog text that must never replace other messages</system-reminder>";

// protectedTools pins the bash exchange onto the BLOCKED sentinel — the same
// state shape the incident had for the re-injected compress calls.
const cfg = () => ({ ...defaultConfig(WINDOW), protectedTools: ["bash"] });

function hist(): CoreMessage[] {
  return [
    { id: "raw-warm", role: "user", contentType: "text", text: "warmup user turn" },
    { id: "raw-warm-a", role: "assistant", contentType: "text", text: "ok" },
    { id: "raw-big-text", role: "user", contentType: "text", text: BIG_TEXT },
    {
      id: "raw-bash-call",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "call-1",
      text: BASH_ARGS,
    },
    {
      id: "raw-bash-result",
      role: "tool",
      contentType: "tool-result",
      toolName: "bash",
      toolCallId: "call-1",
      text: BIG_RESULT,
    },
    { id: "raw-tail1", role: "user", contentType: "text", text: "tail one" },
    { id: "raw-tail1-a", role: "assistant", contentType: "text", text: "ok" },
    { id: "raw-tail2", role: "user", contentType: "text", text: "tail two" },
    { id: "raw-tail2-a", role: "assistant", contentType: "text", text: "ok" },
  ];
}

test("store: a truncated PROTECTED message never latches its clip under the BLOCKED sentinel (#5217)", () => {
  const core = createCore(cfg());
  const t1 = core.processTurn({
    messages: hist(),
    state: createInitialState(),
    config: cfg(),
    tokenCount: 96_000,
    renderTags: "none",
  });
  const result = t1.messages.find((m) => m.id === "raw-bash-result")!;
  assert.ok(
    result.text!.includes("[truncated for context space]"),
    "the oversized protected tool-result IS clipped (incident precondition: truncation does not skip protected messages)",
  );
  assert.equal(
    t1.state.messageRefs.byRaw["raw-bash-result"],
    "BLOCKED",
    "protected message carries the shared sentinel ref",
  );
  assert.equal(t1.state.messageRefs.byRaw["raw-bash-call"], "BLOCKED");
  const latch = t1.state.emergencyTruncateLatch ?? [];
  assert.ok(
    !latch.some((e) => e.ref === "BLOCKED"),
    "no clip keyed by the BLOCKED sentinel",
  );
});

test("apply: a poisoned latch entry never rewrites live messages and retires on a sub-threshold turn (#5217)", () => {
  const core = createCore(cfg());
  const state = {
    ...createInitialState(),
    emergencyTruncateLatch: [{ ref: "BLOCKED", text: POISON }],
  };
  const t = core.processTurn({
    messages: hist(),
    state,
    config: cfg(),
    tokenCount: 60_000,
    renderTags: "none",
  });
  for (const m of t.messages) {
    assert.notEqual(m.text, POISON, `${m.id} must not carry the poison`);
  }
  assert.equal(
    t.messages.find((m) => m.id === "raw-bash-call")!.text,
    BASH_ARGS,
    "tool-call arguments stay byte-identical (valid JSON, no 400)",
  );
  assert.equal(
    t.state.emergencyTruncateLatch,
    undefined,
    "poison retires from persisted state without waiting for a fold",
  );
});

test("apply: at the watermark breach a poisoned entry neither applies nor persists (#5217)", () => {
  const core = createCore(cfg());
  const state = {
    ...createInitialState(),
    emergencyTruncateLatch: [{ ref: "BLOCKED", text: POISON }],
  };
  const t = core.processTurn({
    messages: hist(),
    state,
    config: cfg(),
    tokenCount: 96_000,
    renderTags: "none",
  });
  for (const m of t.messages) {
    assert.notEqual(m.text, POISON, `${m.id} must not carry the poison`);
  }
  // The incident symptom itself: non-JSON tool-call arguments → upstream 400.
  JSON.parse(t.messages.find((m) => m.id === "raw-bash-call")!.text!);
  assert.ok(
    t.messages
      .find((m) => m.id === "raw-bash-result")!
      .text!.includes("[truncated for context space]"),
    "the oversized result is still clipped this pass (availability preserved)",
  );
  const latch = t.state.emergencyTruncateLatch ?? [];
  assert.ok(!latch.some((e) => e.ref === "BLOCKED"), "poison does not persist past the pass");
});

test("negative control: numeric latch entries survive while only the sentinel entry retires (#5217)", () => {
  const core = createCore(cfg());
  const t1 = core.processTurn({
    messages: hist(),
    state: createInitialState(),
    config: cfg(),
    tokenCount: 96_000,
    renderTags: "none",
  });
  const clippedText = t1.messages.find((m) => m.id === "raw-big-text")!.text!;
  assert.ok(clippedText.includes("[truncated for context space]"), "unprotected oversized text is clipped");
  const latch1 = t1.state.emergencyTruncateLatch ?? [];
  assert.equal(latch1.length, 1, "exactly the unprotected clip is latched");
  assert.notEqual(latch1[0]!.ref, "BLOCKED");

  // Re-send with a poisoned entry injected beside the live numeric one.
  const t2 = core.processTurn({
    messages: hist(),
    state: {
      ...t1.state,
      emergencyTruncateLatch: [...latch1, { ref: "BLOCKED", text: POISON }],
    },
    config: cfg(),
    tokenCount: 60_000,
    renderTags: "none",
  });
  assert.equal(
    t2.messages.find((m) => m.id === "raw-big-text")!.text,
    clippedText,
    "numeric latch entry still replays byte-identically (sanitization is not over-broad)",
  );
  assert.equal(
    t2.messages.find((m) => m.id === "raw-bash-call")!.text,
    BASH_ARGS,
    "sentinel-keyed poison touches no live message",
  );
  const latch2 = t2.state.emergencyTruncateLatch ?? [];
  assert.deepEqual(latch2, latch1, "only the sentinel entry dropped");
});
