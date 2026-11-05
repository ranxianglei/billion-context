import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { translateFunction } from "../verif/symbolic.js";
import { newCtx, smt2Of } from "../verif/terms.js";
import type { Bool, Term } from "../verif/terms.js";
import { solveSmt2 } from "../verif/solve.js";
import { assignRefs, emptyRefMap, BLOCKED_REF } from "../kernel/src/refs.js";
import { renderVisibleRefs } from "../kernel/src/render-refs.js";
import type { CoreMessage } from "../kernel/src/types.js";

/**
 * #3805: durable carrier ref migration re-tags an already-sent message.
 *
 * Mechanism (all in guarded kernel code):
 *  - refs.ts assignRefs: a message whose previous ref is BLOCKED (it was
 *    protected last turn) and whose protection has lifted gets the BLOCKED
 *    entry DELETED and a fresh numeric ref allocated.
 *  - render-refs.ts renderMessage: BLOCKED renders verbatim; a numeric ref
 *    renders as an "<acp tokens=…>m00001</acp>\n" tag PREFIX.
 *  - The durable-protection window is "latest carrier only"
 *    (collectLatestProtected + durable-message-guards.ts classifier
 *    `text.includes("<available_skills>")`): when a NEWER carrier for the
 *    same identity arrives, the OLDER one's protection lifts — mid-history.
 *
 * Invariant under test (general, #3848-style I1 tail-only growth):
 *   appending NEWER messages must not change the rendered bytes of an
 *   already-sent message.
 *
 * No-cheat composition: assignRefs + renderVisibleRefs are the REAL
 * translated kernel functions. The only injected seams are
 *  - isProtected (the durable classifier + latest-wins window — its real
 *    impl lives outside the guarded kernel subset; modeled exactly as
 *    "text contains the skill marker" ∧ "is the newest carrier"),
 *  - countTokens (meter, len/4+1),
 *  - the dynamic ownTag regex is over-approximated by the engine's
 *    anchored-prefix rule (documented in verif/README).
 * The replay phase runs the REAL functions end-to-end.
 */

type Ctx = ReturnType<typeof newCtx>;
type SymStr = { kind: "str"; t: Term };
type SymBool = { kind: "bool"; t: Bool<"main"> };
type SymObj = { kind: "obj"; fields: Map<string, any> };
type SymArr = { kind: "arr"; elems: any[]; len: any };
type SymVal = SymStr | SymBool | SymObj | SymArr | { kind: string; t?: unknown };

const strv = (ctx: Ctx, v: string): SymStr => ({ kind: "str", t: ctx.String.val(v) }) as never;
const numv = (ctx: Ctx, v: number): { kind: "num"; t: unknown } => ({ kind: "num", t: ctx.Real.val(v) }) as never;
const boolv = (ctx: Ctx, v: boolean): SymBool => ({ kind: "bool", t: ctx.Bool.val(v) }) as never;
const objOf = (fields: Record<string, unknown>): SymObj => ({ kind: "obj", fields: new Map(Object.entries(fields)) }) as never;
const arrOf = (ctx: Ctx, elems: SymVal[]): SymArr => ({ kind: "arr", elems, len: ctx.Real.val(elems.length) }) as never;

const MARKER = "<available_skills>";
const REPO = fileURLToPath(new URL("..", import.meta.url));
const REFS = `${REPO}kernel/src/refs.ts`;
const RREFS = `${REPO}kernel/src/render-refs.ts`;

function coreMsg(ctx: Ctx, id: string, text: SymStr): SymObj {
  return objOf({
    id: strv(ctx, id),
    role: strv(ctx, "user"),
    contentType: strv(ctx, "text"),
    text,
  });
}

function meterPort(ctx: Ctx) {
  return (text: SymVal): { kind: "num"; t: unknown } => {
    if (text && (text as SymStr).kind === "str") {
      const len = ctx.ToReal((text as SymStr).t.length() as never);
      return { kind: "num", t: (len as unknown as { div(x: unknown): { add(y: unknown): unknown } }).div(ctx.Real.val(4)).add(ctx.Real.val(1)) } as never;
    }
    return { kind: "num", t: ctx.Real.val(1) } as never;
  };
}

interface TurnArtifacts {
  mapByRaw: SymObj;
  mapByRef: SymObj;
  nextIndex: unknown;
  rendered0: SymStr;
  assumptions: any[];
  degradations: string[];
}

/** One full turn: assignRefs then renderVisibleRefs — both REAL translated
 *  kernel functions. `protected1`/`protected2` are the symbolic protection
 *  bits for m1/m2 (the durable classifier, injected as the isProtected port). */
function turn(
  ctx: Ctx,
  msgs: SymVal,
  existing: { byRaw: SymObj; byRef: SymObj } | null,
  nextIndex: unknown,
  protected1: SymBool,
  protected2: SymBool,
): TurnArtifacts {
  const emptyRec = objOf({});
  const options = objOf({
    existing: objOf({ byRaw: existing ? existing.byRaw : emptyRec, byRef: existing ? existing.byRef : emptyRec }),
    nextIndex: numv(ctx, typeof nextIndex === "number" ? nextIndex : 1),
  });
  const portsA = {
    __method_isProtected: (_recv: SymVal, m: SymVal): SymBool => {
      const id = (m as SymObj).fields.get("id") as SymStr | undefined;
      const idc = id && typeof id.t.c === "string" ? id.t.c : "";
      if (idc === "u1") return protected1;
      return protected2;
    },
    countTokens: meterPort(ctx),
  };
  const outA = translateFunction({
    file: REFS, function: "assignRefs",
    params: { messages: msgs, options } as never,
    ctx, options: { portImpls: portsA as never },
  }).exec();
  const retA = outA.ret as SymObj;
  const mapA = retA.fields.get("map") as SymObj;

  const state = objOf({ messageRefs: mapA });
  const outR = translateFunction({
    file: RREFS, function: "renderVisibleRefs",
    params: { messages: msgs, state } as never,
    ctx, options: { portImpls: { countTokens: meterPort(ctx) } as never },
  }).exec();
  const retR = outR.ret as SymArr;
  const rendered0 = retR.elems[0] as SymObj;
  return {
    mapByRaw: mapA.fields.get("byRaw") as SymObj,
    mapByRef: mapA.fields.get("byRef") as SymObj,
    nextIndex: retA.fields.get("nextIndex"),
    rendered0: rendered0.fields.get("text") as SymStr,
    assumptions: outA.assumptions ?? [],
    degradations: [...(outA.degradations ?? []), ...(outR.degradations ?? [])],
  };
}

function runSymbolic(ctx: Ctx) {
  const T1 = ctx.String.const("T1");
  const T2 = ctx.String.const("T2");
  const marker = ctx.String.val(MARKER);
  const d1: SymBool = { kind: "bool", t: T1.contains(marker) } as never;
  const d2: SymBool = { kind: "bool", t: T2.contains(marker) } as never;

  const m1 = coreMsg(ctx, "u1", { kind: "str", t: T1 } as never);
  const m2 = coreMsg(ctx, "u2", { kind: "str", t: T2 } as never);

  // Turn A: only m1. Protection = "is the newest durable carrier" = d1.
  const A = turn(ctx, arrOf(ctx, [m1 as SymVal]), null, 1, d1, boolv(ctx, false));
  // Turn B: m2 appended. Latest-wins: m1 protected iff d1 ∧ ¬d2; m2 iff d2.
  const notd2: SymBool = { kind: "bool", t: d2.t.not() } as never;
  const keep1: SymBool = { kind: "bool", t: d1.t.and(notd2.t) } as never;
  const B = turn(ctx, arrOf(ctx, [m1 as SymVal, m2 as SymVal]), { byRaw: A.mapByRaw, byRef: A.mapByRef }, A.nextIndex, keep1, d2);
  return { T1, T2, d1, d2, A, B };
}

test("bug3805: solver finds the mid-history re-tag when protection lifts (append-only bytes must stay stable)", { timeout: 240_000 }, async (t) => {
  const haveSolver = await (async () => { try { return solveSmt2("(set-logic ALL)(check-sat)", []).status === "sat"; } catch { return false; } })();
  if (!haveSolver) return t.skip("no solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");

  const ctx = newCtx();
  const { T1, T2, d1, d2, A, B } = runSymbolic(ctx);
  assert.deepEqual(A.degradations, [], `A degradations: ${JSON.stringify(A.degradations)}`);
  assert.deepEqual(B.degradations, [], `B degradations: ${JSON.stringify(B.degradations)}`);
  assert.equal(A.rendered0.kind, "str");
  assert.equal(B.rendered0.kind, "str");

  // Property: appending m2 changed m1's rendered bytes (mid-history seam).
  const differ = (A.rendered0 as SymStr).t.neq((B.rendered0 as SymStr).t);
  const q1 = smt2Of(ctx, [...(A.assumptions as never[]), ...(B.assumptions as never[]), d1.t, d2.t, differ] as never[], ["str.len T1", "str.len T2"]);
  const r1 = await solveSmt2(q1, []);
  assert.equal(r1.status, "sat", "solver must find the re-tag witness (d1 ∧ d2 → flip)");

  // Negative control: m2 is NOT a durable carrier → m1 keeps its protection
  // (or never had one) → bytes stay stable.
  const q2 = smt2Of(ctx, [...(A.assumptions as never[]), ...(B.assumptions as never[]), d1.t, d2.t.not(), differ] as never[], []);
  const r2 = await solveSmt2(q2, []);
  assert.notEqual(r2.status, "sat", "no byte change may occur when the appended message is not a durable carrier");

  // ---- replay on the REAL code (witness semantics: both carry the marker) ----
  const realCount = (text: string) => Math.ceil(text.length / 4) + 1;
  const t1r = MARKER + "\nskill catalog v1 (some body)";
  const t2r = MARKER + "\nskill catalog v2 (some body)";
  const mk = (id: string, text: string): CoreMessage =>
    ({ id, role: "user", contentType: "text", text }) as unknown as CoreMessage;

  // Turn A: m1 is the newest (only) durable carrier → protected → BLOCKED.
  const rA = assignRefs([mk("u1", t1r)], {
    existing: emptyRefMap(), nextIndex: 1,
    isProtected: () => true,
  });
  assert.equal(rA.map.byRaw.u1, BLOCKED_REF, "protected carrier renders verbatim (BLOCKED)");
  const renderA = renderVisibleRefs([mk("u1", t1r)], { messageRefs: rA.map } as never, realCount, "all");
  assert.equal(renderA[0]!.text, t1r, "turn A: no tag (BLOCKED → verbatim)");

  // Turn B: a NEWER carrier for the same identity arrives → m1's protection
  // lifts → BLOCKED deleted → fresh numeric ref → tag prefix mid-history.
  const rB = assignRefs([mk("u1", t1r), mk("u2", t2r)], {
    existing: rA.map, nextIndex: rA.nextIndex,
    isProtected: (m) => m.id === "u2",
  });
  assert.notEqual(rB.map.byRaw.u1, BLOCKED_REF, "older carrier lost protection (latest-wins window)");
  const renderB = renderVisibleRefs([mk("u1", t1r), mk("u2", t2r)], { messageRefs: rB.map } as never, realCount, "all");
  const t1After: string = renderB[0]!.text ?? "";
  assert.notEqual(t1After, t1r, "#3805 seam: already-sent message re-tagged mid-history");
  assert.ok(t1After.startsWith("<acp "), `expected an acp tag prefix, got: ${t1After.slice(0, 40)}…`);
});

test("bug3805 counter-test: non-durable append keeps the bytes stable", { timeout: 240_000 }, async (t) => {
  const haveSolver = await (async () => { try { return solveSmt2("(set-logic ALL)(check-sat)", []).status === "sat"; } catch { return false; } })();
  if (!haveSolver) return t.skip("no solver available");

  const ctx = newCtx();
  const { T1, T2, d1, A, B } = runSymbolic(ctx);
  void T2;
  // m2 without the marker: m1's protection never lifts.
  const same = (A.rendered0 as SymStr).t.eq((B.rendered0 as SymStr).t);
  const q = smt2Of(ctx, [...(A.assumptions as never[]), ...(B.assumptions as never[]), d1.t, same] as never[], []);
  const r = await solveSmt2(q, []);
  assert.equal(r.status, "sat", "stable model exists (d1 ∧ ¬d2 → identical bytes)");

  // replay: plain user append
  const realCount = (text: string) => Math.ceil(text.length / 4) + 1;
  const t1r = MARKER + "\nskill catalog v1";
  const t2r = "just a plain user message";
  const mk = (id: string, text: string): CoreMessage =>
    ({ id, role: "user", contentType: "text", text }) as unknown as CoreMessage;
  const rA = assignRefs([mk("u1", t1r)], { existing: emptyRefMap(), nextIndex: 1, isProtected: () => true });
  const rB = assignRefs([mk("u1", t1r), mk("u2", t2r)], { existing: rA.map, nextIndex: rA.nextIndex, isProtected: (m) => m.id === "u1" });
  assert.equal(rB.map.byRaw.u1, BLOCKED_REF, "protection persists for a non-durable append");
  const a = renderVisibleRefs([mk("u1", t1r)], { messageRefs: rA.map } as never, realCount, "all")[0]!.text;
  const b = renderVisibleRefs([mk("u1", t1r), mk("u2", t2r)], { messageRefs: rB.map } as never, realCount, "all")[0]!.text;
  assert.equal(a, b, "bytes stable");
});
