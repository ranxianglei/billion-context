import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/state.js";
import { restampRefsToLedger, indexToRef, refToIndex, highestUsedIndex } from "../src/refs.js";
import type { CompressionState } from "../src/types.js";

/** #4316 layer 3 PR3/3 — legacy ref re-stamp to the ledger seq.
 *
 * The counter path numbers messages in arrival order but SKIPS protected
 * messages (BLOCKED takes no number) while the unified store still gives them
 * a row seq — so every ref minted after a protected message runs one ahead of
 * seq+1. The re-stamp aligns refs with (row seq + 1) exactly once per state:
 * refs become the ledger numbers the stamped lanes already use, and the model
 * citation space matches the storage truth.
 */

function stateWith(
  byRaw: Record<string, string>,
  extra?: { deadRefs?: string[]; nextIndex?: number },
): CompressionState {
  const state = createInitialState();
  state.messageRefs = { byRaw: { ...byRaw }, byRef: {} };
  for (const [rawId, ref] of Object.entries(byRaw)) {
    if (ref !== "BLOCKED") state.messageRefs.byRef[ref] = rawId;
  }
  if (extra?.deadRefs) state.deadRefs = [...extra.deadRefs];
  if (extra?.nextIndex !== undefined) state.messageRefs.nextIndex = extra.nextIndex;
  return state;
}

test("S13a: re-stamp aligns refs to seq+1, BLOCKED stays, once, superseded recorded", () => {
  // Rows: seq0=a, seq1=b, seq2=c(protected), seq3=d, seq4=e.
  // Legacy counter refs: c is BLOCKED (no number), so d/e run one ahead of seq+1.
  const state = stateWith(
    { a: "m00001", b: "m00002", c: "BLOCKED", d: "m00003", e: "m00004" },
    { nextIndex: 5 },
  );
  const seqByRaw = new Map<string, number>([
    ["a", 0],
    ["b", 1],
    ["c", 2],
    ["d", 3],
    ["e", 4],
  ]);
  const out = restampRefsToLedger(state, seqByRaw);
  // a/b were already aligned (seq+1); d/e shift by one; c stays BLOCKED.
  assert.equal(state.messageRefs.byRaw.a, "m00001");
  assert.equal(state.messageRefs.byRaw.b, "m00002");
  assert.equal(state.messageRefs.byRaw.c, "BLOCKED");
  assert.equal(state.messageRefs.byRaw.d, "m00004");
  assert.equal(state.messageRefs.byRaw.e, "m00005");
  // byRef mirrors the new ownership.
  assert.equal(state.messageRefs.byRef.m00004, "d");
  assert.equal(state.messageRefs.byRef.m00005, "e");
  assert.equal(state.messageRefs.byRef.m00003, undefined);
  // counters: 2 aligned before, 2 re-stamped, 1 blocked.
  assert.equal(out.kept, 2);
  assert.equal(out.restamped, 2);
  assert.equal(out.blocked, 1);
  // superseded: d's old number now means something else (nothing) — recorded
  // so a replayed compress call holding the pre-restart mapping is rejected
  // instead of silently folding the wrong range.
  // superseded: every old ref→rawId mapping that changed hands — a replayed
  // compress call holding pre-restart refs gets rejected instead of silently
  // folding the wrong range.
  assert.equal(out.superseded.get("m00003"), "d");
  assert.equal(out.superseded.get("m00004"), "e");
  // once-flag set; a second call is a no-op.
  assert.equal(state.refLedgerAligned, true);
  const again = restampRefsToLedger(state, seqByRaw);
  assert.equal(again.restamped, 0);
  assert.equal(again.kept, 0);
  // The derived cursor (highestUsedIndex+1, the compress.ts:1047 pattern)
  // advances past the highest stamp: e now holds m00005 → next mint is m00006.
  assert.ok(highestUsedIndex(state.messageRefs) >= 5);
});

test("S13b: swapped refs re-stamp — the first mover aligns, the second parks (#5196)", () => {
  // a lives at seq0 but holds m00002; b at seq1 holds m00001 (swapped by history).
  // Pre-#5196 both sides moved atomically; now whichever mover stamps first
  // retires its FROM-slot, so the other's seat is taken over only if it was
  // never vacated — here b's target m2 was retired by a's stamp → b PARKS on
  // a fresh number instead of swapping. No live ref may carry two identities.
  const state = stateWith({ a: "m00002", b: "m00001" }, { nextIndex: 3 });
  const seqByRaw = new Map<string, number>([
    ["a", 0],
    ["b", 1],
  ]);
  const out = restampRefsToLedger(state, seqByRaw);
  // a lands on its ledger seat; its old slot m2 stays retired.
  assert.equal(state.messageRefs.byRaw.a, "m00001");
  assert.equal(state.messageRefs.byRef.m00001, "a");
  // b must NOT take m2 — parked fresh, alias m1 still names b.
  assert.notEqual(state.messageRefs.byRaw.b, "m00002");
  assert.match(state.messageRefs.byRaw.b!, /^m\d{5,}$/);
  assert.equal(refToIndex(state.messageRefs.byRaw.b!)!, 3);
  assert.equal(state.messageRefs.byRef.m00002, undefined);
  assert.equal(out.restamped, 1);
  assert.equal(out.rehomed, 1);
  assert.equal(out.superseded.get("m00001"), "b");
  assert.equal(out.superseded.get("m00002"), "a");
});

test("S13c: unbacked raw ids keep their refs; dead refs stay reserved; unbacked displaced by a stamp is re-homed", () => {
  // f has no row (never stored) and keeps m00007. g holds m00005 with no row,
  // but the stamped e (seq 4) needs m00005 — g is displaced to a free number.
  const state = stateWith(
    { e: "m00004", f: "m00007", g: "m00005" },
    { deadRefs: ["m00009"], nextIndex: 8 },
  );
  const seqByRaw = new Map<string, number>([["e", 4]]);
  const out = restampRefsToLedger(state, seqByRaw);
  assert.equal(state.messageRefs.byRaw.e, "m00005");
  assert.equal(state.messageRefs.byRef.m00005, "e");
  // f untouched (unbacked, not displaced).
  assert.equal(state.messageRefs.byRaw.f, "m00007");
  // g displaced off m00005 onto a fresh number (never reuse the id contract
  // still holds — it keeps A ref).
  assert.notEqual(state.messageRefs.byRaw.g, "m00005");
  assert.match(state.messageRefs.byRaw.g!, /^m\d{5,}$/);
  assert.equal(out.rehomed, 1);
  // dead refs untouched.
  assert.deepEqual(state.deadRefs, ["m00009"]);
});

test("S13d: no-op for an already-aligned state (kept only, superseded empty)", () => {
  const state = stateWith({ a: "m00001", b: "m00002" }, { nextIndex: 3 });
  const seqByRaw = new Map<string, number>([
    ["a", 0],
    ["b", 1],
  ]);
  const out = restampRefsToLedger(state, seqByRaw);
  assert.equal(out.kept, 2);
  assert.equal(out.restamped, 0);
  assert.equal(out.rehomed, 0);
  assert.equal(out.superseded.size, 0);
  assert.equal(state.refLedgerAligned, true);
});

test("#5196: an intra-pass seat reuse is refused — the vacated slot stays owned by its pre-restart message", () => {
  // Issue shape exactly: A holds m00007 over row seq4 → target m00005; B holds
  // m00009 over row seq6 → target m00007. Legacy code stamped A m7→m5 first,
  // then B straight into the just-vacated m7 while superseded[m7]=A still
  // stood — the live-first host resolver then re-targeted every stale cite of
  // m7 at B (silent wrong-message fold, 0.1.209 field repro).
  const state = stateWith(
    { a: "m00007", b: "m00009" },
    { nextIndex: 10 },
  );
  const seqByRaw = new Map<string, number>([
    ["a", 4],
    ["b", 6],
  ]);
  const out = restampRefsToLedger(state, seqByRaw);
  // A lands on its ledger seat.
  assert.equal(state.messageRefs.byRaw.a, "m00005");
  assert.equal(state.messageRefs.byRef.m00005, "a");
  // B must NOT take over m7 — it parks on a fresh number at/after the cursor.
  assert.notEqual(state.messageRefs.byRaw.b, "m00007");
  assert.ok(
    refToIndex(state.messageRefs.byRaw.b!) !== null &&
      refToIndex(state.messageRefs.byRaw.b!) >= 10,
  );
  // m7 remains permanently retired: alias to A only, no live owner.
  assert.equal(state.messageRefs.byRef.m00007, undefined);
  assert.equal(out.superseded.get("m00007"), "a");
  assert.equal(out.superseded.get("m00009"), "b");
  assert.equal(out.rehomed, 1);
  assert.equal(state.refLedgerAligned, true);
});

test("#5196: a vacate chain parks the follower of a retired seat; untouched seats stay reusable", () => {
  // x(s0,m00002) stamps m1 → retires its FROM-slot m2. y(s1,m00003) wants
  // exactly m2 → parks fresh (its FROM-slot m3 is NOT retired: only the seats
  // a mover vacated WHILE STAMPING retire). z(s2,m00004) wants m3 → lands:
  // m3's alias still names y via superseded, live-first + translation compose
  // safely, exactly one park, no double identity.
  const state = stateWith(
    { x: "m00002", y: "m00003", z: "m00004" },
    { nextIndex: 5 },
  );
  const seqByRaw = new Map<string, number>([
    ["x", 0],
    ["y", 1],
    ["z", 2],
  ]);
  const out = restampRefsToLedger(state, seqByRaw);
  assert.equal(state.messageRefs.byRaw.x, "m00001");
  // y's seat m2 was retired by x's stamp → y parks fresh, keeps superseded[m3]=y.
  assert.notEqual(state.messageRefs.byRaw.y, "m00002");
  assert.equal(out.superseded.get("m00003"), "y");
  // z still lands on its true seat m3 (y moved off it; a mover never retires
  // the slot it LEAVES unless it stamped somewhere else first — here y did not
  // stamp, so m3 is clean ground for z).
  assert.equal(state.messageRefs.byRaw.z, "m00003");
  // Exactly one park, no double-identity ref anywhere.
  assert.equal(out.rehomed, 1);
});

test("#5196: the parked layout survives the next cold load untouched", () => {
  // Rebuild the same state AS IF loaded from storage after the pass above:
  // x at m1, y parked high, z at m3 — a second restamp must be a pure no-op
  // (refLedgerAligned guards it), which is what makes parking permanent
  // instead of a slow renumbering drip.
  const state = stateWith({ x: "m00001", y: "m00010", z: "m00003" }, {
    nextIndex: 11,
  });
  (state as CompressionState & { refLedgerAligned?: boolean }).refLedgerAligned =
    true;
  const seqByRaw = new Map<string, number>([
    ["x", 0],
    ["y", 1],
    ["z", 2],
  ]);
  const out = restampRefsToLedger(state, seqByRaw);
  assert.equal(out.kept + out.restamped + out.rehomed, 0);
  assert.equal(state.messageRefs.byRaw.y, "m00010");
  assert.equal(state.messageRefs.byRaw.z, "m00003");
});

for (const fixture of [
  { name: "retired-seat leftover", byRaw: { a: "m00007", b: "m00009" }, seqs: [["a", 4], ["b", 6]], parked: "b", mover: "a", target: "m00005" },
  { name: "displaced unbacked owner", byRaw: { a: "m00004", b: "m00005" }, seqs: [["a", 4]], parked: "b", mover: "a", target: "m00005" },
  { name: "displaced and leftover overlap", byRaw: { a: "m00002", b: "m00001" }, seqs: [["a", 0], ["b", 1]], parked: "b", mover: "a", target: "m00001" },
] satisfies Array<{ name: string; byRaw: Record<string, string>; seqs: Array<[string, number]>; parked: string; mover: string; target: string }>) {
  test(`#5196 composition: ${fixture.name} parks above orphan and tombstone history`, () => {
    const state = stateWith({ ...fixture.byRaw, protected: "BLOCKED" }, { deadRefs: ["m00090"] });
    state.messageRefs.byRef.m00070 = "historical-orphan";
    const seqs = new Map([...fixture.seqs, ["protected", 99] as [string, number]]);
    const out = restampRefsToLedger(state, seqs);

    assert.equal(state.messageRefs.byRaw[fixture.parked], "m00091");
    assert.equal(state.messageRefs.byRef.m00091, fixture.parked);
    assert.equal(state.messageRefs.byRaw[fixture.mover], fixture.target);
    assert.equal(state.messageRefs.byRef[fixture.target], fixture.mover);
    assert.equal(state.messageRefs.byRef.m00070, "historical-orphan");
    assert.equal(state.messageRefs.byRef.m00090, undefined);
    assert.equal(state.messageRefs.byRaw.protected, "BLOCKED");
    assert.equal(out.rehomed, 1, "an owner in both settlement lists parks only once");
    assert.equal(out.blocked, 1);
    assert.deepEqual(state.deadRefs, ["m00090"]);
    if (fixture.name === "retired-seat leftover") {
      assert.equal(state.messageRefs.byRef.m00007, undefined);
      assert.equal(out.superseded.get("m00007"), "a");
    }
    const after = structuredClone(state);
    const again = restampRefsToLedger(state, seqs);
    assert.equal(again.kept + again.restamped + again.rehomed, 0);
    assert.deepEqual(state, after, "the parked layout and history survive a second pass");
  });
}

for (const seqs of [
  new Map([["a", 4], ["b", 6]]),
  new Map([["a", 8]]),
]) {
  test(`#5196 composition: exhausted ${seqs.size === 2 ? "leftover" : "displaced"} parking is atomic`, () => {
    const state = stateWith({ a: "m00007", b: "m00009" }, { deadRefs: ["m9999999"] });
    const before = structuredClone(state);
    assert.throws(() => restampRefsToLedger(state, seqs), /ref capacity exhausted/);
    assert.deepEqual(state, before, "no partial ref swap or aligned marker escapes a failed pass");
  });
}
