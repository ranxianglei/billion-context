// #6882: the emergency-truncate watermark crossed on an ESTIMATE-grade meter
// reading (no billing sample this cycle — stream interruption, cache-TTL
// expiry) latched clips the bill never saw: the estimate ran 1.75–1.87× the
// billed size, so a 119% "crossing" was a 72% reality — content destroyed
// plus a burned prefix cache (16.3% vs 100% control). The guard is the one
// the pressure band already uses (decideNudge): while the estimate-hold
// backstop (nudge.maxEstimateHoldRounds, default 2) allows, the watermark
// decision waits one round for the usage-grade reading the next request
// carries. Already-latched clips still replay byte-for-byte; the round is
// unjudged, so terminalStreak is neither reset nor incremented. Billed
// readings ("usage", incl. the overflow arm), legacy callers (source
// omitted), and requireUsageSampleForPressure=false keep byte-identical
// behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { createInitialState } from "../src/state.js";
import type { CoreMessage } from "../src/types.js";

const BIG = "alpha-beta ".repeat(4000); // ~48k chars, well past prefix+suffix
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
const OVER = 96_000; // 96% — above truncate.threshold 0.95
const UNDER = 90_000; // 90% — below the watermark

function run(
  state: ReturnType<typeof createInitialState>,
  tokenCount: number,
  tokenCountSource?: "usage" | "estimate",
  config?: ReturnType<typeof defaultConfig>,
) {
  const core = createCore(defaultConfig(WINDOW));
  return core.processTurn({
    messages: hist(),
    state,
    config: config ?? defaultConfig(WINDOW),
    tokenCount,
    renderTags: "none",
    ...(tokenCountSource !== undefined ? { tokenCountSource } : {}),
  });
}

test("estimate-grade crossing is held: no new clip, no latch, hold named in truncationSkipped", () => {
  const turn = run(createInitialState(), OVER, "estimate");
  const big = turn.messages.find((m) => m.id === "raw-big")!;
  assert.equal(big.text, BIG, "no clip on an estimate-grade crossing");
  assert.equal(turn.state.emergencyTruncateLatch, undefined, "no new latch entries");
  assert.match(turn.truncationSkipped ?? "", /estimate-grade/);
  assert.match(turn.truncationSkipped ?? "", /estimate round 1 of 2/);
});

test("held round is byte-identical to a below-threshold round on the same view", () => {
  const held = run(createInitialState(), OVER, "estimate");
  const under = run(createInitialState(), UNDER, "usage");
  assert.deepEqual(held.messages, under.messages, "same outbound bytes");
});

test("already-latched clips still replay byte-for-byte on a held round", () => {
  const t1 = run(createInitialState(), OVER, "usage");
  const clipped1 = t1.messages.find((m) => m.id === "raw-big")!.text!;
  assert.ok(clipped1.includes("[truncated for context space]"), "usage-grade crossing clips");
  assert.ok(t1.state.emergencyTruncateLatch?.some((e) => e.text === clipped1), "clip latched");

  const t2 = run(t1.state, OVER, "estimate");
  const clipped2 = t2.messages.find((m) => m.id === "raw-big")!.text!;
  assert.equal(clipped2, clipped1, "latch replays byte-identically while held");
  assert.equal(t2.state.emergencyTruncateLatch?.length, t1.state.emergencyTruncateLatch?.length, "no new latch entries");
  assert.match(t2.truncationSkipped ?? "", /estimate-grade/);
});

test("estimate-hold backstop elapses: the crossing truncates once the streak exceeds maxEstimateHoldRounds", () => {
  const state = createInitialState();
  state.nudge.estimateHoldStreak = 2; // this round becomes 3 > 2
  const turn = run(state, OVER, "estimate");
  const big = turn.messages.find((m) => m.id === "raw-big")!;
  assert.ok(big.text!.includes("[truncated for context space]"), "truncates after the backstop");
  assert.equal(turn.truncationSkipped, undefined, "no hold note once the backstop elapses");
});

test("usage-grade crossing still truncates (byte-identical legacy path)", () => {
  const turn = run(createInitialState(), OVER, "usage");
  const big = turn.messages.find((m) => m.id === "raw-big")!;
  assert.ok(big.text!.includes("[truncated for context space]"));
  assert.equal(turn.truncationSkipped, undefined);
});

test("legacy caller (source omitted) still truncates", () => {
  const turn = run(createInitialState(), OVER);
  const big = turn.messages.find((m) => m.id === "raw-big")!;
  assert.ok(big.text!.includes("[truncated for context space]"));
});

test("nudge.requireUsageSampleForPressure=false restores estimate-driven truncation", () => {
  const config = defaultConfig(WINDOW);
  config.nudge.requireUsageSampleForPressure = false;
  const turn = run(createInitialState(), OVER, "estimate", config);
  const big = turn.messages.find((m) => m.id === "raw-big")!;
  assert.ok(big.text!.includes("[truncated for context space]"));
});

test("nudge.maxEstimateHoldRounds=0 disables the hold (first estimate round truncates)", () => {
  const config = defaultConfig(WINDOW);
  config.nudge.maxEstimateHoldRounds = 0;
  const turn = run(createInitialState(), OVER, "estimate", config);
  const big = turn.messages.find((m) => m.id === "raw-big")!;
  assert.ok(big.text!.includes("[truncated for context space]"));
});

test("terminalStreak rides through a held round untouched (neither reset nor incremented)", () => {
  const state = createInitialState();
  state.terminalStreak = 2;
  const turn = run(state, OVER, "estimate");
  assert.equal(turn.state.terminalStreak, 2, "held round leaves the streak as-is");
});

test("a held round after a usage-grade stuck round keeps the streak (no reset from the hold)", () => {
  // t1: usage-grade crossing with nothing truncatable (no oversized content)
  // arms the stuck streak; t2: estimate-grade crossing is held — the streak
  // must survive the hold instead of being reset to 0.
  const smallHist = (): CoreMessage[] => [
    ...tiny("warm"),
    ...tiny("tail1"),
    ...tiny("tail2"),
  ];
  const core = createCore(defaultConfig(WINDOW));
  const t1 = core.processTurn({
    messages: smallHist(),
    state: createInitialState(),
    config: defaultConfig(WINDOW),
    tokenCount: OVER,
    tokenCountSource: "usage",
    renderTags: "none",
  });
  assert.ok((t1.state.terminalStreak ?? 0) > 0, "usage-grade stuck round arms the streak");
  const t2 = core.processTurn({
    messages: smallHist(),
    state: t1.state,
    config: defaultConfig(WINDOW),
    tokenCount: OVER,
    tokenCountSource: "estimate",
    renderTags: "none",
  });
  assert.equal(t2.state.terminalStreak, t1.state.terminalStreak, "hold does not reset the streak");
});
