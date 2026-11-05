import test from "node:test";
import assert from "node:assert/strict";
import { translateFunction } from "../verif/symbolic.js";
import { newCtx, smt2Of } from "../verif/terms.js";
import type { Seq, Bool } from "../verif/terms.js";
import { solveSmt2 } from "../verif/solve.js";
import { openaiToCore, coreToOpenai } from "../kernel/src/wire/openai.js";
import { resolve } from "node:path";

/**
 * #3676 — OpenAI wire round-trip reverses [file, text] content-part order.
 *
 * Invariant under test (general — no bug shape hardcoded): a parse→rebuild
 * round trip must preserve the ORDER of a user message's content parts.
 * Part order IS bytes: a reordered parts array is a different outbound
 * request, so every cache in front of it misses.
 *
 * Phase 1 (symbolic, REAL openaiToCore/coreToOpenai translated): the solver
 * must exhibit a wire user message whose parts are [opaque(file), text(T)]
 * with the rebuilt parts [text, file] — REVERSED.
 * Phase 2 (negative control): for [text, file] the same reversed assertion is
 * UNSAT — the invariant is the judge, not the scenario.
 * Phase 3 (replay): the witness shape runs through the REAL functions.
 */

const FILE = resolve(import.meta.dirname, "../kernel/src/wire/openai.ts");

type Ctx = ReturnType<typeof newCtx>;
type SymStr = { kind: "str"; t: Seq<"main"> };
type SymObj = { kind: "obj"; fields: Map<string, any> };
type SymArr = { kind: "arr"; elems: SymObj[]; len: any };

const strc = (ctx: Ctx, v: string): SymStr => ({ kind: "str", t: ctx.String.val(v) }) as never;
const objOf = (fields: Record<string, unknown>): SymObj => ({ kind: "obj", fields: new Map(Object.entries(fields)) }) as never;
const arrOf = (ctx: Ctx, elems: SymObj[]): SymArr => ({ kind: "arr", elems, len: ctx.Real.val(elems.length) }) as never;

/** Deterministic port for deriveCanonicalMessageId (real one uses
 *  node:crypto sha256 — outside the guarded subset). Distinct argument
 *  tuples → distinct constant ids; ids never influence the order property. */
function makeIdPort(ctx: Ctx) {
  const memo = new Map<string, SymStr>();
  let n = 0;
  return (...args: Array<{ kind: string }>): SymStr => {
    const key = args.map((a) => (a.kind === "str" ? String((a as { t?: { c?: string } }).t?.c ?? "?") : a.kind)).join("|");
    let v = memo.get(key);
    if (!v) { v = strc(ctx, `id${n++}`); memo.set(key, v); }
    return v;
  };
}

/** ClusterCounter port: per-instance JS counter (state outside the model —
 *  ids don't affect the order property, only determinism). */
function makeCounterPorts(ctx: Ctx) {
  const counts = new WeakMap<object, number>();
  const marker = objOf({});
  return {
    ClusterCounter: () => marker,
    __method_next: (recv: SymObj, base: SymStr): SymStr => {
      if (recv !== marker) return strc(ctx, "?");
      const c = (counts.get(marker) ?? 0) + 1;
      counts.set(marker, c);
      const b = String(base?.t?.c ?? "?");
      return strc(ctx, c === 1 ? b : `${b}_${c - 1}`);
    },
  };
}

function wireInput(ctx: Ctx, first: "file" | "text") {
  const T = ctx.String.const("T");
  const filePart = objOf({ type: strc(ctx, "file"), file_id: strc(ctx, "file_123") });
  const textPart = objOf({ type: strc(ctx, "text"), text: { kind: "str", t: T } as never });
  const parts = arrOf(ctx, first === "file" ? [filePart, textPart] : [textPart, filePart]);
  const userMsg = objOf({ role: strc(ctx, "user"), content: parts });
  return { T, body: objOf({ messages: arrOf(ctx, [userMsg]) }) };
}

type ParseRet = { degradations: string[]; ret: { kind: string; fields: Map<string, unknown> } };
type RbRet = { degradations: string[]; ret: SymArr };

function roundTrip(ctx: Ctx, ports: unknown, first: "file" | "text") {
  const { T, body } = wireInput(ctx, first);
  const parseOut = translateFunction({ file: FILE, function: "openaiToCore", params: { body }, ctx, options: { portImpls: ports as never } }).exec() as never as ParseRet;
  const coreMsgs = parseOut.ret.fields.get("msgs") as never;
  const rbOut = translateFunction({ file: FILE, function: "coreToOpenai", params: { messages: coreMsgs }, ctx, options: { portImpls: ports as never } }).exec() as never as RbRet;
  return { T, parseOut, rbOut };
}

function outContent(rb: RbRet): SymArr {
  const out0 = rb.ret.elems[0]!;
  assert.equal(out0.kind, "obj", "one wire message out");
  const c = (out0.fields as Map<string, unknown>).get("content") as SymArr;
  assert.equal(c.kind, "arr", "opaque parts ride along → parts array (not plain string)");
  return c;
}

function partType(content: SymArr, i: number): Seq<"main"> {
  const e = content.elems[i];
  assert.ok(e && e.kind === "obj", `part ${i} exists`);
  const t = (e.fields as Map<string, unknown>).get("type") as SymStr | undefined;
  assert.ok(t && t.kind === "str", `part ${i} has a type`);
  return t.t;
}

test("bug3676: solver finds the [file,text]→[text,file] part-order reversal on the real wire codec", { timeout: 240_000 }, async (t) => {
  const solver = await (async () => { try { return await solveSmt2("(set-logic ALL)(check-sat)", []); } catch { return null; } })();
  if (!solver) return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");
  const ctx = newCtx();
  const ports = { ...makeCounterPorts(ctx), deriveCanonicalMessageId: makeIdPort(ctx) };

  const A = roundTrip(ctx, ports, "file"); // original order [file, text]
  const B = roundTrip(ctx, ports, "text"); // original order [text, file]
  assert.deepEqual(A.parseOut.degradations, [], "parse fully translated");
  assert.deepEqual(A.rbOut.degradations, [], "rebuild fully translated");

  const cA = outContent(A.rbOut);
  const cB = outContent(B.rbOut);

  // Property: original [file,text] rebuilds as [text,file] — REVERSED.
  // len(out)==2 ∧ T≠"" ∧ type(out[0])=="text" ∧ type(out[1])=="file"
  const tNonEmptyA = ctx.ToReal((A.T as unknown as { length(): Seq<"main">["length"] extends () => infer R ? R : never }).length() as never).ge(ctx.Real.val(1)) as unknown as Bool<"main">;
  const len2A = (cA.len as unknown as { eq: (x: unknown) => Bool<"main"> }).eq(ctx.Real.val(2));
  const p0A = partType(cA, 0).eq(ctx.String.val("text"));
  const p1A = partType(cA, 1).eq(ctx.String.val("file"));
  const q1 = smt2Of(ctx, [tNonEmptyA.and(len2A).and(p0A).and(p1A) as never, ...[]], []);
  const r1 = await solveSmt2(q1, []);
  assert.equal(r1.status, "sat", "solver must exhibit the [file,text]→[text,file] reversal");

  // Negative control: original [text,file] CANNOT rebuild reversed.
  const tNonEmptyB = ctx.ToReal((B.T as unknown as { length(): never }).length() as never).ge(ctx.Real.val(1)) as unknown as Bool<"main">;
  const len2B = (cB.len as unknown as { eq: (x: unknown) => Bool<"main"> }).eq(ctx.Real.val(2));
  const p0B = partType(cB, 0).eq(ctx.String.val("file"));
  const q2 = smt2Of(ctx, [tNonEmptyB.and(len2B).and(p0B) as never], []);
  const r2 = await solveSmt2(q2, []);
  assert.equal(r2.status, "unsat", "no reversal exists for [text,file] — order preserved (the invariant is the judge)");

  // ---- replay on the REAL codec (tsx runs the real imports incl. crypto) ----
  const wireFileFirst = [
    {
      role: "user" as const,
      content: [
        { type: "file" as const, file_id: "file_123" },
        { type: "text" as const, text: "hello world" },
      ],
    },
  ];
  const core = openaiToCore({ messages: wireFileFirst } as never);
  const rebuilt = coreToOpenai(core.msgs as never);
  const c = (rebuilt[0] as { content: Array<{ type: string }> }).content;
  assert.ok(Array.isArray(c), "rebuild emits a parts array when opaque parts ride along");
  assert.equal(c.length, 2, "both parts survive (never dropped, #1205)");
  assert.deepEqual(
    c.map((p) => p.type),
    ["text", "file"],
    "REPLAY: [file,text] round-trips as [text,file] — part order REVERSED (#3676)",
  );
});
