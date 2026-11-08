import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "../src/state.js";
import {
  planRelocateCompressCarriers,
  relocateCompressCarriers,
  RELOCATED_POINTER_MARKER,
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
const carrierId = (callId: string): string => `acp_reloc_${callId}`;

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

test("basic relocate: summary carrier lands at the fold point, pair stays in its slot with pointer args", () => {
  // Fold covered m00001–m00002; protected survivors a (m00003), b (m00004); the
  // pair sits chronologically AFTER the survivors (the model compressed older
  // history later on).
  const a = msg("a", "m00003", "text");
  const b = msg("b", "m00004", "text");
  const [c, r] = pair("call1");
  const messages = [a, b, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003", b: "m00004" },
  );
  const out = relocateCompressCarriers(messages, state);
  // Carrier before the first survivor past the boundary (a, ref 3 > 2); the
  // pair keeps its chronological slot at the end.
  assert.deepEqual(ids(out), [carrierId("call1"), "a", "b", "call-call1", "res-call1"]);
  // Survivors and the result core are forwarded by reference, never cloned.
  assert.equal(out[1], a);
  assert.equal(out[2], b);
  assert.equal(out[4], r);
  // The call core is a shallow CLONE carrying the pointer args.
  assert.notEqual(out[3], c);
  assert.ok(out[3]!.text!.includes(RELOCATED_POINTER_MARKER));
  assert.ok(out[3]!.text!.includes("b1"));
  // The input core is not mutated.
  assert.equal(c.text, "text-of-call-call1");
});

test("carrier text carries the summary; non-JSON args are used verbatim", () => {
  const a = msg("a", "m00003", "text");
  const [c, r] = pair("call1");
  c.text = "RAW-SUMMARY-BODY";
  const messages = [a, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  const out = relocateCompressCarriers(messages, state);
  const carrier = out[0]!;
  assert.equal(carrier.id, carrierId("call1"));
  assert.equal(carrier.role, "user");
  assert.equal(carrier.contentType, "text");
  assert.ok(carrier.text!.startsWith(`[bili fold summary — block(s) b1; relocated from compress call call1`));
  assert.ok(carrier.text!.endsWith("\nRAW-SUMMARY-BODY"));
});

test("carrier text extracts .content from JSON args (plugin dialect)", () => {
  const a = msg("a", "m00003", "text");
  const [c, r] = pair("call1");
  c.text = JSON.stringify({ content: "SUMMARY-TEXT", ranges: ["m00001-m00002"] });
  const messages = [a, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  const out = relocateCompressCarriers(messages, state);
  const carrier = out[0]!;
  assert.ok(carrier.text!.includes("SUMMARY-TEXT"));
  assert.ok(!carrier.text!.includes("SUMMARY-TEXT\"")); // no JSON wrapper residue
});

test("pointer args are valid JSON embedding the marker and the block ids", () => {
  const a = msg("a", "m00003", "text");
  const [c, r] = pair("call1");
  const messages = [a, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  const out = relocateCompressCarriers(messages, state);
  const callOut = out.find((m) => m.id === "call-call1")!;
  const parsed = JSON.parse(callOut.text!) as { content: string };
  assert.ok(parsed.content.startsWith(RELOCATED_POINTER_MARKER));
  assert.ok(parsed.content.includes("b1"));
  assert.ok(parsed.content.includes("do not re-compress"));
});

test("already relocated call (marker in args, carrier present) ⇒ same array reference", () => {
  // Hosts may round-trip a view: carrier ids survive AND the args keep the
  // pointer. Both probes must independently make the plan a no-op.
  const a = msg("a", "m00003", "text");
  const [c, r] = pair("call1");
  const once = relocateCompressCarriers([a, c, r], stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  ));
  // Carrier present ⇒ skip.
  assert.equal(relocateCompressCarriers(once, stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  )), once);
  // Marker only (carrier id stripped by a host round-trip) ⇒ skip.
  const markerOnly: CoreMessage[] = once.filter((m) => m.id !== carrierId("call1"));
  assert.equal(relocateCompressCarriers(markerOnly, stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  )), markerOnly);
});

test("idempotent: applying twice yields the identical array", () => {
  const a = msg("a", "m00003", "text");
  const b = msg("b", "m00004", "text");
  const [c, r] = pair("call1");
  const messages = [a, b, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003", b: "m00004" },
  );
  const once = relocateCompressCarriers(messages, state);
  const twice = relocateCompressCarriers(once, state);
  assert.equal(twice, once);
});

test("duplicate tool-call cores for one call id ⇒ ambiguous, do not touch", () => {
  const [c1, r1] = pair("call1");
  const c2 = msg("call-call1-again", null, "tool-call", {
    toolName: "compress",
    toolCallId: "call1",
  });
  const messages = [msg("a", "m00003", "text"), c1, r1, c2];
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
  const messages = [msg("a", "m00004", "text"), call, foreign, result];
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
  const messages = [msg("a", "m00003", "text"), call, result];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  assert.equal(relocateCompressCarriers(messages, state), messages);
});

test("BLOCKED_REF cores are not qualifying boundaries (durable-BLOCKED edge)", () => {
  const protectedMsg = msg("prot", "BLOCKED", "text");
  const [c, r] = pair("call1");
  const messages = [protectedMsg, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { prot: "BLOCKED" },
  );
  // Nothing qualifies beyond the boundary ⇒ carrier appended at the tail; the
  // pair stays in its slot untouched except the pointer rewrite.
  const out = relocateCompressCarriers(messages, state);
  assert.deepEqual(ids(out), ["prot", "call-call1", "res-call1", carrierId("call1")]);
  assert.equal(out[0], protectedMsg);
});

test("multi-range batch shares one call id ⇒ boundary is max(endRef), pointer lists all blocks", () => {
  const x = msg("x", "m00008", "text"); // inside later fold range
  const y = msg("y", "m00011", "text"); // only survivor past both folds
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
  // Boundary = max(5,10)=10 ⇒ carrier before y (11 > 10), after x (8).
  const out = relocateCompressCarriers(messages, state);
  assert.deepEqual(ids(out), ["x", "call-callB", "res-callB", carrierId("callB"), "y"]);
  const callOut = out.find((m) => m.id === "call-callB")!;
  assert.ok(callOut.text!.includes("b1, b2"));
});

test("fold reaches the window end (#4732 regime) ⇒ carrier appended at tail", () => {
  const [c, r] = pair("call1");
  const a = msg("a", "m00002", "text"); // only core; ref ≤ boundary
  const messages = [a, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00002" },
  );
  const out = relocateCompressCarriers(messages, state);
  assert.deepEqual(ids(out), ["a", "call-call1", "res-call1", carrierId("call1")]);
});

test("thinking clear: predicate unset ⇒ reasoning kept even with clearThinking set", () => {
  const think = msg("t1", "m00009", "reasoning");
  const [c, r] = pair("call1");
  const a = msg("a", "m00010", "text");
  const messages = [think, c, r, a];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00008" }],
    { a: "m00010" },
  );
  const out = relocateCompressCarriers(messages, state, { clearThinking: true });
  // Pair stays in its slot; thinking kept; carrier before the first ref>8 (a).
  assert.deepEqual(ids(out), ["t1", "call-call1", "res-call1", carrierId("call1"), "a"]);
});

test("thinking clear: predicate-gated drop of the contiguous run before the call", () => {
  const keep1 = msg("k1", "m00006", "reasoning");
  const drop1 = msg("d1", "m00007", "reasoning");
  const drop2 = msg("d2", "m00008", "reasoning");
  const [c, r] = pair("call1");
  const a = msg("a", "m00010", "text");
  const messages = [keep1, drop1, drop2, c, r, a];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00005" }],
    { a: "m00010", k1: "m00006" },
  );
  // Predicate accepts d1/d2 but refuses k1 (e.g. signed) — scan continues PAST
  // the refused core (documented behaviour). Dropped cores never qualify as
  // boundaries; first qualifying survivor is k1 (6 > 5).
  // v2: the pair KEEPS its slot (after k1 in the input); only the carrier
  // moves (before k1, the first qualifying survivor).
  const out = relocateCompressCarriers(messages, state, {
    clearThinking: true,
    reasoningDroppable: (m) => m.id !== "k1",
  });
  assert.deepEqual(ids(out), [carrierId("call1"), "k1", "call-call1", "res-call1", "a"]);
  assert.equal(out[1], keep1);
});

test("thinking clear: non-reasoning core stops the walk", () => {
  const textBefore = msg("t0", "m00006", "text");
  const drop = msg("d1", "m00007", "reasoning");
  const [c, r] = pair("call1");
  const a = msg("a", "m00010", "text");
  const messages = [textBefore, drop, c, r, a];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00005" }],
    { a: "m00010", t0: "m00004" },
  );
  const out = relocateCompressCarriers(messages, state, {
    clearThinking: true,
    reasoningDroppable: () => true,
  });
  assert.deepEqual(ids(out), ["t0", "call-call1", "res-call1", carrierId("call1"), "a"]);
});

test("interleaved calls: carriers land at their boundaries regardless of pair slot order", () => {
  const s1 = msg("s1", "m00009", "text");
  const s2 = msg("s2", "m00010", "text");
  const s3 = msg("s3", "m00011", "text");
  const [pa, ra] = pair("callA");
  const [pb, rb] = pair("callB");
  // B's pair sits EARLIER than A's although A's boundary (5) is smaller; both
  // pairs keep their slots, only carriers are emitted (k=0 for both).
  const messages = [s1, pb, rb, pa, ra, s2, s3];
  const state = stateWith(
    [
      { blockId: "ba", compressCallId: "callA", startRef: "m00001", endRef: "m00005" },
      { blockId: "bb", compressCallId: "callB", startRef: "m00006", endRef: "m00008" },
    ],
    { s1: "m00009", s2: "m00010", s3: "m00011" },
  );
  const out = relocateCompressCarriers(messages, state);
  assert.deepEqual(ids(out), [
    carrierId("callB"),
    carrierId("callA"),
    "s1",
    "call-callB",
    "res-callB",
    "call-callA",
    "res-callA",
    "s2",
    "s3",
  ]);
});

test("two distinct boundaries place carriers at different survivor slots", () => {
  const t1 = msg("t1", "m00003", "text"); // > 2 (A's boundary) but ≤ 8 (B's)
  const s2 = msg("s2", "m00009", "text"); // > 8
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
    carrierId("callA"),
    "t1",
    carrierId("callB"),
    "s2",
    "call-callA",
    "res-callA",
    "call-callB",
    "res-callB",
  ]);
});

test("refs are untouched by relocation", () => {
  const a = msg("a", "m00003", "text");
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
  const a = msg("a", "m00003", "text");
  const messages = [a, call, result];
  const state = stateWith(
    [{ blockId: "bx", compressCallId: "callX", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  // Bare-name matching alone would NOT relocate this pair.
  assert.equal(relocateCompressCarriers(messages, state), messages);
  // With the host dialect predicate it does.
  const out = relocateCompressCarriers(messages, state, {
    isCompressTool: (n) => n === "acp_compress",
  });
  assert.deepEqual(ids(out), [carrierId("callX"), "a", "mc", "mr"]);
});

test("plan and apply agree: no pair removals in v2, pointer+carrier well-formed", () => {
  const a = msg("a", "m00003", "text");
  const [c, r] = pair("call1");
  const messages = [a, c, r];
  const state = stateWith(
    [{ blockId: "b1", compressCallId: "call1", startRef: "m00001", endRef: "m00002" }],
    { a: "m00003" },
  );
  const plan = planRelocateCompressCarriers(messages, state);
  assert.equal(plan.changed, true);
  // v2: the pair is NOT removed — only dropped reasoning ever lands here.
  assert.deepEqual([...plan.removedInputIndices], []);
  assert.equal(plan.moves.length, 1);
  const move = plan.moves[0]!;
  assert.equal(move.callIndex, 1);
  assert.equal(move.resultIndex, 2);
  assert.equal(move.insertAtOutput, 0); // before a (ref 3 > 2)
  assert.equal(move.carrier.id, carrierId("call1"));
  assert.ok(move.pointerText.includes(RELOCATED_POINTER_MARKER));
});
