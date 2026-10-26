// #3939 ⑤: the opt-in mid-history rewriters (absorb-hide, crush, filter
// keepLastOnly) re-derive their output every pass; without a latch each state/
// context change flips OLD message bytes on an otherwise quiet turn (#3805
// class). The view latch replays post-transform bytes verbatim; refreshes ride
// fold boundaries, absorb actions, and config edits (user action boundaries).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { applyAbsorb } from "../src/absorb.js";
import { createInitialState } from "../src/state.js";
import {
  registerMessageFilter,
  clearMessageFilters,
} from "../src/filter/registry.js";
import type { CoreMessage } from "../src/types.js";

const W = 100_000;
const cfg = () => ({ ...defaultConfig(W), preserveRecentTokens: 100 });

function hist(): CoreMessage[] {
  const filler = "filler ".repeat(500);
  return [
    { id: "raw-a", role: "user", contentType: "text", text: "first question " + filler },
    { id: "raw-b", role: "assistant", contentType: "text", text: "answer " + filler },
    { id: "raw-c", role: "user", contentType: "text", text: "second question" },
    { id: "raw-d", role: "assistant", contentType: "text", text: "second answer" },
    { id: "raw-e", role: "user", contentType: "text", text: "third question" },
    { id: "raw-f", role: "assistant", contentType: "text", text: "third answer" },
  ];
}

test("pin: filter keepLastOnly demotion is deferred to the fold boundary", () => {
  clearMessageFilters();
  registerMessageFilter({
    name: "pin-marker",
    version: "1",
    description: "test filter",
    keepLastOnly: true,
    filter: (ctx) =>
      ctx.text.includes("SECRETTOKEN")
        ? { action: "modify", text: ctx.text.replace(/SECRETTOKEN/g, "[redacted]") }
        : { action: "keep" },
  });
  try {
    const core = createCore(cfg());
    const config = {
      ...cfg(),
      messageFilters: { enabled: true, filters: { "pin-marker": { enabled: true } } },
    };
    const m1 = [
      ...hist(),
      { id: "raw-occ1", role: "user", contentType: "text" as const, text: "here is SECRETTOKEN one" },
    ];
    const t1 = core.processTurn({ messages: m1, state: createInitialState(), config, tokenCount: 1_000, renderTags: "none" });
    // occ1 is the LAST occurrence → the filter's decision applies at arrival
    // (modify → [redacted]) and the result is latched.
    const occ1a = t1.messages.find((m) => m.id === "raw-occ1")!;
    assert.ok(occ1a.text!.includes("[redacted]"), "last occurrence filtered on arrival");
    assert.ok(!occ1a.text!.includes("SECRETTOKEN"), "pattern stripped at arrival");

    // A NEWER occurrence arrives — the fresh filter would demote occ1 (blank
    // it). The latch replays occ1's bytes unchanged: the demotion waits for a
    // fold boundary.
    const m2 = [
      ...m1,
      { id: "raw-occ2", role: "user", contentType: "text" as const, text: "again SECRETTOKEN two" },
    ];
    const t2 = core.processTurn({ messages: m2, state: t1.state, config, tokenCount: 1_000, renderTags: "none" });
    const occ1b = t2.messages.find((m) => m.id === "raw-occ1")!;
    assert.equal(occ1b.text, occ1a.text, "demotion deferred — old bytes replay verbatim");
    assert.ok(t2.messages.find((m) => m.id === "raw-occ2")!.text!.includes("[redacted]"), "new last occurrence filtered fresh (arrival boundary)");

    // Fold covering occ1 releases the latch: post-fold, occ1 is folded away
    // and the new state carries no latches.
    const refOf = (st: typeof t1.state, id: string) => st.messageRefs.byRaw[id];
    const fold = core.applyCompression({
      messages: t2.messages,
      state: t2.state,
      config,
      ranges: [{
        startRef: refOf(t2.state, "raw-a")!,
        endRef: refOf(t2.state, "raw-b")!,
        summary: "a long enough summary for the fold gate to accept this range, over fifty chars",
        topic: "t",
      }],
    });
    assert.equal(fold.result.blocksCreated, 1, `fold lands: ${JSON.stringify(fold.result.errors ?? [])}`);
    assert.equal(fold.state.viewLatches, undefined, "fold releases the view latch");
  } finally {
    clearMessageFilters();
  }
});

test("pin: absorb-hide defers to the absorb action boundary, not a later fold", () => {
  const core = createCore(cfg());
  const config = defaultConfig(W, {
    absorb: { enabled: true, toolName: "acp_absorb", minToolTokens: 1, contextThresholdPct: 0, excludeTools: [] },
  });
  const m1 = [
    { id: "u1", role: "user", contentType: "text" as const, text: "read the file" },
    { id: "c1", role: "tool", contentType: "tool-call" as const, toolName: "read", toolCallId: "call1", text: "{}" },
    { id: "r1", role: "tool", contentType: "tool-result" as const, toolName: "read", toolCallId: "call1", text: "file body line one\n" + "x".repeat(400) },
  ];
  const t1 = core.processTurn({ messages: m1, state: createInitialState(), config, tokenCount: 3_000, renderTags: "none" });
  assert.ok(t1.messages.find((m) => m.id === "r1"), "pair visible before absorb");

  // Absorb r1: the absorb call is an action boundary — applyAbsorb releases
  // the latch, so the hide lands THIS turn (instant-reclaim contract).
  const ref = t1.state.messageRefs.byRaw["r1"]!;
  const outcome = applyAbsorb({
    ref,
    summary: "file defines foo(a,b) at src/foo.ts:12",
    messages: m1,
    state: t1.state,
    config,
  });
  assert.ok(outcome.ok, "absorb ok");
  const t2 = core.processTurn({ messages: m1, state: outcome.state, config, tokenCount: 3_200, renderTags: "none" });
  const ids = t2.messages.map((m) => m.id);
  assert.ok(!ids.includes("r1"), "absorbed result hidden on the action boundary turn");
  assert.ok(!ids.includes("c1"), "absorbed call hidden on the action boundary turn");
});

test("pin: config enable of crush applies on the edit turn (config boundary), token-pressure flips do not", () => {
  const core = createCore(cfg());
  const off = defaultConfig(W, {
    absorb: { enabled: true, toolName: "acp_absorb", minToolTokens: 100, contextThresholdPct: 0, excludeTools: [] },
  });
  const rows = JSON.stringify(
    Array.from({ length: 40 }, (_, i) => ({ id: i * 7, ts: "2026-09-21T12:00:00Z", level: "INFO", name: `svc-${i}` })),
  );
  const m1 = [
    { id: "u1", role: "user", contentType: "text" as const, text: "read the log" },
    { id: "c1", role: "tool", contentType: "tool-call" as const, toolName: "read", toolCallId: "call1", text: "{}" },
    { id: "r1", role: "tool", contentType: "tool-result" as const, toolName: "read", toolCallId: "call1", text: rows },
  ];
  const t1 = core.processTurn({ messages: m1, state: createInitialState(), config: off, tokenCount: 0, renderTags: "none" });
  const fresh = t1.messages.find((m) => m.id === "r1")!.text!;
  assert.ok(!fresh.includes("__acp_crush"), "crush off on turn 1");

  // Enable crush: config edit = user action boundary — the crush applies now.
  const onCfg = defaultConfig(W, {
    absorb: { enabled: true, toolName: "acp_absorb", minToolTokens: 100, contextThresholdPct: 0, excludeTools: [] },
    crush: { enabled: true, minReduction: 0.1 },
  });
  const t2 = core.processTurn({ messages: m1, state: t1.state, config: onCfg, tokenCount: 0, renderTags: "none" });
  assert.ok(t2.messages.find((m) => m.id === "r1")!.text!.includes("__acp_crush"), "enable applies on the config-edit turn");

  // Token pressure alone never flips bytes: same config, wildly different
  // tokenCount — the crushed bytes replay verbatim.
  const t3 = core.processTurn({ messages: m1, state: t2.state, config: onCfg, tokenCount: 99_000, renderTags: "none" });
  assert.equal(t3.messages.find((m) => m.id === "r1")!.text, t2.messages.find((m) => m.id === "r1")!.text, "pressure does not re-derive latched bytes");
});

test("pin: CCR disarm releases the latch — a disarmed session never re-projects a dangling placeholder", () => {
  // #1273 governance, restated for the latch: placeholders are legal only
  // while the retrieve channel they advertise exists. CCR rides the config
  // digest, so arming/disarming mid-session is a user-action boundary that
  // releases the latch and re-judges under the CURRENT config.
  const big = "line of build output ".repeat(400);
  const m1 = [
    { id: "u1", role: "user", contentType: "text" as const, text: "run a big build" },
    { id: "c1", role: "assistant", contentType: "tool-call" as const, toolName: "bash", toolCallId: "call1", text: JSON.stringify({ command: "npm run build" }) },
    { id: "r1", role: "tool", contentType: "tool-result" as const, toolName: "bash", toolCallId: "call1", text: big },
  ];
  const armed = { ...cfg(), ccr: { enabled: true, toolName: "acp_retrieve", minToolTokens: 50, excludeTools: [], maxHeadChars: 96 } };
  const core = createCore(cfg());
  const t1 = core.processTurn({ messages: m1, state: createInitialState(), config: armed, tokenCount: 0, renderTags: "none" });
  const t1r = t1.messages.find((m) => m.id === "r1")!.text!;
  assert.ok(t1r.includes("[acp-stored"), "armed CCR substitutes at arrival");
  assert.ok(!t1r.includes("line of build output"), "raw bytes leave the wire while armed");

  // Same session, next turn, CCR still armed: the placeholder replays
  // byte-stable (the latch holds; #1460 reprojection agrees with it).
  const t2 = core.processTurn({ messages: m1, state: t1.state, config: armed, contentStore: t1.contentStore, tokenCount: 0, renderTags: "none" });
  assert.equal(t2.messages.find((m) => m.id === "r1")!.text, t1r, "latched placeholder replays verbatim while armed");

  // Disarm (route/base governance flip): the digest changes → the latch
  // releases → the raw bytes return. No dangling placeholder, no silent loss.
  const t3 = core.processTurn({ messages: m1, state: t2.state, config: cfg(), contentStore: t2.contentStore, tokenCount: 0, renderTags: "none" });
  const t3r = t3.messages.find((m) => m.id === "r1")!.text!;
  assert.ok(t3r.includes("line of build output"), "disarmed CCR returns the raw bytes");
  assert.ok(!t3r.includes("[acp-stored"), "no dangling placeholder after disarm");
});
