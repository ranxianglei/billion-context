// #3939 ③ / #3691: emergency truncation is a one-shot decision that must stay
// byte-stable across turns. The pre-latch node re-evaluated the watermark on
// every turn against the resent FULL history, so a fluctuating token estimate
// (95%+ one turn, below the next) flipped the same user text between its full
// and clipped forms every turn — a mid-history rewrite on every request and a
// prefix-cache breaker. The latch pins the clipped bytes until a fold resets
// them (#3939 contract: 水位触发 clip 后保持 clip 直到折叠事件重置).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { createInitialState } from "../src/state.js";
import type { CoreMessage } from "../src/types.js";

const BIG = "alpha-beta ".repeat(4000); // ~48k chars, well past prefix+suffix
// Roomy filler so a fold spanning the whole history clears the 5000-char
// min-range gate even after the big text is clipped (~4.1K).
const filler = (t: string) => `filler ${t} ` + "x".repeat(800);
const tiny = (t: string): CoreMessage[] => [
  { id: `raw-${t}`, role: "user", contentType: "text", text: "hi " + t + " " + filler(t) },
  { id: `raw-${t}-a`, role: "assistant", contentType: "text", text: "ok " + t },
];

function hist(): CoreMessage[] {
  return [
    ...tiny("warm"),
    { id: "raw-big", role: "user", contentType: "text", text: BIG },
    ...tiny("tail1"),
    ...tiny("tail2"),
    ...tiny("tail3"),
    ...tiny("tail4"),
  ];
}

const WINDOW = 100_000;
// Narrow the recent-token protection so a unit-scale history still has a
// foldable head (default preserveRecentTokens=5000 swallows this whole fixture
// and every range dies in the protected zone). The latch logic under test is
// orthogonal to the protected-zone math.
const cfg = () => ({ ...defaultConfig(WINDOW), preserveRecentTokens: 100 });

test("pin: a clip fires at 96% and the latch replays it on the next under-watermark turn (#3691)", () => {
  const core = createCore(defaultConfig(WINDOW));
  const messages = hist();

  const t1 = core.processTurn({
    messages,
    state: createInitialState(),
    config: defaultConfig(WINDOW),
    tokenCount: 96_000,
    renderTags: "none",
  });
  const clipped1 = t1.messages.find((m) => m.id === "raw-big")!.text!;
  assert.ok(clipped1.includes("[truncated for context space]"), "turn 1 clips the oversized text");
  assert.ok(t1.state.emergencyTruncateLatch?.some((e) => e.text === clipped1), "clip is latched");

  // Turn 2: SAME full history resent, estimate now well under the watermark —
  // pre-latch this returned the full text (the #3691 oscillation).
  const t2 = core.processTurn({
    messages: hist(),
    state: t1.state,
    config: defaultConfig(WINDOW),
    tokenCount: 60_000,
    renderTags: "none",
  });
  const clipped2 = t2.messages.find((m) => m.id === "raw-big")!.text!;
  assert.equal(clipped2, clipped1, "latch replays the byte-identical clip under the watermark");
  assert.ok(t2.state.emergencyTruncateLatch?.some((e) => e.text === clipped1), "latch self-perpetuates while the message stays live");
});

test("pin: a successful fold resets the latch and the clip retires with the fold", () => {
  const core = createCore(cfg());
  const t1 = core.processTurn({
    messages: hist(),
    state: createInitialState(),
    config: cfg(),
    tokenCount: 96_000,
    renderTags: "none",
  });
  assert.ok(t1.state.emergencyTruncateLatch?.length, "clip latched");

  const refOf = (st: typeof t1.state, id: string) => st.messageRefs.byRaw[id];
  const startRef = refOf(t1.state, "raw-warm");
  const endRef = refOf(t1.state, "raw-tail1-a");
  assert.ok(startRef && endRef, "refs assigned");

  const fold = core.applyCompression({
    messages: t1.messages,
    state: t1.state,
    config: cfg(),
    ranges: [{ startRef, endRef, summary: "a long enough summary for the fold gate to accept this range, over fifty chars", topic: "t" }],
  });
  assert.equal(fold.result.blocksCreated, 1, "fold lands");
  assert.equal(fold.state.emergencyTruncateLatch, undefined, "fold resets the latch");

  // Post-fold: a NEW oversized message under the watermark must NOT be
  // clipped — the latch retired with the fold and the watermark re-evaluates
  // from scratch (the original raw-big left the view inside the fold).
  const post = [
    ...hist().filter((m) => m.id !== "raw-big"),
    { id: "raw-big2", role: "user" as const, contentType: "text" as const, text: BIG },
  ];
  const t3 = core.processTurn({
    messages: post,
    state: fold.state,
    config: cfg(),
    tokenCount: 60_000,
    renderTags: "none",
  });
  const big2 = t3.messages.find((m) => m.id === "raw-big2");
  assert.ok(big2, "new oversized message in view");
  assert.equal(big2!.text, BIG, "no clip after the fold reset (under watermark)");
  assert.equal(t3.state.emergencyTruncateLatch, undefined, "latch stays retired");
});

test("pin: an edited message (new content id) is not replay-clipped from a stale latch entry", () => {
  const core = createCore(defaultConfig(WINDOW));
  const t1 = core.processTurn({
    messages: hist(),
    state: createInitialState(),
    config: defaultConfig(WINDOW),
    tokenCount: 96_000,
    renderTags: "none",
  });
  assert.ok(t1.state.emergencyTruncateLatch?.length, "clip latched");

  const edited = hist();
  const bigIdx = edited.findIndex((m) => m.id === "raw-big");
  edited[bigIdx] = { ...edited[bigIdx]!, id: "raw-big-v2", text: "completely rewritten, short" };

  const t2 = core.processTurn({
    messages: edited,
    state: t1.state,
    config: defaultConfig(WINDOW),
    tokenCount: 60_000,
    renderTags: "none",
  });
  assert.equal(t2.messages.find((m) => m.id === "raw-big-v2")!.text, "completely rewritten, short");
  assert.equal(t2.state.emergencyTruncateLatch?.length ?? 0, 0, "stale entry retired with its message");
});
