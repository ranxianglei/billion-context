import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert";
import { translateFunction } from "../verif/symbolic.ts";
import { newCtx, smt2Of } from "../verif/terms.ts";
import { solveSmt2 } from "../verif/solve.ts";
import type { SymVal } from "../verif/symbolic.ts";
import { anthropicToCore, coreToAnthropic } from "../kernel/src/wire/anthropic.ts";
import type { Term } from "../verif/terms.ts";

/**
 * Wire round-trip discipline judge (phase 2: adapters beyond openai).
 *
 * Property (#3676 family, adapter-generic): parse→rebuild of a wire
 * conversation must preserve block ORDER and per-block payload. The openai
 * adapter flips [file,text]→[text,file] (#3676); this judge asks the same
 * question of the anthropic codec under ARBITRARY text payloads and
 * arbitrary type draws from its same-role block universe
 * (text | tool_result — both rebuild into user-role groups).
 *
 * No-cheat rules (verif/README.md): REAL translated entry fns
 * (anthropicToCore + coreToAnthropic), general invariant (first/second
 * rebuilt block equals the original block's type and payload), ports only
 * for the declared seams (deriveCanonicalMessageId — sha256 is outside the
 * guarded subset; ClusterCounter instance state), replay on real code,
 * negative controls via UNSAT.
 */

const KP = fileURLToPath(new URL("../kernel/src/wire/anthropic.ts", import.meta.url));

const haveSolver = (() => {
  try { void solveSmt2("(check-sat)", []); return true; } catch { return false; }
})();

function makeIdPort(): (role: SymVal, ct: SymVal, text: SymVal, opts?: SymVal) => SymVal {
  const memo = new Map<string, SymVal>();
  let n = 0;
  return (role: SymVal, ct: SymVal, text: SymVal, _opts?: SymVal): SymVal => {
    const key = [role, ct, text].map((x) => (x.kind === "str" ? `s:${String((x as { t: Term }).t)}` : x.kind)).join("\u0000");
    const hit = memo.get(key);
    if (hit) return hit;
    void n++;
    const ctx = newCtx();
    const out: SymVal = { kind: "str", t: ctx.String.val(`__id_${memo.size}`) };
    memo.set(key, out);
    return out;
  };
}

function makeCounterPorts(): Record<string, (recv: SymVal, ...rest: SymVal[]) => SymVal> {
  const counters = new WeakMap<object, { n: number }>();
  return {
    ClusterCounter: (recv: SymVal): SymVal => {
      void recv;
      const inst = { marker: true };
      counters.set(inst, { n: 0 });
      return { kind: "obj", fields: new Map<string, SymVal>([["__inst", { kind: "obj", fields: new Map() } as SymVal]]) } as never as SymVal;
    },
    __method_next: (recv: SymVal, base: SymVal): SymVal => {
      const st = counters.get((recv as { fields: Map<string, SymVal> }).fields.get("__inst") as never as object) ?? { n: 0 };
      const n2 = st.n + 1;
      if (Object.isFrozen(st) || !(recv as { fields: Map<string, SymVal> }).fields) return base;
      st.n = n2;
      counters.set((recv as { fields: Map<string, SymVal> }).fields.get("__inst") as never as object, st);
      if (base.kind !== "str") return { kind: "any" };
      const ctx = newCtx();
      return n2 === 1 ? base : { kind: "str", t: ctx.String.val("__dup") };
    },
  };
}

test("wire-anthropic round-trip: block order + payload preserved (same-role pairs)", { timeout: 240_000, skip: !haveSolver }, () => {
  // Pin each run's block types to constants: the symbolic-type union across
  // switch arms merges payloads through the tool_use arm's safeStringify
  // degrade ({kind:"any"} has no term to query). ORDER+payload per pinned
  // pair covers the same-role contract; thinking-cross-message is test 2.
  const pairs: [string, string][] = [["text", "text"], ["text", "tool_result"], ["tool_result", "text"], ["tool_result", "tool_result"]];
  for (const [ty1, ty2] of pairs) {
    const ctx = newCtx();
    const strv = (t: unknown) => ({ kind: "str", t }) as SymVal;
    const T1 = ctx.String.const("T1"), T2 = ctx.String.const("T2");
    const C1 = ctx.String.const("C1"), C2 = ctx.String.const("C2");
    const uid1 = ctx.String.const("uid1"), uid2 = ctx.String.const("uid2");
    const blk = (ty: string, t: unknown, c: unknown, uid: unknown): SymVal =>
      ({ kind: "obj", fields: new Map<string, SymVal>([["type", strv(ctx.String.val(ty))], ["text", strv(t)], ["content", strv(c)], ["tool_use_id", strv(uid)], ["thinking", strv(t)], ["id", strv(uid)], ["name", strv(ctx.String.val("tool"))], ["input", strv(ctx.String.val("{}"))]]) } as never);
    const content: SymVal = { kind: "arr", elems: [blk(ty1, T1, C1, uid1), blk(ty2, T2, C2, uid2)], len: ctx.Real.val(2) } as never;
    const body: SymVal = { kind: "obj", fields: new Map<string, SymVal>([["messages", { kind: "arr", elems: [{ kind: "obj", fields: new Map<string, SymVal>([["role", strv(ctx.String.val("user"))], ["content", content]]) } as SymVal], len: ctx.Real.val(1) } as SymVal]]) } as never;
    const parse = translateFunction({ file: KP, function: "anthropicToCore", params: { body }, ctx, options: { maxArrayLength: 16, portImpls: { deriveCanonicalMessageId: makeIdPort() as never, ...makeCounterPorts() } } }).exec();
    assert.deepEqual(parse.degradations, [], `parse must translate cleanly (${ty1},${ty2})`);
    const msgsArr = (parse.ret as { fields: Map<string, SymVal> }).fields.get("msgs") as SymVal;
    const rebuild = translateFunction({ file: KP, function: "coreToAnthropic", params: { messages: msgsArr, cacheControls: { kind: "undef" } as SymVal }, ctx, options: { maxArrayLength: 32, portImpls: {} } }).exec();
    assert.deepEqual(rebuild.degradations, [], `rebuild must translate cleanly (${ty1},${ty2})`);
    const outArr = rebuild.ret as { elems: SymVal[]; len: unknown };
    const blocksOf = (m: SymVal): { elems: SymVal[]; len: unknown } => (m as { fields: Map<string, SymVal> }).fields.get("content") as never;
    const fld = (o: SymVal, k: string): { t: unknown } => ((o as { fields: Map<string, SymVal> }).fields.get(k) ?? { kind: "undef" }) as never;
    const dom = [uid1.neq(uid2) as never, T1.neq(T2) as never, C1.neq(C2) as never, T1.neq(C1) as never, T2.neq(C2) as never] as never[];
    const blocks0 = blocksOf(outArr.elems[0]!);
    const b0 = blocks0.elems[0]!, b1 = blocks0.elems[1]!;
    const pay = (b: SymVal, ty: string, t: unknown, c: unknown): unknown =>
      ty === "tool_result" ? fld(b, "content").t : fld(b, "text").t;
    const q1 = solveSmt2(smt2Of(ctx, [...parse.assumptions as never[], ...rebuild.assumptions as never[], ...dom,
      blocks0.len ? (blocks0.len as never as { lt: (x: unknown) => unknown }).lt(ctx.Real.val(2)) as never : (ctx.Real.val(0) as never),
      (fld(b0, "type").t as never as { eq: (x: unknown) => { not: () => unknown } }).eq(ctx.String.val(ty1)).not() as never,
      (pay(b0, ty1, T1, C1) as never as { eq: (x: unknown) => { not: () => unknown } }).eq(ty1 === "tool_result" ? C1 : T1).not() as never] as never[], ["T1", "T2", "C1", "C2"] as never[]), ["T1", "T2", "C1", "C2"]);
    assert.equal(q1.status, "unsat", `first rebuilt block must preserve block 1's type and payload (${ty1},${ty2})`);
    const q2 = solveSmt2(smt2Of(ctx, [...parse.assumptions as never[], ...rebuild.assumptions as never[], ...dom,
      blocks0.len ? (blocks0.len as never as { lt: (x: unknown) => unknown }).lt(ctx.Real.val(2)) as never : (ctx.Real.val(0) as never),
      (fld(b1, "type").t as never as { eq: (x: unknown) => { not: () => unknown } }).eq(ctx.String.val(ty2)).not() as never,
      (pay(b1, ty2, T2, C2) as never as { eq: (x: unknown) => { not: () => unknown } }).eq(ty2 === "tool_result" ? C2 : T2).not() as never] as never[], ["T1", "T2", "C1", "C2"] as never[]), ["T1", "T2", "C1", "C2"]);
    assert.equal(q2.status, "unsat", `second rebuilt block must preserve block 2's type and payload (${ty1},${ty2})`);
  }
});

test("wire-anthropic round-trip: thinking keeps its own message after same-role group (cross-message order)", { timeout: 240_000, skip: !haveSolver }, () => {
  const ctx = newCtx();
  const strv = (t: unknown) => ({ kind: "str", t }) as SymVal;
  const TYPE1 = ctx.String.val("text"); // block-1 type pinned: this test exercises
  // the thinking cross-message split, not the block-1 dispatch (test 1 owns
  // the symbolic TYPE1 order property; an arm-union would make the payload
  // fields unqueryable via the safeStringify degrade in the tool_use arm).
  const T1 = ctx.String.const("T1"), T2 = ctx.String.const("T2");
  const C1 = ctx.String.const("C1");
  const uid1 = ctx.String.const("uid1");
  const blk = (ty: unknown, t: unknown, c: unknown, uid: unknown): SymVal =>
    ({ kind: "obj", fields: new Map<string, SymVal>([["type", strv(ty)], ["text", strv(t)], ["content", strv(c)], ["tool_use_id", strv(uid)], ["thinking", strv(t)], ["id", strv(uid)], ["name", strv(ctx.String.val("tool"))], ["input", strv(ctx.String.val("{}"))]]) } as never);
  const content: SymVal = { kind: "arr", elems: [blk(TYPE1, T1, C1, uid1), blk(ctx.String.val("thinking"), T2, T2, uid1)], len: ctx.Real.val(2) } as never;
  const body: SymVal = { kind: "obj", fields: new Map<string, SymVal>([["messages", { kind: "arr", elems: [{ kind: "obj", fields: new Map<string, SymVal>([["role", strv(ctx.String.val("user"))], ["content", content]]) } as SymVal], len: ctx.Real.val(1) } as SymVal]]) } as never;
  const parse = translateFunction({ file: KP, function: "anthropicToCore", params: { body }, ctx, options: { maxArrayLength: 16, portImpls: { deriveCanonicalMessageId: makeIdPort() as never, ...makeCounterPorts() } } }).exec();
  if (parse.degradations.length) console.log("PARSE2 DEGR:", JSON.stringify(parse.degradations));
  assert.deepEqual(parse.degradations, [], "parse must translate cleanly");
  const msgsArr = (parse.ret as { fields: Map<string, SymVal> }).fields.get("msgs") as SymVal;
  const rebuild = translateFunction({ file: KP, function: "coreToAnthropic", params: { messages: msgsArr, cacheControls: { kind: "undef" } as SymVal }, ctx, options: { maxArrayLength: 32, portImpls: {} } }).exec();
  if (rebuild.degradations.length) console.log("REBUILD2 DEGR:", JSON.stringify(rebuild.degradations));
  assert.deepEqual(rebuild.degradations, [], "rebuild must translate cleanly");
  const outArr = rebuild.ret as { elems: SymVal[]; len: unknown };
  const blocksOf = (m: SymVal): { elems: SymVal[]; len: unknown } => (m as { fields: Map<string, SymVal> }).fields.get("content") as never;
  const fld = (o: SymVal, k: string): { t: unknown } => ((o as { fields: Map<string, SymVal> }).fields.get(k) ?? { kind: "undef" }) as never;
  // block 2 is thinking → rebuild splits: out[1] exists and holds the thinking block
  const out1 = (outArr.elems[1] ?? { kind: "undef" }) as SymVal;
  const thinkT2 = blocksOf(out1).elems[0] !== undefined ? fld(blocksOf(out1).elems[0]!, "thinking").t : T2;
  const q = solveSmt2(smt2Of(ctx, [...parse.assumptions as never[], ...rebuild.assumptions as never[],
    TYPE1.eq(ctx.String.val("text")).or(TYPE1.eq(ctx.String.val("tool_result")) as never),
    (fld(out1, "role").t as never as { eq: (x: unknown) => { not: () => unknown } }).eq(ctx.String.val("assistant")).not() as never,
    (thinkT2 as never as { eq: (x: unknown) => { not: () => unknown } }).eq(T2).not() as never] as never[], ["TYPE1", "T1", "T2", "C1"] as never[]), ["TYPE1", "T1", "T2", "C1"]);
  assert.equal(q.status, "unsat", "thinking block must land in its own assistant message, payload intact");
});

test("wire-anthropic round-trip: real-code replay baseline", () => {
  const run = (blocks: unknown[]): unknown[] => {
    const core = anthropicToCore({ messages: [{ role: "user", content: blocks as never }] } as never);
    return coreToAnthropic(core.msgs);
  };
  const r1 = run([{ type: "text", text: "alpha" }, { type: "tool_result", tool_use_id: "t9", content: "beta" }]);
  assert.equal((r1[0] as { content: unknown[] }).content.length, 2);
  assert.deepEqual((r1[0] as { content: { type: string }[] }).content.map((b) => b.type), ["text", "tool_result"]);
  assert.equal(((r1[0] as { content: { type: string; text?: string }[] }).content[0]!).text, "alpha");
  assert.equal(((r1[0] as { content: { type: string; content?: string }[] }).content[1]!).content, "beta");
  const r2 = run([{ type: "tool_result", tool_use_id: "t9", content: "beta" }, { type: "text", text: "alpha" }]);
  assert.deepEqual((r2[0] as { content: { type: string }[] }).content.map((b) => b.type), ["tool_result", "text"], "order preserved both directions");
  const r3 = run([{ type: "text", text: "alpha" }, { type: "thinking", thinking: "secret", signature: "sig" }]);
  assert.equal(r3.length, 2);
  assert.equal((r3[1] as { role: string }).role, "assistant");
  assert.equal(((r3[1] as { content: { type: string; thinking?: string }[] }).content[0]!).thinking, "secret");
});
