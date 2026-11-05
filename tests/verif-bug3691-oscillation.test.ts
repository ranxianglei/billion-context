// #3691 (kernel/src/truncate-tools.ts): the emergency clip has no persistent
// record — the decision to clip depends only on the per-turn token meter, so
// the same message renders clipped this turn and full next turn. Outbound
// bytes for an unchanged message flip-flop: a provider prefix-cache seam on
// every flip. This harness proves the mechanism WITHOUT pointing the solver
// at the bug: the symbolic phase only asks "can the clip fire at all under a
// gate-level meter?", then the REAL two-turn replay checks the general
// stability invariant (same message in ⇒ same bytes out across turns when the
// client resent identical history). The mitigation check pins that raising
// the threshold to 1.0 restores stability.
//
// No-cheat rules (#3848): entry functions are the real kernel exports; the
// property is general (byte-stability), never asserted at bug lines; the
// counterexample witness must replay on the real code.
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { translateFunction } from "../verif/symbolic.ts";
import { newCtx, smt2Of } from "../verif/terms.ts";
import { solveSmt2, parseNum } from "../verif/solve.ts";
import { truncateLargeToolOutputs } from "../kernel/src/truncate-tools.ts";
import { defaultCountTokens } from "../kernel/src/tokenize.ts";

const LIMIT = 2000;
const GATE = LIMIT * 0.95; // emergencyTruncateNode gate: usage >= threshold

const realConfig = { modelContextLimit: LIMIT, truncate: { threshold: 0.95 } } as never;
const mkMsgs = (T: string): { id: string; role: "tool" | "user"; contentType: "tool-result" | "text"; toolCallId?: string; text: string }[] => [
  { id: "m0", role: "tool", contentType: "tool-result" as const, toolCallId: "tc0", text: T },
  { id: "m1", role: "user", contentType: "text" as const, text: "short 1" },
  { id: "m2", role: "user", contentType: "text" as const, text: "short 2" },
  { id: "m3", role: "user", contentType: "text" as const, text: "short 3" },
];

test("bug3691: solver finds a clip-triggering witness on the real truncation code", { timeout: 240_000 }, async (t) => {
  const solver = await (async () => { try { return await solveSmt2("(set-logic ALL)(check-sat)", []); } catch { return null; } })();
  if (!solver) return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");
  const ctx = newCtx();
  const T = ctx.String.const("T");
  const tok1 = ctx.Real.const("tok1");
  const msgs = { kind: "arr" as const, len: ctx.Real.val(4), elems: [
    { kind: "obj" as const, fields: new Map([
      ["id", { kind: "str" as const, t: ctx.String.val("m0") }],
      ["role", { kind: "str" as const, t: ctx.String.val("tool") }],
      ["contentType", { kind: "str" as const, t: ctx.String.val("tool-result") }],
      ["toolCallId", { kind: "str" as const, t: ctx.String.val("tc0") }],
      ["text", { kind: "str" as const, t: T }],
    ]) },
    ...[1, 2, 3].map((i) => ({ kind: "obj" as const, fields: new Map([
      ["id", { kind: "str" as const, t: ctx.String.val(`m${i}`) }],
      ["role", { kind: "str" as const, t: ctx.String.val("user") }],
      ["contentType", { kind: "str" as const, t: ctx.String.val("text") }],
      ["text", { kind: "str" as const, t: ctx.String.val(`short ${i}`) }],
    ]) })),
  ] };
  const config = { kind: "obj" as const, fields: new Map([
    ["modelContextLimit", { kind: "num" as const, t: ctx.Real.val(LIMIT) }],
    ["truncate", { kind: "obj" as const, fields: new Map([
      ["threshold", { kind: "num" as const, t: ctx.Real.val(0.95) }],
    ]) }],
  ]) };
  const meter = (sv: { kind: string; t?: unknown }) =>
    sv.kind === "str" ? { kind: "num" as const, t: ctx.ToReal((sv.t as import("../verif/terms.js").Seq).length()).div(ctx.Real.val(4)).add(ctx.Real.val(1)) } : { kind: "any" as const };

  const { exec } = translateFunction({
    file: fileURLToPath(new URL("../kernel/src/truncate-tools.ts", import.meta.url)),
    function: "truncateLargeToolOutputs",
    params: { messages: msgs, tokenCount: { kind: "num", t: tok1 }, config, countTokens: { kind: "any" }, options: { kind: "obj", fields: new Map([["includeTextMessages", { kind: "bool", t: ctx.Bool.val(true) }]]) } },
    ctx,
    options: { portImpls: { countTokens: meter } },
  });
  const out1 = exec();
  assert.deepEqual(out1.degradations, [], "translation must be degradation-free");
  const tc = (out1.ret as { kind: string; fields: Map<string, unknown> }).fields.get("truncatedCount") as { kind: string; t: import("../verif/terms.js").Arith };
  assert.equal(tc.kind, "num", "truncatedCount must stay symbolic");

  // Ask the solver: is there ANY input where the meter sits at the gate and
  // the clip fires? (Pure existence — no bug-specific shaping beyond the
  // scenario constraint "usage at the emergency threshold".)
  const q1 = smt2Of(out1.ctx, [
    tok1.ge(ctx.Real.val(GATE)),
    ctx.ToReal(T.length()).ge(ctx.Real.val(1)),
    tc.t.ge(ctx.Real.val(1)),
    ...out1.assumptions,
  ]);
  let res;
  try { res = await solveSmt2(q1, ["(str.len T)", "tok1"]); }
  catch (e) { t.skip(`solver unavailable: ${(e as Error).message.slice(0, 200)}`); return; }
  assert.equal(res.status, "sat", `expected sat, got ${res.status}: ${res.raw.slice(0, 400)}`);
  const lenT = parseNum(res.values[0]!);
  const tokW = parseNum(res.values[1]!);
  assert.ok(lenT >= 1, "witness must be a non-empty string");

  // Negative control: below the gate the clip can NEVER fire (translation
  // must not be able to produce phantom clips).
  const q2 = smt2Of(out1.ctx, [
    tok1.lt(ctx.Real.val(GATE)),
    tc.t.ge(ctx.Real.val(1)),
    ...out1.assumptions,
  ]);
  const res2 = await solveSmt2(q2, []);
  assert.equal(res2.status, "unsat", "clip must be unreachable below the gate");

  // ---- Phase 2: replay the witness on the REAL code, two turns ----
  const Tstr = "x".repeat(lenT);
  const r1 = truncateLargeToolOutputs(mkMsgs(Tstr) as never, Math.max(1, Math.round(tokW)), realConfig, defaultCountTokens, { includeTextMessages: true });
  assert.ok(r1.truncatedCount >= 1, `real code must clip with the witness (len=${lenT}, tok=${tokW})`);

  // Turn 2: the client resents the identical history; the provider meters
  // turn-1's OUTBOUND (clipped) text.
  const tok2 = defaultCountTokens(r1.messages[0]!.text ?? "") + 3;
  const r2 = truncateLargeToolOutputs(mkMsgs(Tstr) as never, tok2, realConfig, defaultCountTokens, { includeTextMessages: true });
  const out1b = r1.messages[0]!.text!;
  const out2 = r2.messages[0]!.text!;
  assert.notEqual(out1b, out2, "same resent history must not produce different outbound bytes across turns — #3691 flip");
});

test("bug3691 mitigation: threshold=1.0 makes the render stable across the same two turns", { timeout: 60_000 }, () => {
  const Tstr = "x".repeat(4001);
  const stable = { modelContextLimit: LIMIT, truncate: { threshold: 1.0 } } as never;
  const r1 = truncateLargeToolOutputs(mkMsgs(Tstr) as never, 1900, stable, defaultCountTokens, { includeTextMessages: true });
  const tok2 = defaultCountTokens(r1.messages[0]!.text ?? "") + 3;
  const r2 = truncateLargeToolOutputs(mkMsgs(Tstr) as never, tok2, stable, defaultCountTokens, { includeTextMessages: true });
  assert.equal(r1.messages[0]!.text, Tstr, "no clip with threshold=1");
  assert.equal(r2.messages[0]!.text, Tstr, "stable across turns");
});
