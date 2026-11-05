// #3939 ② / #3805: when a BLOCKED ref migrates to a fresh numeric ref
// (protection lifted, #2607), the NUMBER is minted immediately but the <acp>
// tag on the old carrier must NOT appear until a fold boundary rewrites
// history anyway. Stamping it on the migration turn silently rewrites an old
// message mid-history on an otherwise quiet turn — a prefix-cache breaker
// (#3805: durable carriers flipping bytes with no fold in sight).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { createInitialState } from "../src/state.js";
import { BLOCKED_REF } from "../src/refs.js";
import type { CoreMessage } from "../src/types.js";

const W = 100_000;
const cfg = () => ({ ...defaultConfig(W), preserveRecentTokens: 100 });

function hist(): CoreMessage[] {
  const filler = "filler ".repeat(340); // push the range over the 5000-char min-compress gate
  return [
    { id: "raw-a", role: "user", contentType: "text", text: "first question " + filler },
    { id: "raw-img", role: "user", contentType: "text", text: "look at this " + filler },
    { id: "raw-b", role: "assistant", contentType: "text", text: "answer " + filler },
    { id: "raw-c", role: "user", contentType: "text", text: "second question" },
    { id: "raw-d", role: "assistant", contentType: "text", text: "second answer" },
    { id: "raw-e", role: "user", contentType: "text", text: "third question" },
    { id: "raw-f", role: "assistant", contentType: "text", text: "third answer" },
  ];
}

test("pin: BLOCKED→numeric migration mints the ref but defers the carrier tag (#3805)", () => {
  const core = createCore(cfg());
  // Simulate a pre-existing BLOCKED assignment on raw-img (protection lifted
  // since — the message is plain text now).
  const state = createInitialState();
  state.messageRefs.byRaw["raw-img"] = BLOCKED_REF;

  const t1 = core.processTurn({
    messages: hist(),
    state,
    config: cfg(),
    tokenCount: 1_000,
    renderTags: "all",
  });

  const imgRef = t1.state.messageRefs.byRaw["raw-img"]!;
  assert.notEqual(imgRef, BLOCKED_REF, "migration mints a numeric ref");
  const imgText = t1.messages.find((m) => m.id === "raw-img")!.text!;
  assert.ok(!imgText.includes("\x3cacp "), "carrier text stays untagged on the migration turn");
  assert.deepEqual(t1.state.renderDeferredRefs, [imgRef], "deferral recorded in state");
  // Sanity: other messages render normally.
  assert.ok(t1.messages.find((m) => m.id === "raw-a")!.text!.includes("\x3cacp "), "untagged only for the migrated carrier");

  // Quiet turn 2: deferral persists — still no tag, still byte-stable.
  const t2 = core.processTurn({
    messages: hist(),
    state: t1.state,
    config: cfg(),
    tokenCount: 1_000,
    renderTags: "all",
  });
  assert.ok(!t2.messages.find((m) => m.id === "raw-img")!.text!.includes("\x3cacp "), "deferral self-perpetuates on quiet turns");
});

test("pin: a fold boundary releases the deferral and the tag rides the fold's rewrite", () => {
  const core = createCore(cfg());
  const state = createInitialState();
  state.messageRefs.byRaw["raw-img"] = BLOCKED_REF;
  const t1 = core.processTurn({ messages: hist(), state, config: cfg(), tokenCount: 1_000, renderTags: "all" });
  assert.ok(t1.state.renderDeferredRefs?.length, "deferral active");

  const refOf = (st: typeof t1.state, id: string) => st.messageRefs.byRaw[id];
  const fold = core.applyCompression({
    messages: t1.messages,
    state: t1.state,
    config: cfg(),
    ranges: [{
      startRef: refOf(t1.state, "raw-a")!,
      endRef: refOf(t1.state, "raw-b")!,
      summary: "a long enough summary for the fold gate to accept this range, over fifty chars",
      topic: "t",
    }],
  });
  assert.equal(fold.result.blocksCreated, 1, `fold lands: ${JSON.stringify(fold.result.errors ?? [])} ${JSON.stringify(fold.result.warnings ?? [])}`);
  assert.equal(fold.state.renderDeferredRefs, undefined, "fold releases the deferral");

  const t3 = core.processTurn({ messages: hist(), state: fold.state, config: cfg(), tokenCount: 1_000, renderTags: "all" });
  const imgText = t3.messages.find((m) => m.id === "raw-img")?.text ?? "";
  assert.ok(!imgText.includes("\x3cacp ") || t3.messages.every((m) => m.id !== "raw-img"), "raw-img rode the fold away or renders tagged at the fold boundary");
});
