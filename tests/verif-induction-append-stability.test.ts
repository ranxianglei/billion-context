/**
 * k-induction judge for append-only send-byte stability (#3848, #3945 follow-up).
 *
 * Claim (for ARBITRARY message count n):
 *   If turn k's outbound bytes for messages [1..n] were derived from map M_n,
 *   and the host only APPENDS message n+1 (prefix byte-identical, same ids),
 *   then turn k+1's rendered bytes for [1..n] are unchanged — PROVIDED the
 *   appended message does not REUSE a raw id already present in M_n
 *   (the #3945 id-collision shape is the one real counterexample).
 *
 * Why this is induction, not another bounded scan:
 *   - The prefix is ABSTRACTED to its effect: a symbolic map M with one
 *     observed binding (id_p -> r_p). No 1..n loop, no per-message unroll —
 *     formula size is independent of n.
 *   - Step: run the REAL translated assignRefs([m], M) and prove the observed
 *     binding is untouched when m.id != id_p. UNSAT = step holds for every M,
 *     reachable or not (weaker premise than reachability — the abstraction
 *     characterization is the part we deliberately skip; it cannot weaken the
 *     conclusion, only ever strengthen it).
 *   - Render side: renderVisibleRefs renders each message independently
 *     (messages.map(renderMessage) over the legacy path) and rendered bytes
 *     are a pure function of (message fields, byRaw binding, countTokens).
 *     Same message object + same binding + deterministic token meter => same
 *     bytes. The binding is the only channel through which append can act —
 *     and the step closes it.
 *
 * Side condition (documented, not hidden): id collisions. Since the #3945
 * fix the only remaining collision change is the LEGITIMATE #2607 migration
 * (binding BLOCKED → numeric once no same-id message is protected — in this
 * single-message abstraction there IS no protected sibling in the call, so
 * the solver reaching it is correct behavior, not a bug). The sibling-theft
 * shape — a protected same-id sibling present in the call — is proven
 * unreachable by the generic harness (Q2 UNSAT) and pinned on real code by
 * kernel/tests/issue3945-id-collision.test.ts. A real-code randomized
 * spot-check pins the locality argument on the implementation itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateFunction } from "../verif/symbolic.ts";
import { newCtx, smt2Of } from "../verif/terms.ts";
import { solveSmt2 } from "../verif/solve.ts";
import { assignRefs } from "../kernel/src/refs.ts";
import { renderVisibleRefs } from "../kernel/src/render-refs.ts";
import { defaultCountTokens } from "../kernel/src/tokenize.ts";
import type { SymVal } from "../verif/symbolic.ts";

const REFS_FILE = "kernel/src/refs.ts";

test("induction step: appending a distinct-id message cannot touch any observed binding (arbitrary n)", { timeout: 240_000 }, async (t) => {
  const solver = await (async () => { try { return await solveSmt2("(set-logic ALL)(check-sat)", []); } catch { return null; } })();
  if (!solver) return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");

  const ctx = newCtx();
  // Abstract prefix state: one observed binding under a FREE key/value.
  const idP = ctx.String.const("id_p");
  const rP = ctx.String.const("r_p");
  const binding: SymVal = { kind: "obj", fields: new Map(), symFields: new Map([[idP, { g: ctx.Bool.val(true), v: { kind: "str", t: rP } }]]) } as never;
  const byRawA: SymVal = { kind: "obj", fields: new Map(), symFields: new Map([[idP, { g: ctx.Bool.val(true), v: binding }]]) } as never;
  // Wait: byRaw is Record<id, refText>; fix shape — entries are STRING refs.
  const byRaw: SymVal = { kind: "obj", fields: new Map(), symFields: new Map([[idP, { g: ctx.Bool.val(true), v: { kind: "str", t: rP } }]]) } as never;
  void byRawA; void binding;
  const mapA: SymVal = { kind: "obj", fields: new Map<string, SymVal>([
    ["byRaw", byRaw],
    ["byRef", { kind: "obj", fields: new Map(), symFields: new Map() } as SymVal],
  ]) } as never;
  const nextIdx = ctx.Real.const("next_idx");
  // The appended message: fully free shape.
  const mId = ctx.String.const("m_id");
  const mk = (role: string, ct: string, text: unknown): SymVal => ({ kind: "obj", fields: new Map<string, SymVal>([
    ["id", { kind: "str", t: mId }],
    ["role", { kind: "str", t: ctx.String.const("m_role_" + role) }],
    ["contentType", { kind: "str", t: ctx.String.const("m_ct_" + ct) }],
    ["text", text as SymVal],
  ]) } as never);
  const mText = ctx.String.const("m_text");
  const m1 = mk("r", "c", { kind: "str", t: mText });
  const prot = ctx.Bool.const("m_protected");
  const run = translateFunction({
    file: REFS_FILE, function: "assignRefs",
    params: {
      messages: { kind: "arr", elems: [m1], len: ctx.Real.val(1) } as never,
      options: { kind: "obj", fields: new Map<string, SymVal>([
        ["existing", mapA],
        ["nextIndex", { kind: "num", t: nextIdx }],
        ["isProtected", { kind: "undef" } as SymVal],
      ]) } as never,
    },
    ctx,
    options: {
      portImpls: {
        __method_isProtected: (_recv: SymVal, m: SymVal) => (m === m1 ? { kind: "bool", t: prot } : { kind: "bool", t: ctx.Bool.val(false) }),
      },
    },
  }).exec();
  assert.deepEqual(run.degradations, [], "translation must be faithful");
  const mapB = (run.ret as { fields: Map<string, SymVal> }).fields.get("map") as SymVal;
  const byRawB = (mapB as { fields: Map<string, SymVal> }).fields.get("byRaw") as { symFields?: Map<unknown, { g: unknown; v: SymVal }> };
  assert.ok(byRawB?.symFields?.size, "map.byRaw must carry symbolic entries");
  // Read like the engine does — a key-match FAN over every symbolic entry
  // (looking the entry up by Term identity would ignore entries written
  // under a different Term that the solver may bind equal to ours).
  type B = { g: unknown; v: SymVal };
  const eqT = (a: unknown, b: unknown) => (a as { eq: (x: unknown) => unknown }).eq(b);
  const andT = (a: unknown, b: unknown) => (a as { and: (x: unknown) => unknown }).and(b);
  const iteT = (c: unknown, t: unknown, e: unknown) => ((ctx as unknown as { If: (c: unknown, t: unknown, e: unknown) => unknown }).If(c, t, e));
  let refB: unknown = ctx.String.val("");
  for (const [kt, en] of byRawB.symFields!.entries() as Iterable<[unknown, B]>) {
    const hit = andT(eqT(idP, kt), en.g);
    refB = iteT(hit, (en.v as { t: unknown }).t, refB);
  }
  refB = refB as { eq: (x: unknown) => { not: () => unknown } };
  // Violation: binding value differs from r_p (and is not our never-value).
  const changedReal = (rP as { eq: (x: unknown) => { not: () => unknown } }).eq(refB).not();
  const base = [
    ...run.assumptions as never[],
    nextIdx.ge(ctx.Real.val(1)),
  ] as never[];
  // Q-step: with distinct ids, NO change to the observed binding is possible.
  const step = solveSmt2(smt2Of(ctx, [...base, mId.neq(idP), changedReal] as never[], [] as never), []);
  assert.equal(step.status, "unsat",
    "induction step must hold: appending a distinct-id message cannot alter the observed binding, for ANY prefix state");
  // Q-collision: WITHOUT distinctness, the change IS reachable when the
  // binding is BLOCKED and the appended message is unprotected. Since the
  // #3945 fix this is the legitimate #2607 protection-lift migration (no
  // protected same-id sibling exists in this call — the abstraction's
  // single message is the whole batch); the sibling-theft shape needs the
  // sibling present, which generic Q2 proves unreachable.
  const col = solveSmt2(smt2Of(ctx, [...base, mId.eq(idP), changedReal] as never[], [] as never), []);
  assert.equal(col.status, "sat",
    "collision SAT is the legitimate #2607 BLOCKED→numeric migration (protection lifted, no protected sibling in the call)");
  // Q-collision-protected: a PROTECTED same-id append may never touch the
  // observed binding — that is the #3945 theft shape, closed. (r_p is
  // constrained non-empty: an ""-keyed entry is not a binding, and the
  // protected-assign path writing BLOCKED over it is not a theft.)
  const realBinding = (rP as unknown as { neq: (x: unknown) => unknown }).neq(ctx.String.val(""));
  const colProt = solveSmt2(smt2Of(ctx, [...base, mId.eq(idP), prot, realBinding, changedReal] as never[], [] as never), []);
  assert.equal(colProt.status, "unsat",
    "a protected same-id append must not alter the observed binding (#3945 fixed)");
});

test("induction anchor: real code keeps append local (randomized spot-check, 60 runs)", () => {
  let seed = 0x2f6e2b1;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 60; i++) {
    const ids = ["p1", "p2", "p3"].slice(0, 1 + rnd(3));
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    for (const id of ids) {
      if (rnd(2)) { byRaw[id] = "BLOCKED"; }
      else { const r = "m" + String(1000 + rnd(9000)).padStart(5, "0"); byRaw[id] = r; byRef[r] = id; }
    }
    const nextIndex = 1 + rnd(50);
    const prot = rnd(2) === 1;
    const mk = (id: string, text: string) => ({ id, role: "user", contentType: "text", text }) as never;
    const prefix = ids.map((id, k) => mk(id, "prefix body " + k));
    const rendA = renderVisibleRefs(prefix, { messageRefs: { byRaw, byRef } } as never, defaultCountTokens, "text-only" as never) as unknown as { text: string }[];
    const nid = "new_" + i;
    const mNew = mk(nid, prot ? "marker <available_skills>" : "appended text " + i);
    const out = assignRefs([mNew], { existing: { byRaw, byRef }, nextIndex, isProtected: ((m: { text?: string }) => !!m.text?.includes("<available_skills>")) as never });
    const rendB = renderVisibleRefs([...prefix, mNew], { messageRefs: out.map } as never, defaultCountTokens, "text-only" as never) as unknown as { text: string }[];
    for (let k = 0; k < prefix.length; k++) {
      assert.equal(rendB[k]!.text, rendA[k]!.text, `run ${i}: prefix message ${k} must render identically after append`);
      assert.equal((out.map.byRaw as Record<string, string>)[ids[k]!], byRaw[ids[k]!] ?? "BLOCKED", `run ${i}: binding for ${ids[k]} must not change`);
    }
  }
});
