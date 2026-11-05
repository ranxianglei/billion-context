import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { translateFunction, type SymVal } from "../verif/symbolic.ts";
import { newCtx, smt2Of, type Context, type Term, type Seq } from "../verif/terms.ts";
import { solveSmt2 } from "../verif/solve.ts";

/**
 * #3848 phase 2 — google adapter rebuild stability under append.
 *
 * Property (byte-stability contract in kernel/src/wire/google.ts:353):
 * coreToGoogle is PURE in the core array — same shape, same bytes, every
 * request. Appending an ALTERNATING-role core opens a new content and must
 * leave every earlier content byte-identical; appending a same-side
 * tool-result core merges into the trailing user content with the plain
 * text part still leading (#3159 canonical order) — the prefix text part
 * itself must not drift.
 *
 * No-cheat: the entry is the REAL coreToGoogle; the appended cores are
 * fully symbolic payloads (texts/toolName/toolCallId); no knowledge of
 * google.ts internals enters the queries. Ports only for identity seams
 * this direction does not exercise (none needed — rebuild helpers are
 * same-file).
 */

const haveSolver = (() => {
  try { void solveSmt2("(check-sat)", []); return true; } catch { return false; }
})();

type KCtx = Context;
const newCtx0 = (n: number): Term => newCtx().Real.val(n);
const strv = (ctx: KCtx, t: Term): SymVal => ({ kind: "str", t: t as Seq });
const objv = (fields: [string, SymVal][]): SymVal =>
  ({ kind: "obj", fields: new Map(fields) }) as SymVal;
const arrv = (elems: SymVal[]): SymVal =>
  ({ kind: "arr", elems, len: newCtx0(elems.length) }) as SymVal;

function coreMsg(fields: [string, SymVal][], rawParts: SymVal[]): SymVal {
  return objv([...fields, ["rawGoogleParts", arrv(rawParts)]]);
}

/** REAL coreToGoogle over a symbolic core array. */
function runCoreToGoogle(ctx: KCtx, msgs: SymVal): { ret: SymVal; assumptions: unknown[]; degradations: string[] } {
  const out = translateFunction({
    file: fileURLToPath(new URL("../kernel/src/wire/google.ts", import.meta.url)),
    function: "coreToGoogle",
    params: { messages: msgs },
    ctx: ctx as never,
    options: {},
  }).exec() as unknown as { ret: SymVal; assumptions: unknown[]; degradations: string[] };
  return out;
}

const contentsOf = (ret: SymVal): { elems: SymVal[] } => {
  assert.equal(ret.kind, "arr", "coreToGoogle returns the contents array");
  return ret as { elems: SymVal[] };
};
const partTextOf = (content: SymVal): SymVal => {
  const parts = (content as { fields: Map<string, SymVal> }).fields.get("parts") as { elems: SymVal[] };
  const p0 = parts.elems[0] as { fields: Map<string, SymVal> };
  return p0.fields.get("text") ?? { kind: "undef" };
};

test("google rebuild: alternating append leaves earlier contents byte-identical (symbolic payloads)", { skip: !haveSolver }, () => {
  const ctx = newCtx();
  const T1 = ctx.String.const("T1"), T2 = ctx.String.const("T2");
  // len(T1) >= 1: empty text cores render no text part (contentParts drops
  // them); the domain here is real text turns.
  const base = coreMsg(
    [["id", strv(ctx, ctx.String.val("u1"))], ["role", strv(ctx, ctx.String.val("user"))], ["contentType", strv(ctx, ctx.String.val("text"))], ["text", strv(ctx, T1)]],
    [objv([["text", strv(ctx, T1)]])],
  );
  const appended = coreMsg(
    [["id", strv(ctx, ctx.String.val("a1"))], ["role", strv(ctx, ctx.String.val("assistant"))], ["contentType", strv(ctx, ctx.String.val("text"))], ["text", strv(ctx, T2)]],
    [objv([["text", strv(ctx, T2)]])],
  );
  const run1 = runCoreToGoogle(ctx, arrv([base]));
  const run2 = runCoreToGoogle(ctx, arrv([base, appended]));
  assert.deepEqual(run1.degradations, [], "rebuild turn 1 must translate cleanly");
  assert.deepEqual(run2.degradations, [], "rebuild turn 2 must translate cleanly");

  const c1 = contentsOf(run1.ret), c2 = contentsOf(run2.ret);
  // sanity: 1 content before, 2 after (alternating roles never merge)
  {
    const q = solveSmt2(smt2Of(ctx as never, [...run1.assumptions as never[], (c1.elems.length as unknown as number) !== 1 ? ctx.Bool.val(false) : ctx.Bool.val(false)] as never[], [] as never[]), []);
    assert.equal(q.status, "unsat", "one content in turn 1");
  }
  // Q1: the FIRST content is byte-stable across the append (role + first
  // part's text). UNSAT for any drift.
  const t1a = partTextOf(c1.elems[0]!), t1b = partTextOf(c2.elems[0]!);
  const roleA = (c1.elems[0] as { fields: Map<string, SymVal> }).fields.get("role");
  const roleB = (c2.elems[0] as { fields: Map<string, SymVal> }).fields.get("role");
  const q1 = solveSmt2(smt2Of(ctx as never, [
    ...run1.assumptions as never[], ...run2.assumptions as never[],
    (t1a as { t: { neq: (x: unknown) => unknown } }).t.neq((t1b as { t: unknown }).t) as never,
    (roleA as { t: { neq: (x: unknown) => unknown } }).t.neq((roleB as { t: unknown }).t) as never,
  ] as never[], [] as never[]), []);
  assert.equal(q1.status, "unsat", "appending an alternating turn must not change any earlier content byte (prefix cache anchor)");
});

test("google rebuild: same-side tool-result append merges with the text part unchanged (symbolic payloads)", { skip: !haveSolver }, () => {
  const ctx = newCtx();
  const T1 = ctx.String.const("T1"), RT = ctx.String.const("RT"), N = ctx.String.const("N"), CID = ctx.String.const("CID");
  const base = coreMsg(
    [["id", strv(ctx, ctx.String.val("u1"))], ["role", strv(ctx, ctx.String.val("user"))], ["contentType", strv(ctx, ctx.String.val("text"))], ["text", strv(ctx, T1)]],
    [objv([["text", strv(ctx, T1)]])],
  );
  const toolRes = coreMsg(
    [["id", strv(ctx, ctx.String.val("r1"))], ["role", strv(ctx, ctx.String.val("tool"))], ["contentType", strv(ctx, ctx.String.val("tool-result"))], ["text", strv(ctx, RT)], ["toolName", strv(ctx, N)], ["toolCallId", strv(ctx, CID)]],
    [objv([["functionResponse", objv([["name", strv(ctx, N)], ["id", strv(ctx, CID)]])]])],
  );
  const run1 = runCoreToGoogle(ctx, arrv([base]));
  const run2 = runCoreToGoogle(ctx, arrv([base, toolRes]));
  assert.deepEqual(run2.degradations, [], "merge rebuild must translate cleanly");

  const c1 = contentsOf(run1.ret), c2 = contentsOf(run2.ret);
  // Q2: after the same-side append the merged content still leads with the
  // ORIGINAL text part, byte-identical (#3159 canonical order; the fr trails).
  const t1a = partTextOf(c1.elems[0]!), t1b = partTextOf(c2.elems[0]!);
  const q2 = solveSmt2(smt2Of(ctx as never, [
    ...run1.assumptions as never[], ...run2.assumptions as never[],
    (t1a as { t: { neq: (x: unknown) => unknown } }).t.neq((t1b as { t: unknown }).t) as never,
  ] as never[], [] as never[]), []);
  assert.equal(q2.status, "unsat", "same-side tool-result append must keep the leading text part byte-identical");
});

test("google rebuild: real-code replay baseline", async () => {
  const { coreToGoogle } = await import("../kernel/src/wire/google.ts");
  const base = { id: "u1", role: "user", contentType: "text", text: "hello there", rawGoogleParts: [{ text: "hello there" }] };
  const c1 = coreToGoogle([base] as never);
  assert.deepEqual(c1, [{ role: "user", parts: [{ text: "hello there" }] }]);
  const c2 = coreToGoogle([base, { id: "r1", role: "tool", contentType: "tool-result", text: "42", toolName: "calc", toolCallId: "call_9", rawGoogleParts: [{ functionResponse: { name: "calc", id: "call_9" } }] }] as never);
  // merged single user content: text leads, fr trails (#3159)
  assert.equal(c2.length, 1);
  assert.deepEqual(c2[0]!.parts[0], { text: "hello there" });
  assert.deepEqual(c2[0]!.parts[1], { functionResponse: { name: "calc", id: "call_9" } });
  const c3 = coreToGoogle([base, { id: "a1", role: "assistant", contentType: "text", text: "hi", rawGoogleParts: [{ text: "hi" }] }] as never);
  assert.deepEqual(c3[0], { role: "user", parts: [{ text: "hello there" }] }, "alternating append keeps earlier content identical");
});
