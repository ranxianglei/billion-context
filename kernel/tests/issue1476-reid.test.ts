import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { remintCoveredLiveIds } from "../src/instance-reid.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

const HASH = "h_0123456789abcdef";
const EARLY = "h_aaaaaaaaaaaaaaaa";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function folded(ids: string[]): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: ids,
    directBlockIds: [],
    compressedTokens: 0,
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
  };
}

test("re-mints a live message whose id collides with a folded copy (#1476)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  state.lastPassIds = [];
  const out = remintCoveredLiveIds([msg(HASH, "都按推荐来")], state);
  assert.equal(out[0].id, `${HASH}_1`);
});

test("leaves numbering untouched when the base is not folded (incident 3)", () => {
  const state = createInitialState();
  const msgs = [msg(HASH, "x"), msg(`${HASH}_1`, "x")];
  const out = remintCoveredLiveIds(msgs, state);
  assert.deepEqual(
    out.map((m) => m.id),
    [HASH, `${HASH}_1`],
  );
  assert.equal(out, msgs);
});

test("renumbers only the colliding new instance, keeping stable ids (#462)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  state.lastPassIds = [`${HASH}_1`];
  // The bare instance is genuinely new (absent last pass); HASH_1 is not
  // exactly covered, so it keeps the converter's numbering. The renumbered
  // instance dodges the number the live HASH_1 already holds.
  const out = remintCoveredLiveIds(
    [msg(HASH, "a"), msg(`${HASH}_1`, "b")],
    state,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    [`${HASH}_2`, `${HASH}_1`],
  );
});

test("skips instance numbers already claimed by folded copies", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH, `${HASH}_1`]));
  state.lastPassIds = [];
  const out = remintCoveredLiveIds([msg(HASH, "a")], state);
  assert.equal(out[0].id, `${HASH}_2`);
});

test("renumber skips numbers claimed by the previous pass inbound (#462)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  // HASH_1 was live in the previous pass (ref'd there) but is no longer in the
  // resend set; re-minting it would alias its stale ref onto the new instance.
  state.lastPassIds = [`${HASH}_1`];
  const out = remintCoveredLiveIds([msg(HASH, "a")], state);
  assert.equal(out[0].id, `${HASH}_2`);
});

test("preserves the sub-id projection tail", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  state.lastPassIds = [];
  const out = remintCoveredLiveIds([msg(`${HASH}#sub`, "a")], state);
  assert.equal(out[0].id, `${HASH}_1#sub`);
});

test("ignores non-content-hash ids", () => {
  const state = createInitialState();
  state.blocks.push(folded(["acp_summary_b9"]));
  const out = remintCoveredLiveIds(
    [msg("acp_summary_b9", "x"), msg("host-123", "y")],
    state,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    ["acp_summary_b9", "host-123"],
  );
});

test("is deterministic for a fixed (state, body)", () => {
  const state = createInitialState();
  state.blocks.push(folded([HASH]));
  state.lastPassIds = [];
  const a = remintCoveredLiveIds([msg(HASH, "x")], state).map((m) => m.id);
  const b = remintCoveredLiveIds([msg(HASH, "x")], state).map((m) => m.id);
  assert.deepEqual(a, b);
});

function seededFoldState(): ReturnType<typeof createInitialState> {
  const state = createInitialState();
  // Earlier "都按推荐来" was ref'd (m00001) then folded into b1 (off the wire).
  state.messageRefs.byRaw[HASH] = "m00001";
  state.messageRefs.byRef["m00001"] = HASH;
  state.blocks.push(folded([HASH]));
  return state;
}

test("fresh later user turn survives prune with a distinct id + ref (#1476 e2e)", () => {
  const core = createCore();
  const state = seededFoldState();
  // Pass A: history WITHOUT any HASH instance — establishes the prior-pass
  // snapshot the next pass discriminates against.
  const passA = core.processTurn({
    messages: [
      msg(EARLY, "帮我看看这段代码"),
      msg("acp_summary_b1", "[Compressed conversation section] …", "system"),
    ],
    state,
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  // Pass B: the fresh resend whose bare id collides with the folded original
  // and was absent from pass A.
  const result = core.processTurn({
    messages: [
      msg(EARLY, "帮我看看这段代码"),
      msg("acp_summary_b1", "[Compressed conversation section] …", "system"),
      msg(HASH, "都按推荐来"),
    ],
    state: passA.state,
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  const fresh = result.messages.find((m) => m.id === `${HASH}_1`);
  assert.ok(fresh, "fresh user turn must survive prune under a distinct id");
  assert.match(fresh!.text ?? "", /都按推荐来/);
  assert.ok(
    result.state.messageRefs.byRaw[`${HASH}_1`],
    "re-minted id gets a ref",
  );
  assert.ok(
    !result.messages.some((m) => m.id === HASH),
    "folded bare id must not be re-issued",
  );
});

test("post-fold resend of the folded original stays covered and pruned (#462 e2e)", () => {
  const core = createCore();
  const state = seededFoldState();
  // Pass A: the original "都按推荐来" still live (pre-fold shape).
  const passA = core.processTurn({
    messages: [msg(EARLY, "帮我看看这段代码"), msg(HASH, "都按推荐来")],
    state,
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  // Pass B: the stateless host resends the SAME raw history. This is the
  // folded original's echo — #459 renumbered it, prune then missed it, and
  // the summarized content re-inflated the wire every turn.
  const result = core.processTurn({
    messages: [msg(EARLY, "帮我看看这段代码"), msg(HASH, "都按推荐来")],
    state: passA.state,
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  assert.ok(
    !result.messages.some((m) => m.id === HASH || m.id === `${HASH}_1`),
    "echo of the folded original must stay pruned, not renumbered back onto the wire",
  );
  assert.ok(
    !result.state.messageRefs.byRaw[`${HASH}_1`],
    "no fresh ref may be minted for the echo",
  );
  assert.equal(
    result.state.messageRefs.byRaw[HASH],
    "m00001",
    "the folded original keeps its original ref (no churn)",
  );
});

test("first-user pinned echo keeps its id and ref across post-fold passes (#462 e2e)", () => {
  const core = createCore();
  const state = createInitialState();
  state.messageRefs.byRaw[HASH] = "m00001";
  state.messageRefs.byRef["m00001"] = HASH;
  state.blocks.push(folded([HASH]));
  const history = [msg(HASH, "开场白"), msg(EARLY, "后续")];
  const passA = core.processTurn({
    messages: history,
    state,
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  const passB = core.processTurn({
    messages: history,
    state: passA.state,
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  const pinned = passB.messages.find((m) => (m.text ?? "").includes("开场白"));
  assert.ok(pinned, "pinned first user message stays on the wire");
  assert.equal(pinned.id, HASH, "pinned first user message keeps its id");
  assert.equal(
    passB.state.messageRefs.byRaw[HASH],
    "m00001",
    "pinned first user message keeps its ref (no per-turn churn)",
  );
});

test("processTurn writes this pass's inbound ids into state.lastPassIds (#462)", () => {
  const core = createCore();
  const out = core.processTurn({
    messages: [msg(EARLY, "帮我看看这段代码"), msg(HASH, "都按推荐来")],
    state: createInitialState(),
    config: defaultConfig(100000),
    tokenCount: 300,
  });
  assert.deepEqual(out.state.lastPassIds, [EARLY, HASH]);
});

test("missing lastPassIds falls back to renumber-nothing for one pass (#462)", () => {
  const state = seededFoldState();
  const out = remintCoveredLiveIds([msg(HASH, "都按推荐来")], state);
  assert.equal(
    out[0].id,
    HASH,
    "0.0.95 semantics: untouched without a snapshot",
  );
  assert.equal(out.length, 1);
});

test("renumbers a new cluster extension off an INACTIVE block's covered ids (#2695)", () => {
  const state = createInitialState();
  // b2 died when the host decimated its substrate; its covered numbers are
  // h_.._5.._7 of the duplicated-reply cluster.
  const dead = folded([`${HASH}_5`, `${HASH}_6`, `${HASH}_7`]);
  dead.active = false;
  state.blocks.push(dead);
  // Last pass carried the continuing cluster h_.._0.._4 (a live sibling of
  // the same root) — so h_.._5 arriving now is a new extension, not a rewind.
  state.lastPassIds = [
    EARLY,
    HASH,
    `${HASH}_1`,
    `${HASH}_2`,
    `${HASH}_3`,
    `${HASH}_4`,
  ];
  const out = remintCoveredLiveIds(
    [
      msg(EARLY, "hi"),
      msg(HASH, "a"),
      msg(`${HASH}_1`, "a"),
      msg(`${HASH}_2`, "a"),
      msg(`${HASH}_3`, "a"),
      msg(`${HASH}_4`, "a"),
      msg(`${HASH}_5`, "a"),
    ],
    state,
  );
  const five = out.find((m) => (m.text ?? "") === "a" && m.id === `${HASH}_5`);
  assert.ok(!five, "the dead block's h_.._5 must not be re-occupied");
  const minted = out[out.length - 1]!;
  assert.equal(minted.id, `${HASH}_8`, "dodges the dead block's _5.._7");
  assert.equal(out[1]!.id, HASH, "continuing instances keep their ids");
});

test("keeps a whole-root rewind onto an inactive block intact (#2695)", () => {
  const state = createInitialState();
  const dead = folded([HASH, `${HASH}_1`]);
  dead.active = false;
  state.blocks.push(dead);
  // Prior pass saw none of this root (client trimmed it away); the arrival
  // is a rewind to a checkpoint that still holds the folded originals — an
  // echo class, not a new extension.
  state.lastPassIds = [EARLY];
  const out = remintCoveredLiveIds(
    [msg(EARLY, "hi"), msg(HASH, "a"), msg(`${HASH}_1`, "a")],
    state,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    [EARLY, HASH, `${HASH}_1`],
    "rewind echoes keep the converter ids so the block can resurrect",
  );
});
