import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { translateFunction } from "../verif/symbolic.js";
import { newCtx, smt2Of } from "../verif/terms.js";
import type { Seq } from "../verif/terms.js";
import { solveSmt2 } from "../verif/solve.js";
import { assignRefs } from "../kernel/src/refs.js";
import { renderVisibleRefs } from "../kernel/src/render-refs.js";
import { defaultCountTokens } from "../kernel/src/tokenize.js";
import type { CoreMessage } from "../kernel/src/types.js";

/**
 * Generic arbitrary-input discovery (issue #3848 acceptance, directive: find
 * bugs under ARBITRARY inputs — not scenario-shaped harnesses).
 *
 * Input model: EVERYTHING symbolic. Message ids, roles, contentTypes and
 * texts are free string constants; protection flags are free booleans per
 * turn. Nothing encodes a known bug shape.
 *
 * Invariant under test (I1, append-only stability): when the host resends
 * the same history with one more message appended (turn A → turn B), the
 * rendered bytes of every message that was already visible in turn A must
 * be IDENTICAL in turn B.
 *
 * Q1: violation reachable?  (expect SAT — at minimum the known #3805
 *     durable-ref migration re-emerges from the general model)
 * Q2: violation reachable WITHOUT any protection dropping?
 *     (p_i → q_i for all i). Expect UNSAT since #3945 was fixed: the
 *     id-collision re-tag (m3 reusing m1's raw id while unprotected stole
 *     the shared BLOCKED binding and re-tagged m1's sent bytes) is no
 *     longer reachable — refs.ts keeps the binding while ANY same-id
 *     message is protected.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const REFS = `${REPO}kernel/src/refs.ts`;
const RENDER_REFS = `${REPO}kernel/src/render-refs.ts`;

type SymVal = Record<string, unknown>;

interface TurnOut {
  rendered: SymVal[];
  assumptions: unknown[];
  ctx: ReturnType<typeof newCtx>;
  degradations: string[];
}

test("generic append-only stability: arbitrary inputs over assignRefs + renderVisibleRefs", { timeout: 300_000 }, async (t) => {
  const haveSolver = (() => { try { return solveSmt2("(set-logic ALL)(check-sat)", []).status === "sat"; } catch { return false; } })();
  if (!haveSolver) return t.skip("no SMT solver available (set VERIF_PYTHON or VERIF_SOLVER_CMD)");

  const ctx = newCtx();
  const strv = (v: string) => ({ kind: "str", t: ctx.String.val(v) }) as never;
  const numv = (n: number) => ({ kind: "num", t: ctx.Real.val(n) }) as never;
  const boolv = (b: boolean) => ({ kind: "bool", t: ctx.Bool.val(b) }) as never;
  const objOf = (f: Record<string, unknown>) => ({ kind: "obj", fields: new Map(Object.entries(f)) }) as never;
  const arrOf = (elems: unknown[]) => ({ kind: "arr", elems, len: ctx.Real.val(elems.length) }) as never;

  // Arbitrary messages: every field a free symbolic constant.
  const mkMsg = (tag: string) => objOf({
    id: { kind: "str", t: ctx.String.const(`${tag}_id`) },
    role: { kind: "str", t: ctx.String.const(`${tag}_role`) },
    contentType: { kind: "str", t: ctx.String.const(`${tag}_ct`) },
    text: { kind: "str", t: ctx.String.const(`${tag}_text`) },
  });
  const m1 = mkMsg("m1"), m2 = mkMsg("m2"), m3 = mkMsg("m3");
  // Texts non-empty and reasonably short (solver bound, not a shape).
  const textLenBound = (name: string): unknown => {
    const x = ctx.String.const(name) as Seq<"main">;
    const lenR = ctx.ToReal(x.length() as never) as unknown as { ge(a: unknown): { and(b: unknown): unknown }; le(a: unknown): unknown };
    return lenR.ge(ctx.Real.val(1)).and(lenR.le(ctx.Real.val(200)));
  };
  const p1 = ctx.Bool.const("p1") as { implies(x: unknown): { and(b: unknown): unknown } }, p2 = ctx.Bool.const("p2") as { implies(x: unknown): unknown };
  const q1 = ctx.Bool.const("q1"), q2 = ctx.Bool.const("q2"), q3 = ctx.Bool.const("q3");
  void q3;

  const meterPort = (a: unknown) => {
    const t = (a as { t: { length(): unknown } }).t;
    const r = ctx.ToReal(t.length() as never) as unknown as { div(x: unknown): { add(y: unknown): unknown } };
    return { kind: "num", t: r.div(ctx.Real.val(4)).add(ctx.Real.val(1)) } as never;
  };
  const protFor = (table: [SymVal, unknown][]) => (_recv: unknown, m: unknown) => {
    // The port receives the MESSAGE object; match by SymVal identity — obj
    // values carry no .t, an earlier .t-based compare never matched and
    // silently pinned every protection to false (Q1 went UNSAT).
    for (const [want, val] of table) if (want === (m as SymVal)) return { kind: "bool", t: val };
    return { kind: "bool", t: ctx.Bool.val(false) };
  };

  const emptyMap = objOf({ byRaw: objOf({}), byRef: objOf({}) });

  const runAssign = (msgs: unknown[], existing: unknown, nextIndex: unknown, prot: unknown) =>
    translateFunction({
      file: REFS, function: "assignRefs",
      params: { messages: arrOf(msgs), options: objOf({ existing, nextIndex }) } as never,
      ctx,
      options: { portImpls: { __method_isProtected: prot as never, countTokens: meterPort } } as never,
    }).exec();

  const runRender = (msgs: unknown[], state: unknown) =>
    translateFunction({
      file: RENDER_REFS, function: "renderVisibleRefs",
      params: { messages: arrOf(msgs), state, countTokens: numv(0), strategy: strv("text-only") } as never,
      ctx,
      options: { portImpls: { countTokens: meterPort } } as never,
    }).exec();

  // ---- turn A: [m1, m2] ----
  const outA = runAssign([m1, m2], emptyMap, numv(1), protFor([[m1, p1], [m2, p2]]));
  assert.deepEqual(outA.degradations, [], `turn-A assignRefs degradations: ${JSON.stringify(outA.degradations)}`);
  const mapA = (outA.ret as { fields: Map<string, unknown> }).fields.get("map");
  const nextA = (outA.ret as { fields: Map<string, unknown> }).fields.get("nextIndex");
  const stateA = objOf({ messageRefs: mapA });
  const rendA = runRender([m1, m2], stateA as never);
  assert.deepEqual(rendA.degradations, [], `turn-A render degradations: ${JSON.stringify(rendA.degradations)}`);
  const rendAArr = (rendA.ret as { elems: SymVal[] }).elems;

  // ---- turn B: same history + m3 appended ----
  const outB = runAssign([m1, m2, m3], mapA, nextA, protFor([[m1, q1], [m2, q2], [m3, q3]]));
  assert.deepEqual(outB.degradations, [], `turn-B assignRefs degradations: ${JSON.stringify(outB.degradations)}`);
  const mapB = (outB.ret as { fields: Map<string, unknown> }).fields.get("map");
  const stateB = objOf({ messageRefs: mapB });
  const rendB = runRender([m1, m2, m3], stateB as never);
  assert.deepEqual(rendB.degradations, [], `turn-B render degradations: ${JSON.stringify(rendB.degradations)}`);
  const rendBArr = (rendB.ret as { elems: SymVal[] }).elems;

  // ---- I1 property: rendered[i] turn A == rendered[i] turn B, i ∈ {0,1} ----
  const textOf = (m: SymVal): unknown => (m.fields as Map<string, unknown>).get("text");
  const valEqStr = (a: unknown, b: unknown): unknown => (a as { t: { eq(x: unknown): unknown } }).t.eq((b as { t: unknown }).t);
  const stable0 = valEqStr(textOf(rendAArr[0]!), textOf(rendBArr[0]!)) as { not(): { or(b: unknown): unknown } };
  const stable1 = valEqStr(textOf(rendAArr[1]!), textOf(rendBArr[1]!)) as { not(): unknown };
  const violation = stable0.not().or(stable1.not()) as unknown;

  const baseAsserts = [
    textLenBound("m1_text"), textLenBound("m2_text"), textLenBound("m3_text"),
    ...outA.assumptions, ...rendA.assumptions, ...outB.assumptions, ...rendB.assumptions,
  ] as never[];

  // Q1: can ANY arbitrary input violate append-only stability?
  const names = ["p1", "p2", "q1", "q2", "q3"];
  let q1res: ReturnType<typeof solveSmt2>;
  try { q1res = solveSmt2(smt2Of(ctx, [...baseAsserts, violation] as never[], names as never), []); }
  catch (e) { t.skip(`solver unavailable mid-test: ${(e as Error).message.slice(0, 200)}`); return; }
  assert.equal(q1res.status, "sat", "Q1 expected SAT — append-only violation must be reachable under arbitrary inputs");
  const w: Record<string, string> = {};
  (q1res.values ?? []).forEach((v, i) => { w[names[i]!] = v; });

  // Q2: violation without ANY protection drop (p_i → q_i)? UNSAT since the
  // #3945 fix — the per-id BLOCKED binding is shared but protection is
  // per-message; refs.ts now migrates only when NO same-id message is
  // protected, so the colliding message can no longer steal the binding
  // (refs.ts delete + fresh alloc used to re-tag m1's already-sent bytes).
  const noDrop = p1.implies(q1).and(p2.implies(q2));
  let q2res: ReturnType<typeof solveSmt2>;
  try { q2res = solveSmt2(smt2Of(ctx, [...baseAsserts, noDrop, violation] as never[], [] as never), []); }
  catch (e) { t.skip(`solver unavailable mid-test: ${(e as Error).message.slice(0, 200)}`); return; }
  assert.equal(q2res.status, "unsat", "Q2 expected UNSAT — the id-collision re-tag is fixed (#3945): no violation without protection drops");
  // Q3: with pairwise-distinct ids and no protection drop, NO violation may
  // remain within bounds (kept as a belt beyond Q2 — Q2 already proves the
  // collision shape is gone).
  const idt = (n: string) => ctx.String.const(n);
  const distinct = idt("m1_id").neq(idt("m2_id")).and(idt("m1_id").neq(idt("m3_id"))).and(idt("m2_id").neq(idt("m3_id")));
  let q3res: ReturnType<typeof solveSmt2>;
  try { q3res = solveSmt2(smt2Of(ctx, [...baseAsserts, noDrop, distinct, violation] as never[], [] as never), []); }
  catch (e) { t.skip(`solver unavailable mid-test: ${(e as Error).message.slice(0, 200)}`); return; }
  assert.equal(q3res.status, "unsat", "Q3 expected UNSAT — nothing beyond protection-drop shapes within bounds");

  // ---- replay on REAL code with a witness-shaped input ----
  // Interpret witness booleans through the real durable classifier semantics
  // (latest marker-carrier wins): p=true ⇒ carries "<available_skills>".
  const marker = "<available_skills>";
  const textFor = (tag: string, prot: boolean | undefined) =>
    (prot ? `${marker} catalog ${tag}` : `plain ${tag} body`);
  const bool = (v: unknown): boolean => {
    if (v === "true") return true;
    if (v === "false") return false;
    if (typeof v === "string" && (v === "1" || v === "0")) return v === "1";
    return false;
  };
  const p1w = bool(w.p1), p2w = bool(w.p2), q1w = bool(w.q1), q2w = bool(w.q2), q3w = bool(w.q3);
  const rmsg = (tag: string, prot: boolean): CoreMessage => ({
    id: `${tag}-real`, role: "user", contentType: "text", text: textFor(tag, prot),
  } as CoreMessage);
  const turnProt = (table: Record<string, boolean>) => (m: { id: string }) => table[m.id] === true;
  // Real code, turn A then turn B, threading map/nextIndex like the proxy does.
  const fresh = { byRaw: {} as Record<string, string>, byRef: {} as Record<string, string> };
  const a1 = assignRefs([rmsg("m1", p1w), rmsg("m2", p2w)], { existing: fresh, nextIndex: 1, isProtected: turnProt({ "m1-real": p1w, "m2-real": p2w }) });
  const ra = renderVisibleRefs([rmsg("m1", p1w), rmsg("m2", p2w)], { messageRefs: a1.map } as never, defaultCountTokens, "text-only" as never) as unknown as { text: string }[];
  const a2 = assignRefs([rmsg("m1", q1w), rmsg("m2", q2w), rmsg("m3", q3w)], { existing: a1.map, nextIndex: a1.nextIndex, isProtected: turnProt({ "m1-real": q1w, "m2-real": q2w, "m3-real": q3w }) });
  const rb = renderVisibleRefs([rmsg("m1", q1w), rmsg("m2", q2w), rmsg("m3", q3w)], { messageRefs: a2.map } as never, defaultCountTokens, "text-only" as never) as unknown as { text: string }[];
  // The witness must ACTUALLY violate on real code (replay lock) when its
  // protection pattern is realizable; protection-drop lifts (#3805 shape)
  // are the expected realization.
  const realFlip = ra[0]!.text !== rb[0]!.text || ra[1]!.text !== rb[1]!.text;
  const lifted = (p1w && !q1w) || (p2w && !q2w);
  assert.ok(realFlip === true || lifted === false,
    `witness p=${p1w},${p2w} q=${q1w},${q2w},${q3w} replayFlip=${realFlip} lifted=${lifted}`);
  // Q2 shape replayed for real: duplicate raw id, protection NOT dropped.
  // Fixed contract (#3945): the shared BLOCKED binding survives while any
  // same-id message is protected — no flip, no re-tag, both passes verbatim.
  const mkDup = (id: string, text: string, prot: boolean): CoreMessage =>
    ({ id, role: "user", contentType: "text", text: prot ? `${marker} catalog ${id}` : text } as CoreMessage);
  const d1 = mkDup("C", "marker body <available_skills> catalog", true);
  const d2 = mkDup("B", "plain tool payload", false);
  const d3 = mkDup("C", "A", false);
  const dupProt = (m: { id: string; text?: string }) => m.text !== undefined && m.text.includes(marker) && m.id === "C";
  const dupA = assignRefs([d1, d2], { existing: { byRaw: {}, byRef: {} }, nextIndex: 1, isProtected: dupProt as never });
  const dupRA = renderVisibleRefs([d1, d2], { messageRefs: dupA.map } as never, defaultCountTokens, "text-only" as never) as unknown as { text: string }[];
  const dupB = assignRefs([d1, d2, d3], { existing: dupA.map, nextIndex: dupA.nextIndex, isProtected: dupProt as never });
  const dupRB = renderVisibleRefs([d1, d2, d3], { messageRefs: dupB.map } as never, defaultCountTokens, "text-only" as never) as unknown as { text: string }[];
  assert.ok(dupRA[0]!.text === dupRB[0]!.text,
    "id-collision fixed (#3945): protected m1 stays verbatim across the append — no re-tag");
  assert.equal(dupA.map.byRaw.C, "BLOCKED");
  assert.equal(dupB.map.byRaw.C, "BLOCKED");
  assert.equal(dupB.migratedIds.length, 0, "no migration while a same-id sibling is protected");
});
