// #7729: kernel mid-turn diagnostics must be routable OFF the process console,
// and the funnel-zero diagnostic must only fire for an UNEXPLAINED zeroing.
//
// Two defect layers pinned here, both directions (#3617 gate discipline):
//   1. the sink: `createCore({ warn })` receives EVERY diagnostic the kernel
//      emits mid-turn, so an inline host embedded in a TUI can send them to its
//      durable log instead of the physical screen (the funnel-zero line used to
//      go through console.warn unconditionally). With no sink supplied the
//      legacy console.warn leg stays byte-identical — a caller that forgets to
//      wire it must not lose the diagnostic;
//   2. the trigger: a short conversation whose islands all sit below the
//      merge gate has NOTHING to advertise — "host sees no-ranges" is the
//      correct, everyday outcome, and warning there made every ordinary turn
//      of every short session print an `[acp-kernel]` line (the field report:
//      the pi TUI printed it several times per user turn). Only units that DID
//      clear the gate and then died at the screen are a diagnostic — that is
//      the 2026-11-09 mega-turn incident shape this channel exists for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig, createInitialState, defaultCountTokens } from "../src/index.js";
import { screenRecommendedUnits, warnScreenDrop } from "../src/recommend.js";
import type { CoreMessage } from "../src/types.js";

const cjk = (n: number): string => "问".repeat(n);

function mk(parts: [string, CoreMessage["role"], number][]): CoreMessage[] {
  return parts.map(([id, role, len]) => ({ id, role, contentType: "text", text: cjk(len) }));
}

function count(messages: CoreMessage[]): number {
  return defaultCountTokens(messages.map((m) => m.text ?? "").join(""));
}

interface TurnOutcome {
  delivered: string[];
  consoleLines: string[];
}

/** Run one turn. `withSink` false exercises the legacy console.warn leg. */
function runTurn(messages: CoreMessage[], opts: { withSink: boolean; applyView?: CoreMessage[] }): TurnOutcome {
  const delivered: string[] = [];
  const consoleLines: string[] = [];
  const core = opts.withSink ? createCore({ warn: (m) => delivered.push(m) }) : createCore({});
  const real = console.warn;
  console.warn = (...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")); };
  try {
    core.processTurn({
      messages,
      state: createInitialState(),
      config: defaultConfig(200_000),
      tokenCount: count(messages),
      renderTags: "none",
      ...(opts.applyView ? { applyView: opts.applyView } : {}),
    });
  } finally {
    console.warn = real;
  }
  return { delivered, consoleLines };
}

// Short conversation, CJK so chars ≈ tokens: the everyday shape whose islands
// all sit below the 5000-char merge gate. Pre-#7729 this warned every turn.
const SHORT = mk([
  ["u0", "user", 800], ["a1", "assistant", 1200],
  ["u2", "user", 800], ["a3", "assistant", 1200],
  ["u4", "user", 800], ["a5", "assistant", 1200],
  ["u6", "user", 800], ["a7", "assistant", 1200],
]);

// Same session, but the host's fold view is only the head (the applyView /
// render-view split documented on ProcessTurnInput): islands clear the gate on
// the view while every projection endpoint dies on it — units advertised then
// zeroed. This is the shape that must still be reported.
const LONG = mk([
  ["u0", "user", 3000], ["a1", "assistant", 3000],
  ["u2", "user", 3000], ["a3", "assistant", 3000],
  ["u4", "user", 3000], ["a5", "assistant", 3000],
  ["u6", "user", 3000], ["a7", "assistant", 3000],
]);
const LONG_HEAD = LONG.slice(0, 4);

test("#7729: a short conversation whose islands are all sub-gate emits NO diagnostic (everyday shape)", () => {
  const { delivered, consoleLines } = runTurn(SHORT, { withSink: true });
  assert.deepEqual(delivered, [], "nothing to advertise is not a fault");
  assert.deepEqual(consoleLines, []);
});

test("#7729: the same short conversation stays silent on the legacy console leg", () => {
  const { consoleLines } = runTurn(SHORT, { withSink: false });
  assert.deepEqual(consoleLines, [], "the narrowing applies to the default leg too");
});

test("#7729: units that clear the gate and then die at the screen DO warn, through the sink", () => {
  const { delivered, consoleLines } = runTurn(LONG, { withSink: true, applyView: LONG_HEAD });
  assert.equal(delivered.length, 1, `expected exactly one diagnostic, got ${delivered.length}`);
  assert.match(delivered[0]!, /^\[acp-kernel\] screenRecommendedUnits funnel zeroed with material present/);
  assert.match(delivered[0]!, /merged unit\(s\) cleared the gate but died at screen/, "the line names the killing stage");
  assert.deepEqual(consoleLines, [], "nothing reaches the process console once a sink is wired");
});

test("#7729: an unwired core keeps the legacy console.warn leg byte-identical", () => {
  const { consoleLines } = runTurn(LONG, { withSink: false, applyView: LONG_HEAD });
  assert.equal(consoleLines.length, 1, "legacy callers still see the diagnostic");
  assert.match(consoleLines[0]!, /^\[acp-kernel\] screenRecommendedUnits funnel zeroed with material present/);
});

test("#7729: the screen-drop budget is per sink, not module-global", () => {
  const a: string[] = [];
  const b: string[] = [];
  const sinkA = (m: string): void => { a.push(m); };
  const sinkB = (m: string): void => { b.push(m); };
  for (let i = 0; i < 60; i++) warnScreenDrop(sinkA, `dropped unit m0000${i % 10}..m0000${i % 10}: repeat`);
  warnScreenDrop(sinkB, "dropped unit m00001..m00002: first for this sink");
  assert.equal(b.length, 1, "a fresh sink is not starved by another sink's spent budget");
  assert.equal(a.length, 40, "sink A was capped at the budget, before the stride re-arms at 100");
});

test("#7729: warnScreenDrop delivers through the supplied sink only", () => {
  const sink: string[] = [];
  warnScreenDrop((m) => sink.push(m), "dropped unit m00001..m00002: test");
  assert.deepEqual(sink, ["[acp-kernel] screenRecommendedUnits dropped unit m00001..m00002: test"]);
});

test("#7729: screenRecommendedUnits threads its sink into every drop diagnostic", () => {
  const sink: string[] = [];
  const kept = screenRecommendedUnits(
    [{ startRef: "zz-invalid", endRef: "m00002", count: 2, tokens: 6000 }],
    SHORT,
    createInitialState(),
    defaultConfig(200_000),
    new Set(),
    (m) => sink.push(m),
  );
  assert.equal(kept.length, 0);
  assert.equal(sink.length, 1, "the programming-error class still reports, now through the sink");
  assert.match(sink[0]!, /dropped unit zz-invalid\.\.m00002 after projection error: Invalid boundary ref/);
});
