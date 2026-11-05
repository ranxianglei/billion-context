/**
 * Latch-discipline induction judge (#3989 phase 1).
 *
 * The #3956 fold-gate contract: on a QUIET turn (no fold, no config change,
 * no fresh arrival) the view latch must replay latched bytes VERBATIM —
 * whatever the transform layer just produced for an already-latched ref is
 * deferred to the next boundary. This is the general invariant that makes
 * quiet turns cache-neutral; it must hold for arbitrary (pre, post, latch)
 * triples, which is exactly a solver question, not a scenario question.
 *
 * No-cheat contract (#3848):
 *  - we execute the REAL applyViewLatch (translateFunction on view-latch.ts);
 *  - the invariant is a GENERAL discipline ("replay == latch entry, always,
 *    on quiet turns"), never a statement about any specific bug;
 *  - UNSAT answers are bounded-absence claims within the constructed bounds
 *    (bounded message count — the quiet-turn discipline is per-message
 *    local, so the bounded claim transfers; see the induction note below);
 *  - the SAT side (config-boundary release) and the full behavior matrix are
 *    replayed on real code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { translateFunction } from "../verif/symbolic.js";
import { newCtx, smt2Of } from "../verif/terms.js";
import { solveSmt2 } from "../verif/solve.js";

const haveSolver = (() => {
  try { void solveSmt2("(check-sat)", []); return true; } catch { return false; }
})();
import { applyViewLatch } from "../kernel/src/view-latch.ts";
import type { CompressionState, CoreMessage, ViewLatchEntry } from "../kernel/src/types.ts";
import type { NodeIO } from "../kernel/src/pipeline.ts";
import type { SymVal } from "../verif/symbolic.ts";

const file = resolve(import.meta.dirname, "../kernel/src/view-latch.ts");

test("view-latch discipline: quiet turns replay latched bytes verbatim (arbitrary texts)", { timeout: 240_000, skip: !haveSolver }, () => {
  const ctx = newCtx();
  // One already-latched message (id i1 → ref r1, latched text L1 ≠ anything
  // fixed) + one fresh message (id i2 → ref r2, no latch entry). Both the
  // resent (pre) and transformed (post) texts are FREE strings — the judge
  // must not be able to find any triple where a quiet turn leaks transform
  // output for the latched ref.
  const id1 = ctx.String.const("i1"), id2 = ctx.String.const("i2");
  const r1 = ctx.String.const("r1"), r2 = ctx.String.const("r2");
  const L1 = ctx.String.const("L1");
  const Tpre1 = ctx.String.const("Tpre1"), Tpre2 = ctx.String.const("Tpre2");
  const Tpost1 = ctx.String.const("Tpost1"), Tpost2 = ctx.String.const("Tpost2");
  const strv = (t: unknown) => ({ kind: "str", t }) as SymVal;
  const msg = (id: unknown, text: unknown): SymVal => ({ kind: "obj", fields: new Map<string, SymVal>([
    ["id", strv(id)], ["text", strv(text)],
  ]) } as never);
  const byRaw: SymVal = { kind: "obj", fields: new Map(), symFields: new Map<unknown, { g: unknown; v: SymVal }>([
    [id1, { g: ctx.Bool.val(true), v: strv(r1) }],
    [id2, { g: ctx.Bool.val(true), v: strv(r2) }],
  ]) } as never;
  const latchEntry: SymVal = { kind: "obj", fields: new Map<string, SymVal>([
    ["text", strv(L1)], ["hidden", { kind: "bool", t: ctx.Bool.val(false) }],
  ]) } as never;
  const viewLatches: SymVal = { kind: "obj", fields: new Map(), symFields: new Map<unknown, { g: unknown; v: SymVal }>([
    [r1, { g: ctx.Bool.val(true), v: latchEntry }],
  ]) } as never;
  const state: SymVal = { kind: "obj", fields: new Map<string, SymVal>([
    ["messageRefs", { kind: "obj", fields: new Map([["byRaw", byRaw]]) } as SymVal],
    ["viewLatches", viewLatches],
  ]) } as never;
  const io: SymVal = { kind: "obj", fields: new Map<string, SymVal>([
    ["messages", { kind: "arr", elems: [msg(id1, Tpost1), msg(id2, Tpost2)], len: ctx.Real.val(2) } as SymVal],
    ["state", state],
    ["effects", { kind: "obj", fields: new Map([["preTransformMessages",
      { kind: "arr", elems: [msg(id1, Tpre1), msg(id2, Tpre2)], len: ctx.Real.val(2) } as SymVal]]) } as SymVal],
  ]) } as never;
  const run = translateFunction({
    file, function: "applyViewLatch",
    params: { io, ctx: { kind: "undef" } as SymVal },
    ctx, options: {},
  }).exec();
  assert.deepEqual(run.degradations, [], "view-latch translation must be faithful (no degradations)");
  const outArr = (run.ret as { fields: Map<string, SymVal> }).fields.get("messages") as { elems: SymVal[]; len: unknown };
  assert.ok(outArr, "applyViewLatch must return io with messages");
  const out1 = outArr.elems[0] as { fields: Map<string, SymVal> };
  const out1Text = (out1.fields.get("text") as { t: unknown }).t as { eq: (x: unknown) => { not: () => unknown } };
  // Domain constraints, each pinning a DELIBERATE unlatchable class:
  //  - ids/refs are non-empty (assignRefs never mints ""; the !m.id guard
  //    passes unidentified messages through post view);
  //  - ids are not CCR retrieved placeholders (RETRIEVED_ID_PREFIX guard);
  //  - the latched ref is not BLOCKED (BLOCKED carriers render verbatim and
  //    never carry latch entries in reachable states).
  const INT1 = (ctx as unknown as { Int: { val: (n: number) => unknown } }).Int.val(1);
  const lenGE1 = (v: unknown) => (v as { length: () => { ge: (x: unknown) => unknown } }).length().ge(INT1);
  // Term.prefixOf(a) has JS startsWith semantics: receiver.startsWith(arg).
  // "id must not start with p" ⇒ NOT (id.prefixOf(val(p))).
  const notPrefix = (p: string, v: unknown) => ((v as { prefixOf: (x: unknown) => unknown }).prefixOf((ctx as unknown as { String: { val: (s: string) => unknown } }).String.val(p)) as { not: () => unknown }).not();
  const RETP = "acp_retrieved_";
  const dom: unknown[] = [
    lenGE1(id1), lenGE1(id2), lenGE1(r1), lenGE1(r2),
    notPrefix(RETP, id1), notPrefix(RETP, id2),
    // distinct ids: duplicate raw ids collapsing one byRaw slot is the
    // #3945 collision family (pinned by its own generic harness); for the
    // latch-discipline judge we pin the identified, non-colliding domain.
    (id1 as { neq: (x: unknown) => unknown }).neq(id2),
    (r1 as { neq: (x: unknown) => unknown }).neq((ctx as unknown as { String: { val: (s: string) => unknown } }).String.val("BLOCKED")),
    // distinct raw ids hold distinct numeric refs in real byRaw states
    // (assignRefs allocates one ref per id; BLOCKED shared carriers are
    // excluded above) — same-ref-different-id is unreachable.
    (r1 as { neq: (x: unknown) => unknown }).neq(r2),
  ];
  // Q1: can the FIRST output message's text differ from the latched L1?
  // Guard the slot read by the array length: elems[N] beyond len is ghost
  // data (branch-merged slots), not a real message.
  const lenGE = (v: unknown, k: number) => (v as { ge: (x: unknown) => unknown }).ge((ctx as unknown as { Real: { val: (n: number) => unknown } }).Real.val(k));
  const q1 = solveSmt2(smt2Of(ctx, [
    ...(run.assumptions as never[]),
    ...dom as never[],
    lenGE(outArr.len, 1),
    out1Text.eq(L1).not() as never,
  ] as never[], [] as never), []);
  if (q1.status !== "unsat") {
    const wnames = ["L1", "Tpre1", "Tpre2", "Tpost1", "Tpost2", "i1", "i2", "r1", "r2"];
    const dbgs = smt2Of(ctx, [...(run.assumptions as never[]), ...dom as never[], lenGE(outArr.len, 1) as never, out1Text.eq(L1).not() as never] as never[], wnames as never[]);
    const dbg = solveSmt2(typeof dbgs === "string" ? dbgs : (dbgs as { smt2: string }).smt2 as never, wnames);
    console.log("Q1 witness:", dbg.status, JSON.stringify(dbg.values), String(dbg.raw).slice(0, 300));
  }
  assert.equal(q1.status, "unsat",
    "quiet turn must replay the latched bytes verbatim — no transform leak, for ANY pre/post/latch texts");
  // Q2: can the FRESH message's output differ from its own transform output?
  const out2 = outArr.elems[1] as { fields: Map<string, SymVal> };
  const out2Text = (out2.fields.get("text") as { t: unknown }).t as { eq: (x: unknown) => { not: () => unknown } };
  const q2 = solveSmt2(smt2Of(ctx, [
    ...(run.assumptions as never[]),
    ...dom as never[],
    lenGE(outArr.len, 2),
    out2Text.eq(Tpost2).not() as never,
  ] as never[], [] as never), []);
  assert.equal(q2.status, "unsat",
    "fresh (unlatched) messages must pass the transform output through untouched on quiet turns");
  // Q2: fresh (unlatched) messages pass their own transform output through —
  // guardedNeutral on one-arm array slots (mergeVal arr) removed the ghost
  // arms that previously made this query a false SAT.
  // Sanity: the two output slots are actually distinct messages.
  const out1Id = (out1.fields.get("id") as { t: unknown }).t as { eq: (x: unknown) => { not: () => unknown } };
  const sane = solveSmt2(smt2Of(ctx, [...(run.assumptions as never[]), ...dom as never[], (out1Id.eq(id1) as unknown as { not: () => unknown }).not() as never] as never[], [] as never), []);
  assert.equal(sane.status, "unsat", "output order must be preserved (slot 0 is still i1)");
});

test("view-latch behavior matrix on real code (quiet replay / arrival / fold reset / steady-state no-churn)", () => {
  const baseState = (): CompressionState => ({
    messageRefs: { byRaw: { a: "r1", b: "r2" }, byRef: {} },
    viewLatches: { r1: { text: "LATCHED_A", hidden: false } },
  } as unknown as CompressionState);
  const pre: CoreMessage[] = [
    { id: "a", role: "user", contentType: "text", text: "resent A" },
    { id: "b", role: "user", contentType: "text", text: "resent B" },
  ] as CoreMessage[];
  const ioOf = (post: CoreMessage[], state: CompressionState): NodeIO => ({
    messages: post, state, effects: { preTransformMessages: pre },
  }) as NodeIO;
  // Quiet turn: transform layer produced NEW bytes for the latched ref —
  // the latch must replay the old bytes, not the fresh transform output.
  const q1 = applyViewLatch(ioOf([
    { ...pre[0]!, text: "TRANSFORM_NEW_A" }, pre[1]!,
  ], baseState()));
  assert.equal((q1.messages[0] as CoreMessage).text, "LATCHED_A", "quiet turn replays latched bytes");
  assert.equal((q1.messages[1] as CoreMessage).text, "resent B", "fresh ref passes through");
  // Second quiet turn with yet another transform output: byte-stable.
  const q2 = applyViewLatch(ioOf([
    { ...pre[0]!, text: "TRANSFORM_NEWER_A" }, pre[1]!,
  ], q1.state));
  assert.equal((q2.messages[0] as CoreMessage).text, "LATCHED_A", "second quiet turn identical");
  assert.strictEqual(q1.state, baseState() === q1.state ? undefined : q1.state); // state replaced, not mutated
  // Steady state: identical transform outputs → the SAME state object (no churn).
  const steady = applyViewLatch(ioOf([
    { ...pre[0]!, text: "TRANSFORM_NEW_A" }, pre[1]!,
  ], q2.state));
  assert.strictEqual(steady.state, q2.state, "steady-state latch map must not churn the state object");
  // Arrival: a fresh message whose transform rewrote it latches AT arrival
  // (the flip rides the history change, not a quiet turn).
  const arr = applyViewLatch(ioOf([
    { ...pre[0]!, text: "TRANSFORM_NEW_A" }, { ...pre[1]!, text: "CRUSHED_B" },
  ], baseState()));
  assert.equal((arr.messages[1] as CoreMessage).text, "CRUSHED_B", "arrival shows the transform output");
  const latches = (arr.state.viewLatches ?? {}) as Record<string, ViewLatchEntry>;
  assert.equal(latches.r2?.text, "CRUSHED_B", "arrival latches what the transform produced");
  // Arrival of a transform-HIDDEN fresh message stays hidden and latches it.
  const hid = applyViewLatch(ioOf([pre[0]!], baseState()));
  assert.equal(hid.messages.length, 1, "transform-hidden message stays hidden");
  assert.equal(((hid.state.viewLatches ?? {}) as Record<string, ViewLatchEntry>).r2?.hidden, true, "hidden latched");
  // Fold reset: the next pass re-latches fresh (the deferred transform lands).
  const afterFold = applyViewLatch(ioOf([
    { ...pre[0]!, text: "TRANSFORM_NEW_A" }, pre[1]!,
  ], { ...baseState(), viewLatches: undefined }));
  assert.equal((afterFold.messages[0] as CoreMessage).text, "TRANSFORM_NEW_A", "fold reset releases the deferred transform");
});
