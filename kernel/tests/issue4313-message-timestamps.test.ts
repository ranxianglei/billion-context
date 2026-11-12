/** #4313: immutable local time-of-occurrence on the <acp> tag.
 *
 * Hard invariants pinned here (spec C):
 *  - the time attribute renders ONLY from a STORED value (message.ts or the
 *    persisted first-sight stamp map) — the render path never reads the wall
 *    clock, so a second render of the same logical message is byte-identical
 *    (prefix cache).
 *  - ids claimed BEFORE the feature shipped keep their exact legacy bytes
 *    (no attribute) — zero churn on upgrade.
 *  - first-sight arrival: the stamp is minted exactly once and survives
 *    every later render of that message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { formatTagTime, renderWithSnapshot } from "../src/render-refs.js";
import { defaultConfig } from "../src/config.js";
import { buildCompressSystemPrompt } from "../src/compress-tools.js";
import {
  LEAN_HOW_TO_COMPRESS,
  LEAN_HOW_TO_COMPRESS_TIMESTAMPED,
  TIMELINE_RULE_LINE,
} from "../src/packs.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

// Pin the local zone: the kernel is platform-agnostic and test hosts may
// run anywhere. Each test FILE runs in its own node process, so setting TZ
// here affects every local-time call below deterministically (+08:00, no DST).
process.env.TZ = "Asia/Shanghai";

const msg = (id: string, text: string): CoreMessage => ({
  id,
  role: "user",
  contentType: "text",
  text,
});

test("formatTagTime: stored ms → 'yyyy-mm-dd hh:mm:ss' local, hand-padded", () => {
  // UTC 2026-09-28 07:59:09Z == Asia/Shanghai 2026-09-28 15:59:09 local
  assert.equal(formatTagTime(Date.UTC(2026, 8, 28, 7, 59, 9)), "2026-09-28 15:59:09");
  // UTC 2026-01-04 19:04:05Z == Shanghai 2026-01-05 03:04:05 — single-digit
  // components must be zero-padded AND the day boundary must be local, not UTC.
  assert.equal(formatTagTime(Date.UTC(2026, 0, 4, 19, 4, 5)), "2026-01-05 03:04:05");
});

test("first-sight arrival: stamp minted once, immutable across renders", () => {
  const core = createCore({ timestamps: true });
  const state = createInitialState();
  const t0 = Date.now();
  const r1 = core.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta")],
    state,
    config: defaultConfig(100000),
    tokenCount: 100,
  });
  const timeOf = (t: string) => / time="([^"]+)"/.exec(t)?.[1];
  const t1a = timeOf(r1.messages[0]!.text!);
  const t1b = timeOf(r1.messages[1]!.text!);
  assert.ok(t1a && t1b, "fresh arrivals carry the time attribute");
  assert.ok(Date.parse(t1a.replace(" ", "T")) >= t0 - 5000, "stamp ≈ first-sight now");
  // Second pass over the SAME state: the stamps persist, bytes are stable.
  const r2 = core.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta")],
    state: r1.state,
    config: defaultConfig(100000),
    tokenCount: 100,
  });
  assert.equal(timeOf(r2.messages[0]!.text!), t1a, "id a keeps its stamp");
  assert.equal(timeOf(r2.messages[1]!.text!), t1b, "id b keeps its stamp");
  const stamps = r1.state.tsStamps;
  assert.ok(stamps && typeof stamps["a"] === "number" && typeof stamps["b"] === "number",
    "stamps persisted into state.tsStamps keyed by raw id");
  assert.ok(!("c" in (stamps ?? {})), "no phantom entries for unseen ids");
});

test("pre-feature ids (already claimed, no stamp) keep byte-exact legacy tags", () => {
  const core = createCore({ timestamps: true });
  const state = createInitialState();
  state.messageRefs = assignRefs([msg("a", "alpha")], {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const result = core.processTurn({
    messages: [msg("a", "alpha")],
    state,
    config: defaultConfig(100000),
    tokenCount: 100,
  });
  assert.match(
    result.messages[0]!.text!,
    /^<acp tokens="\d+" type="text">m00001<\/acp>\nalpha$/,
    "no time attribute ever appears for un-stamped legacy ids",
  );
});

test("explicit CoreMessage.ts beats minting and is recorded verbatim", () => {
  const core = createCore({ timestamps: true });
  const T = Date.UTC(2026, 8, 28, 7, 59, 9);
  const result = core.processTurn({
    messages: [{ ...msg("a", "alpha"), ts: T }],
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 10,
  });
  assert.match(
    result.messages[0]!.text!,
    new RegExp(`^<acp tokens="\\d+" type="text" time="${formatTagTime(T)}">m00001<\\/acp>\\nalpha$`),
  );
  assert.equal(result.state.tsStamps?.["a"], T, "stored value wins over the wall clock");
});

test("snapshot stability: two renders of the same snapshot are byte-identical", () => {
  const state = createInitialState();
  state.messageRefs = assignRefs([msg("a", "alpha"), msg("b", "beta")], {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state.tsStamps = {
    a: Date.UTC(2026, 8, 28, 7, 59, 9),
    b: Date.UTC(2026, 9, 1, 1, 2, 3),
  };
  // The stamp-timestamps pipeline node merges tsStamps onto messages before
  // render; the render path only ever reads message.ts. Feed both stamped
  // copies directly (no Date.now() in sight — prefix-cache invariant).
  const list = (): CoreMessage[] => [
    { ...msg("a", "alpha"), ts: Date.UTC(2026, 8, 28, 7, 59, 9) },
    { ...msg("b", "beta"), ts: Date.UTC(2026, 9, 1, 1, 2, 3) },
  ];
  const count = (t: string) => Math.ceil(t.length / 4);
  const [r1, r2] = [renderWithSnapshot(list(), state, count, "all", true),
    renderWithSnapshot(list(), state, count, "all", true)];
  assert.deepEqual(
    r1.messages.map((m) => m.text),
    r2.messages.map((m) => m.text),
    "rendering never consults the clock — repeats are byte-equal",
  );
  assert.ok(r1.messages[0]!.text!.includes(`time="${formatTagTime(Date.UTC(2026, 8, 28, 7, 59, 9))}"`),
    "timestamps=true renders the stored value into the tag");
});

test("lint: the render path reads no wall clock", () => {
  const src = readFileSync(new URL("../src/render-refs.ts", import.meta.url), "utf8");
  assert.ok(!/Date\.now\s*\(\s*\)/.test(src), "render-refs never calls Date.now()");
  // The ONLY new Date in the file is formatTagTime parsing a STORED ms value.
  assert.equal(src.match(/\bnew Date\s*\(/g)?.length ?? 0, 1);
});

test("stamps survive applyCompression (the fold clones state, #cloneState carry)", () => {
  const core = createCore({ timestamps: true });  // Long enough to clear the default minCompressRange floor.
  const body = "payload ".repeat(500);
  const messages = [msg("a", body), msg("b", body), msg("c", body), msg("d", body), msg("e", body), msg("f", body), msg("g", body), msg("h", body)];
  const turn = core.processTurn({ config: defaultConfig(100000), tokenCount: 20, messages, state: createInitialState() });
  const before: Record<string, number> | undefined = turn.state.tsStamps;
  assert.ok(before && before["a"] && before["h"], "turn minted stamps");
  const result = core.applyCompression({
    // f..h sit in the default protected zone (last 3) — keep the fold older.
    ranges: [{ startRef: "m00001", endRef: "m00005", summary: "Messages a through e carry identical large payload bodies; nothing else was decided here." }],
    messages,
    state: turn.state,
    config: defaultConfig(100000),
  });
  assert.equal(result.result.errors.length, 0);
  assert.deepEqual(result.state.tsStamps, before, "the fold must not drop first-sight stamps");
});

// --- #4313 toggle (PR #5236): default construction is OFF — pre-feature bytes ---

test("toggle: default core (no ports) renders zero time attributes and mints no stamps", () => {
  const core = createCore();
  const t0 = Date.now();
  const r1 = core.processTurn({
    messages: [msg("a", "alpha"), msg("b", "beta")],
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 100,
  });
  assert.match(r1.messages[0]!.text!, /^<acp tokens="\d+" type="text">m00001<\/acp>\nalpha$/);
  assert.match(r1.messages[1]!.text!, /^<acp tokens="\d+" type="text">m00002<\/acp>\nbeta$/);
  assert.equal(r1.state.tsStamps, undefined, "flag-off never touches tsStamps");
  // A later ON core over the SAME ids still mints (late enablement works).
  const on = createCore({ timestamps: true });
  const r2 = on.processTurn({ messages: [msg("c", "gamma")], state: r1.state, config: defaultConfig(100000), tokenCount: 100 });
  assert.match(r2.messages[0]!.text!, / time="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/);
  void t0;
});

test("toggle: hydrated ts values stay invisible while the flag is off", () => {
  // Storage hydration attaches row.ts regardless of the flag (data prepared,
  // display gated). Render-side gate: off ⇒ legacy bytes even with ts set.
  const state = createInitialState();
  state.messageRefs = assignRefs([msg("a", "alpha")], { existing: state.messageRefs, nextIndex: 1 }).map;
  const withTs = [{ ...msg("a", "alpha"), ts: Date.UTC(2026, 8, 28, 7, 59, 9) }];
  const legacy = renderWithSnapshot(withTs, state, (t) => Math.ceil(t.length / 4));
  assert.match(legacy.messages[0]!.text!, /^<acp tokens="\d+" type="text">m00001<\/acp>\nalpha$/);
  // And the pipeline side: an off core must not backfill message.ts from a
  // carried stamp either.
  const core = createCore();
  const turn = core.processTurn({
    messages: [{ ...msg("x", "xray"), ts: Date.UTC(2026, 8, 28, 7, 59, 9) }],
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 10,
  });
  assert.match(turn.messages[0]!.text!, /^<acp tokens="\d+" type="text"[^>]*>m00001<\/acp>/);
  assert.ok(!/\btime=/.test(turn.messages[0]!.text!), "no time attribute while off");
  assert.equal(turn.state.tsStamps, undefined);
});

test("toggle: default prompt texts are the exact pre-feature originals", () => {
  // Anchors hardcoded from dcf76075 (pre-#4313 master) — any accidental drift
  // into the timestamped wording breaks the off-by-default contract.
  const out = buildCompressSystemPrompt();
  assert.ok(out.includes('<acp tokens="2.1K" type="tool:bash">m00175</acp>'), "legacy function ACP TAGS default");
  assert.ok(!out.includes('time="'), "no timestamped tag example in the default prompt");
  assert.ok(!out.includes("TIMELINE"), "no TIMELINE rule in the default how-to-compress");
  assert.ok(!LEAN_HOW_TO_COMPRESS.includes("TIMELINE"), "base lean pack stays pre-feature");
  assert.ok(LEAN_HOW_TO_COMPRESS_TIMESTAMPED.includes(TIMELINE_RULE_LINE), "variant carries the rule line");
  assert.equal(
    LEAN_HOW_TO_COMPRESS_TIMESTAMPED.replace(TIMELINE_RULE_LINE + "\n", ""),
    LEAN_HOW_TO_COMPRESS,
    "variant = base + rule line only (byte-exact extension)",
  );
});
