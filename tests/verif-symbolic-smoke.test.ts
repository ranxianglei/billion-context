/**
 * Symbolic smoke test — first end-to-end proof on REAL kernel code.
 *
 * Target: kernel/src/refs.ts indexToRef bounds behavior (issue #3848
 * acceptance step "首个目标函数出界内无反例结论,且注入已知 bug 形状时必红").
 *
 *  V1  for all n in [1, 9_999_999]: indexToRef(n) does NOT throw   → UNSAT expected
 *  V2  for n outside that range: indexToRef(n) throws              → SAT, witness replayed on real code
 *  V3  drift control: a deliberately wrong spec bound produces NO
 *      witness (the solver refuses a false claim).
 *
 * All solving goes through the out-of-process runner (verif/solve.ts) —
 * terms are built with the string-backed facade (verif/terms.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { translateFunction } from "../verif/symbolic.js";
import { newCtx, smt2Of } from "../verif/terms.js";
import { solveSmt2, parseNum } from "../verif/solve.js";
import { replayThrows, parseIntWitness } from "../verif/replay.js";
import { indexToRef } from "../kernel/src/refs.js";

const file = resolve(import.meta.dirname, "../kernel/src/refs.ts");

function translateIndexToRef(ctx: import("../verif/terms.js").Context, n: import("../verif/terms.js").Arith) {
  const { exec } = translateFunction({
    file,
    function: "indexToRef",
    params: { index: { kind: "num", t: n } },
    ctx,
  });
  const r = exec();
  assert.ok(r.thrown && r.thrown.kind === "bool", "translated indexToRef exposes a boolean throw flag");
  assert.deepEqual(r.degradations.filter((d) => !d.startsWith("template")), [],
    `no degradations expected (got: ${r.degradations.join("; ")})`);
  return r;
}

test("symbolic V1: indexToRef never throws in [1, 9_999_999] (real code, solver-checked)", async (t) => {
  const solver = await (async () => { try { return await solveSmt2("(set-logic ALL)(check-sat)", []); } catch { return null; } })();
  if (!solver) return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");

  const ctx = newCtx();
  const n = ctx.Real.const("n");
  const r = translateIndexToRef(ctx, n);

  const smt2 = smt2Of(r.ctx, [
    n.ge(ctx.Real.val(1)), n.le(ctx.Real.val(9_999_999)), n.eq(ctx.ToInt(n)),
    r.thrown!.t,
  ]);
  const out = await solveSmt2(smt2, []);
  assert.equal(out.status, "unsat", "solver must find NO in-range n that throws");
});

test("symbolic V2: indexToRef throws outside [1, 9_999_999] — witness replayed on real code", async (t) => {
  const solver = await (async () => { try { return await solveSmt2("(set-logic ALL)(check-sat)", []); } catch { return null; } })();
  if (!solver) return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");

  const ctx = newCtx();
  const n = ctx.Real.const("n");
  const r = translateIndexToRef(ctx, n);

  const smt2 = smt2Of(r.ctx, [
    n.ge(ctx.Real.val(-100_000_000)), n.le(ctx.Real.val(100_000_000)), n.eq(ctx.ToInt(n)),
    n.lt(ctx.Real.val(1)).or(n.gt(ctx.Real.val(9_999_999))),
    r.thrown!.t,
  ]);
  const out = await solveSmt2(smt2, ["n"]);
  assert.equal(out.status, "sat");
  assert.ok(out.values.length >= 1, "witness value for n");
  const witness = parseIntWitness(out.values[0]!);
  assert.ok(Number.isFinite(witness), `witness must be an integer, got ${witness}`);

  const reallyThrows = await replayThrows(indexToRef, witness);
  assert.ok(reallyThrows, `witness n=${witness} must throw on real indexToRef`);
});

test("symbolic V3: the solver refuses a wrong spec — 9_999_999 is in range, no counterexample exists", async (t) => {
  const solver = await (async () => { try { return await solveSmt2("(set-logic ALL)(check-sat)", []); } catch { return null; } })();
  if (!solver) return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");

  const ctx = newCtx();
  const n = ctx.Real.const("n");
  const r = translateIndexToRef(ctx, n);

  // WRONG spec: claim n=9_999_999 (the real max) throws. A faithful
  // translation must produce NO counterexample for a false claim.
  const smt2 = smt2Of(r.ctx, [
    n.gt(ctx.Real.val(9_999_998)), n.le(ctx.Real.val(9_999_999)), n.eq(ctx.ToInt(n)),
    r.thrown!.t,
  ]);
  const out = await solveSmt2(smt2, []);
  assert.equal(out.status, "unsat", "no witness may exist for a false claim — translation is faithful");

  // And the drift control still bites: a synthetic phantom witness the REAL
  // code does not reproduce must be detected as a mismatch.
  const phantom = parseNum("12345.0");
  const reallyThrows = await replayThrows(indexToRef, phantom);
  assert.ok(!reallyThrows, "phantom in-range witness must NOT throw on real code (mismatch detectable)");
});
