/**
 * #7823 — verif spread-presence under-approximation.
 *
 * `{ ...a, ...b }` where BOTH sources may carry key k: the key is present
 * when EITHER may be (presence = g_a ∨ g_b) and the value is ite(g_b, b.k,
 * a.k). The old translator overwrote value = b.k unconditionally and
 * presence = g_b only — so a path where a carries k and b does not was
 * "proved" to have the WRONG value (or no value at all): a false-UNSAT
 * "proof", i.e. a false green on real code.
 *
 * V1  x>0 ∧ y≤0 ⇒ spreadMerge returns 1 (a's value falls through) — SAT.
 *      Under the old translator this was UNSAT (false green).
 * V2  drift control: x>0 ∧ y≤0 ⇒ returns 2 — UNSAT (the wrong claim must
 *      be rejected). Under the old translator this was SAT.
 * V3  y>0 ∧ x>0 ⇒ returns 2 (b present wins) — SAT, both translators agree.
 *
 * Witness values are replayed on the REAL fixture function. Skips without a
 * solver (local); CI carries z3 (ci-theorem.yml).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { translateFunction } from "../verif/symbolic.js";
import { newCtx, smt2Of } from "../verif/terms.js";
import { solveSmt2, parseNum } from "../verif/solve.js";
import { spreadMerge } from "./fixtures/verif-spread-presence.js";

const file = resolve(import.meta.dirname, "fixtures/verif-spread-presence.ts");

type Ctx = import("../verif/terms.js").Context;

function translateSpreadMerge(
  ctx: Ctx,
  x: import("../verif/terms.js").Arith,
  y: import("../verif/terms.js").Arith,
) {
  const { exec } = translateFunction({
    file,
    function: "spreadMerge",
    params: { x: { kind: "num", t: x }, y: { kind: "num", t: y } },
    ctx,
  });
  const r = exec();
  assert.ok(r.ret, "translated spreadMerge exposes a return term");
  const degradations = r.degradations.filter((d) => !d.startsWith("template"));
  assert.deepEqual(degradations, [], `no degradations expected (got: ${degradations.join("; ")})`);
  return r;
}

test("verif #7823 V0: the fixture translates cleanly (solver-free — runs everywhere)", () => {
  const ctx = newCtx();
  const x = ctx.Real.const("x");
  const y = ctx.Real.const("y");
  const r = translateSpreadMerge(ctx, x, y);
  const ret = r.ret as { kind: string; t?: import("../verif/terms.js").Arith };
  assert.equal(ret.kind, "num", "numeric return term (ite-merged)");
  assert.equal(r.ret!.kind, "num", "return term is numeric (ite-merged 1/2/-1)");
});

async function solverAvailable() {
  try {
    await solveSmt2("(set-logic ALL)(check-sat)", []);
    return true;
  } catch {
    return false;
  }
}

test("verif #7823 V1: x>0 ∧ y≤0 ⇒ spreadMerge returns 1 (a's value, presence OR)", async (t) => {
  if (!(await solverAvailable()))
    return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");

  const ctx = newCtx();
  const x = ctx.Real.const("x");
  const y = ctx.Real.const("y");
  const r = translateSpreadMerge(ctx, x, y);
  const ret = r.ret as { kind: string; t?: import("../verif/terms.js").Arith };
  assert.equal(ret.kind, "num", "numeric return term (ite-merged)");

  const smt2 = smt2Of(r.ctx, [
    x.gt(ctx.Real.val(0)),
    x.le(ctx.Real.val(10)),
    x.eq(ctx.ToInt(x)),
    y.le(ctx.Real.val(0)),
    y.ge(ctx.Real.val(-10)),
    y.eq(ctx.ToInt(y)),
    ret.t!.eq(ctx.Real.val(1)),
  ]);
  const out = await solveSmt2(smt2, ["x", "y"]);
  assert.equal(out.status, "sat", "x>0 ∧ y≤0 must admit a path returning 1 — the old translator proved this UNSAT (false green)");
  const xv = parseNum(out.values[0] ?? "");
  const yv = parseNum(out.values[1] ?? "");
  assert.equal(spreadMerge(xv, yv), 1, "witness replayed on the real fixture returns 1");
});

test("verif #7823 V2: drift control — x>0 ∧ y≤0 ⇒ returns 2 is impossible", async (t) => {
  if (!(await solverAvailable()))
    return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");

  const ctx = newCtx();
  const x = ctx.Real.const("x");
  const y = ctx.Real.const("y");
  const r = translateSpreadMerge(ctx, x, y);
  const ret = r.ret as { kind: string; t?: import("../verif/terms.js").Arith };
  assert.equal(ret.kind, "num", "numeric return term (ite-merged)");

  const smt2 = smt2Of(r.ctx, [
    x.gt(ctx.Real.val(0)),
    x.le(ctx.Real.val(10)),
    x.eq(ctx.ToInt(x)),
    y.le(ctx.Real.val(0)),
    y.ge(ctx.Real.val(-10)),
    y.eq(ctx.ToInt(y)),
    ret.t!.eq(ctx.Real.val(2)),
  ]);
  const out = await solveSmt2(smt2, ["x", "y"]);
  assert.equal(out.status, "unsat", "the wrong value claim must be refused — the old translator found a (phantom) witness");
});

test("verif #7823 V3: x>0 ∧ y>0 ⇒ b present wins, returns 2", async (t) => {
  if (!(await solverAvailable()))
    return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");

  const ctx = newCtx();
  const x = ctx.Real.const("x");
  const y = ctx.Real.const("y");
  const r = translateSpreadMerge(ctx, x, y);
  const ret = r.ret as { kind: string; t?: import("../verif/terms.js").Arith };
  assert.equal(ret.kind, "num", "numeric return term (ite-merged)");

  const smt2 = smt2Of(r.ctx, [
    x.gt(ctx.Real.val(0)),
    x.le(ctx.Real.val(10)),
    x.eq(ctx.ToInt(x)),
    y.gt(ctx.Real.val(0)),
    y.le(ctx.Real.val(10)),
    y.eq(ctx.ToInt(y)),
    ret.t!.eq(ctx.Real.val(2)),
  ]);
  const out = await solveSmt2(smt2, ["x", "y"]);
  assert.equal(out.status, "sat");
  const xv = parseNum(out.values[0] ?? "");
  const yv = parseNum(out.values[1] ?? "");
  assert.equal(spreadMerge(xv, yv), 2, "witness replayed on the real fixture returns 2");
});
