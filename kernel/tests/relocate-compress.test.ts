import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "../src/state.js";
import {
  planRelocateCompressCarriers,
  relocateCompressCarriers,
} from "../src/relocate-compress.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

/** Build a core message. Refs are assigned via state.messageRefs below. */
function msg(
  id: string,
  ref: string | null,
  contentType: CoreMessage["contentType"],
  extra: Partial<CoreMessage> = {},
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType,
    text: `text-of-${id}`,
    ...extra,
  };
}

function stateWith(
  blocks: Array<Partial<CompressionBlock>>,
  refs: Record<string, string>,
): CompressionState {
  const state = createInitialState();
  for (const [i, b] of blocks.entries()) {
    state.blocks.push({
      blockId: b.blockId ?? `b${i}`,
      runId: b.runId ?? `r${i}`,
      tier: 1,
      summary: "summary",
      directMessageIds: [],
      effectiveMessageIds: [],
      directBlockIds: [],
      createdAt: 1000 + i,
      survivedCount: 0,
      generation: "young",
      active: true,
      ...b,
    });
  }
  for (const [id, ref] of Object.entries(refs)) {
    state.messageRefs.byRaw[id] = ref;
    if (ref !== "BLOCKED") state.messageRefs.byRef[ref] = id;
  }
  return state;
}

function pair(callId: string) {
  const call = msg(
    `call-${callId}`,
    null,
    "tool-call",
    { toolName: "compress", toolCallId: callId },
  );
  const result = msg(
    `res-${callId}`,
    null,
    "tool-result",
    { toolCallId: callId },
  );
  return [call, result] as const;
}

const ids = (ms: CoreMessage[]): string[] => ms.map((m) => m.id);

test("no active block with numeric endRef ⇒ same array reference (no-op fast path)", () => {
  const messages = [msg("a", "m00001", "text")];
  const state = stateWith([], {});
  assert.equal(relocateCompressCarriers(messages, state), messages);
});

test("legacy block without endRef is skipped (cannot get a boundary)", () => {
  const [c, r] = pair("call1");
  const messages = [msg("a", "m00001", "text"), c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", summary: "s", startRef: undefined, endRef: undefined }],
    {},
  );
  // refs map irrelevant here; block lacks endRef → no candidate call id at all
  delete (state.blocks[0] as { startRef?: string }).startRef;
  assert.equal(relocateCompressCarriers(messages, state), messages);
});

test("inactive block is skipped even with numeric endRef", () => {
  const [c, r] = pair("call1");
  const messages = [msg("a", "m00001", "text"), c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", active: false, startRef: "m00001", endRef: "m00002" }],
    {},
  );
  assert.equal(relocateCompressCarriers(messages, state), messages);
});

test("basic move: pair lands before first surviving core whose ref exceeds endRef", () => {
  // Fold covered m00001–m00002; protected survivors c (m00003), d (m00004).
  const a = msg("a", "m00003", "user");
  const b = msg("b", "m00004", "assistant");
  const [c, r] = pair("call1");
  const messages = [a, b, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003", b: "m00004" },
  );
  const out = relocateCompressCarriers(messages, state);
  // Survivors a (ref 3 > 2), so the pair must precede a — nothing before it.
  assert.deepEqual(ids(out), ["call-call1", "res-call1", "a", "b"]);
  // Original cores are moved by reference, never cloned.
  assert.equal(out[0], c);
  assert.equal(out[1], r);
});

test("pair already at its fold point keeps relative layout but still normalizes (moved-by-ref)", () => {
  const a = msg("a", "m00005", "user");
  const b = msg("b", "m00006", "assistant");
  const [c, r] = pair("call1");
  const messages = [c, r, a, b]; // already before all survivors
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00004" }],
    { a: "m00005", b: "m00006" },
  );
  const out = relocateCompressCarriers(messages, state);
  assert.deepEqual(ids(out), ["call-call1", "res-call1", "a", "b"]);
});

test("multi-range batch shares one call id ⇒ boundary is max(endRef)", () => {
  const x = msg("x", "m00008", "user"); // inside later fold range
  const y = msg("y", "m00011", "assistant"); // only survivor past both folds
  const [c, r] = pair("callB");
  // Live views follow ingest (ref) order: x (8) precedes y (11).
  const messages = [x, c, r, y];
  const state = stateWith(
    [
      { blockId: "b1", compressCallId: "callB", startRef: "m00001", endRef: "m00005" },
      { blockId: "b2", compressCallId: "callB", startRef: "m00007", endRef: "m00010" },
    ],
    { y: "m00011", x: "m00008" },
  );
  // Boundary = max(5,10)=10 ⇒ insert before y (11 > 10), after surviving x (8).
  const out = relocateCompressCarriers(messages, state);
  assert.deepEqual(ids(out), ["x", "call-callB", "res-callB", "y"]);
});

test("fold reaches the window end (#4732 regime) ⇒ append at tail", () => {
  const [c, r] = pair("call1");
  const a = msg("a", "m00002", "user"); // only core; ref ≤ boundary
  const messages = [a, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00002" },
  );
  const out = relocateCompressCarriers(messages, state);
  assert.deepEqual(ids(out), ["a", "call-call1", "res-call1"]);
});

test("duplicate tool-call cores for one call id ⇒ ambiguous, do not move", () => {
  const [c1, r1] = pair("call1");
  const c2 = msg("call-call1-again", null, "tool-call", {
    toolName: "compress",
    toolCallId: "call1",
  });
  const messages = [msg("a", "m00003", "user"), c1, r1, c2];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  assert.equal(relocateCompressCarriers(messages, state), messages);
});

test("non-adjacent result (foreign core between call and result) ⇒ skip", () => {
  const call = msg("mc", null, "tool-call", {
    toolName: "compress",
    toolCallId: "call1",
  });
  const result = msg("mr", null, "tool-result", { toolCallId: "call1" });
  const foreign = msg("f", "m00003", "text");
  const messages = [msg("a", "m00004", "user"), call, foreign, result];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00004", f: "m00003" },
  );
  assert.equal(relocateCompressCarriers(messages, state), messages);
});

test("result with mismatched toolCallId ⇒ not a pair, skip", () => {
  const call = msg("mc", null, "tool-call", {
    toolName: "compress",
    toolCallId: "call1",
  });
  const result = msg("mr", null, "tool-result", { toolCallId: "other" });
  const messages = [msg("a", "m00003", "user"), call, result];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  assert.equal(relocateCompressCarriers(messages, state), messages);
});

test("BLOCKED_REF cores are not qualifying boundaries (durable-BLOCKED edge)", () => {
  const protectedMsg = msg("prot", "BLOCKED", "user");
  const [c, r] = pair("call1");
  const messages = [protectedMsg, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { prot: "BLOCKED" },
  );
  // Nothing qualifies beyond the boundary ⇒ tail append (position unchanged here).
  const out = relocateCompressCarriers(messages, state);
  assert.deepEqual(ids(out), ["prot", "call-call1", "res-call1"]);
  assert.equal(out[0], protectedMsg);
});

test("thinking clear: predicate unset ⇒ reasoning kept even with clearThinking set", () => {
  const think = msg("t1", "m00009", "reasoning");
  const [c, r] = pair("call1");
  const a = msg("a", "m00010", "user");
  const messages = [think, c, r, a];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00008" }],
    { a: "m00010" },
  );
  const out = relocateCompressCarriers(messages, state, { clearThinking: true });
  // Pair moves before a; thinking follows it (kept).
  assert.deepEqual(ids(out), ["t1", "call-call1", "res-call1", "a"]);
});

test("thinking clear: predicate-gated drop of the contiguous run before the call", () => {
  const keep1 = msg("k1", "m00006", "reasoning");
  const drop1 = msg("d1", "m00007", "reasoning");
  const drop2 = msg("d2", "m00008", "reasoning");
  const [c, r] = pair("call1");
  const a = msg("a", "m00010", "user");
  const messages = [keep1, drop1, drop2, c, r, a];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00005" }],
    { a: "m00010", k1: "m00006" },
  );
  // Predicate accepts d1/d2 but refuses k1 (e.g. signed) — scan continues PAST
  // the refused core (documented behaviour). k1 survives with ref 6 > boundary
  // 5, so the pair lands before it.
  const out = relocateCompressCarriers(messages, state, {
    clearThinking: true,
    reasoningDroppable: (m) => m.id !== "k1",
  });
  assert.deepEqual(ids(out), ["call-call1", "res-call1", "k1", "a"]);
  assert.equal(out[2], keep1);
});

test("thinking clear: non-reasoning core stops the walk", () => {
  const textBefore = msg("t0", "m00006", "text");
  const drop = msg("d1", "m00007", "reasoning");
  const [c, r] = pair("call1");
  const a = msg("a", "m00010", "user");
  const messages = [textBefore, drop, c, r, a];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00005" }],
    { a: "m00010", t0: "m00004" },
  );
  const out = relocateCompressCarriers(messages, state, {
    clearThinking: true,
    reasoningDroppable: () => true,
  });
  assert.deepEqual(ids(out), ["t0", "call-call1", "res-call1", "a"]);
});

test("clearThinking without a predicate is a no-op for drops (conservative default)", () => {
  const drop = msg("d1", "m00007", "reasoning");
  const [c, r] = pair("call1");
  const a = msg("a", "m00010", "user");
  const messages = [drop, c, r, a];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00005" }],
    { a: "m00010" },
  );
  const out = relocateCompressCarriers(messages, state, { clearThinking: true });
  assert.deepEqual(ids(out), ["d1", "call-call1", "res-call1", "a"]);
});

test("idempotent: applying twice yields the identical layout", () => {
  const a = msg("a", "m00003", "user");
  const b = msg("b", "m00004", "assistant");
  const [c, r] = pair("call1");
  const messages = [a, b, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003", b: "m00004" },
  );
  const once = relocateCompressCarriers(messages, state);
  const twice = relocateCompressCarriers(once, state);
  assert.deepEqual(ids(twice), ids(once));
  for (let i = 0; i < once.length; i++) assert.equal(twice[i], once[i]);
});

test("interleaved calls: each pair lands at its own boundary regardless of slot order", () => {
  // A folds m00001–m00005, B folds m00006–m00008; survivors p (m00001? no—p is
  // pre-fold), q m00009... Construct post-fold reality: survivors only.
  const s1 = msg("s1", "m00009", "user");
  const s2 = msg("s2", "m00010", "assistant");
  const s3 = msg("s3", "m00011", "user");
  const [pa, ra] = pair("callA");
  const [pb, rb] = pair("callB");
  // B's pair sits EARLIER than A's although A's boundary (5) is smaller.
  const messages = [s1, pb, rb, pa, ra, s2, s3];
  const state = stateWith(
    [
      { blockId: "ba", compressCallId: "callA", startRef: "m00001", endRef: "m00005" },
      { blockId: "bb", compressCallId: "callB", startRef: "m00006", endRef: "m00008" },
    ],
    { s1: "m00009", s2: "m00010", s3: "m00011" },
  );
  // A: first survivor with ref>5 ⇒ s1 ⇒ k=0. B: same ⇒ k=0 too (both before s1);
  // tie-break by original callIndex (pb earlier) ⇒ pb,rb then pa,ra.
  const out = relocateCompressCarriers(messages, state);
  assert.deepEqual(ids(out), [
    "call-callB",
    "res-callB",
    "call-callA",
    "res-callA",
    "s1",
    "s2",
    "s3",
  ]);
});

test("two distinct boundaries place pairs at different survivor slots", () => {
  const t1 = msg("t1", "m00003", "user"); // > 2 (A's boundary) but ≤ 8 (B's)
  const s2 = msg("s2", "m00009", "assistant"); // > 8
  const [pa, ra] = pair("callA");
  const [pb, rb] = pair("callB");
  const messages = [t1, s2, pa, ra, pb, rb];
  const state = stateWith(
    [
      { blockId: "ba", compressCallId: "callA", startRef: "m00001", endRef: "m00002" },
      { blockId: "bb", compressCallId: "callB", startRef: "m00003", endRef: "m00008" },
    ],
    { t1: "m00003", s2: "m00009" },
  );
  const out = relocateCompressCarriers(messages, state);
  // A ⇒ before t1 (ref 3 > 2) ⇒ k=0; B ⇒ before s2 (first ref > 8) ⇒ k=1.
  assert.deepEqual(ids(out), [
    "call-callA",
    "res-callA",
    "t1",
    "call-callB",
    "res-callB",
    "s2",
  ]);
});

test("refs are untouched by relocation", () => {
  const a = msg("a", "m00003", "user");
  const [c, r] = pair("call1");
  const messages = [a, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  const before = structuredClone(state.messageRefs);
  relocateCompressCarriers(messages, state);
  assert.deepEqual(state.messageRefs, before);
});

test("isCompressTool override honours dialect names", () => {
  const call = msg("mc", null, "tool-call", {
    toolName: "acp_compress",
    toolCallId: "callX",
  });
  const result = msg("mr", null, "tool-result", { toolCallId: "callX" });
  const a = msg("a", "m00003", "user");
  const messages = [a, call, result];
  const state = stateWith(
    [{ blockId: "bx", compressCallId: "callX", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  // Bare-name matching alone would NOT move this pair.
  assert.equal(relocateCompressCarriers(messages, state), messages);
  // With the host dialect predicate it does.
  const out = relocateCompressCarriers(messages, state, {
    isCompressTool: (n) => n === "acp_compress",
  });
  assert.deepEqual(ids(out), ["mc", "mr", "a"]);
});

test("plan and apply agree on removed indices", () => {
  const a = msg("a", "m00003", "user");
  const [c, r] = pair("call1");
  const messages = [a, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  const plan = planRelocateCompressCarriers(messages, state);
  assert.equal(plan.changed, true);
  assert.deepEqual([...plan.removedInputIndices].sort((x, y) => x - y), [1, 2]);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].insertAtOutput, 0);
});
