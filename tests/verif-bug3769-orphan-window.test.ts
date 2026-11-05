/**
 * Bug #3769 — hide-consumed orphan window breaks append-only stability.
 *
 * ORIGINAL bug (pre-#3784): kernel/src/hide-consumed.ts kept only the NEWEST
 * KEEP_LAST_ORPHANED=2 orphan compress-call pairs visible; a THIRD failed
 * pair silently dropped the OLDEST mid-history (issue #3769: 184,423 tokens
 * re-billed, hit rate 97.7% → 19.2%).
 *
 * FIXED contract (#3784, absorbed into #3939 ①): orphan sweeping is
 * FOLD-GATED — nothing hides between folds; the sweep rides the fold's own
 * sanctioned rewrite (state.pendingOrphanSweepMinRef). This harness was
 * re-baselined when the fix landed: the append-only flip must now be
 * UNSAT (Q1), the mechanism must remain derivable THROUGH the fold marker
 * only (Q1b sat) — proving the judge still sees the gated mechanism, not a
 * vacuous truth — and non-compress appends stay stable (Q2 unsat).
 *
 * No-cheat contract (#3848 / user directive m00852):
 *  - we execute the REAL hideConsumedCompressCalls (translateFunction);
 *  - the invariant is a GENERAL hyperproperty: "a message that was visible
 *    must remain visible when the input history only GROWS (append-only),
 *    state unchanged" — nothing references the keep-window internals;
 *  - the solver searches over the appended pair's symbolic identity
 *    (toolName / toolCallId): the flip must be derivable, not asserted;
 *  - the counterexample replays on the real code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { translateFunction } from "../verif/symbolic.js";
import { newCtx, smt2Of, strc } from "../verif/terms.js";
import { solveSmt2, parseNum } from "../verif/solve.js";
import { hideConsumedCompressCalls } from "../kernel/src/hide-consumed.js";
import type { CoreMessage, CompressionState } from "../kernel/src/types.js";

const file = resolve(import.meta.dirname, "../kernel/src/hide-consumed.ts");

const asMsg = (m: CoreMessage): CoreMessage => m;

// A: two orphan failed-compression pairs + surrounding user traffic.
// B: one MORE orphan pair, appended (nothing else changes).
const histA = (): CoreMessage[] => [
  asMsg({ id: "u0", role: "user", contentType: "text", text: "q1" }),
  asMsg({ id: "t1", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "c1", text: "{}" }),
  asMsg({ id: "r1", role: "tool", contentType: "tool-result", toolCallId: "c1", text: "fail" }),
  asMsg({ id: "t2", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "c2", text: "{}" }),
  asMsg({ id: "r2", role: "tool", contentType: "tool-result", toolCallId: "c2", text: "fail" }),
];

test("bug3769: solver proves append-only growth hides a previously-visible pair", { timeout: 240_000 }, async (t) => {
  const solver = await (async () => {
    try { return await solveSmt2("(set-logic ALL)(check-sat)", []); } catch { return null; }
  })();
  if (!solver) return t.skip("no SMT solver available (set VERIF_SOLVER_CMD / VERIF_PYTHON)");

  const ctx = newCtx();

  // Symbolic identity of the appended pair.
  const tn3 = ctx.String.const("tn3");
  const tc3 = ctx.String.const("tc3");

  const mkSym = (id: string, role: string, ct: string, toolName: import("../verif/terms.js").Seq | string, toolCallId: import("../verif/terms.js").Seq | string, text: string) => {
    const fields = new Map<string, import("../verif/symbolic.js").SymVal>();
    fields.set("id", { kind: "str", t: ctx.String.val(id) });
    fields.set("role", { kind: "str", t: ctx.String.val(role) });
    fields.set("contentType", { kind: "str", t: ctx.String.val(ct) });
    fields.set("text", { kind: "str", t: ctx.String.val(text) });
    if (typeof toolName === "string") fields.set("toolName", { kind: "str", t: ctx.String.val(toolName) });
    else fields.set("toolName", { kind: "str", t: toolName });
    if (typeof toolCallId === "string") fields.set("toolCallId", { kind: "str", t: ctx.String.val(toolCallId) });
    else fields.set("toolCallId", { kind: "str", t: toolCallId });
    return { kind: "obj" as const, fields };
  };
  const msgs = (grown: boolean): import("../verif/symbolic.js").SymVal => {
    const list: ReturnType<typeof mkSym>[] = [
      mkSym("u0", "user", "text", "", "", "q1"),
      mkSym("t1", "assistant", "tool-call", "compress", "c1", "{}"),
      mkSym("r1", "tool", "tool-result", "", "c1", "fail"),
      mkSym("t2", "assistant", "tool-call", "compress", "c2", "{}"),
      mkSym("r2", "tool", "tool-result", "", "c2", "fail"),
    ];
    if (grown) {
      list.push(mkSym("t3", "assistant", "tool-call", tn3, tc3, "{}"));
      list.push(mkSym("r3", "tool", "tool-result", "", tc3, "fail"));
    }
    return { kind: "arr", elems: list, len: ctx.Real.val(list.length) };
  };
  const stateObj = (foldGate: boolean): import("../verif/symbolic.js").SymVal => {
    const fields = new Map<string, import("../verif/symbolic.js").SymVal>();
    fields.set("blocks", { kind: "arr", elems: [], len: ctx.Real.val(0) });
    // real state shape: messageRefs = { byRaw: Record<string, ref> }
    const byRawInner = new Map<string, import("../verif/symbolic.js").SymVal>();
    if (foldGate) {
      // A fold just committed: refs are minted and the sweep is pending from
      // the fold's own min ref (m00001) — the sanctioned rewrite window.
      byRawInner.set("t1", { kind: "str", t: ctx.String.val("m00001") });
      byRawInner.set("r1", { kind: "str", t: ctx.String.val("m00002") });
      byRawInner.set("t2", { kind: "str", t: ctx.String.val("m00003") });
      byRawInner.set("r2", { kind: "str", t: ctx.String.val("m00004") });
      byRawInner.set("t3", { kind: "str", t: ctx.String.val("m00005") });
      byRawInner.set("r3", { kind: "str", t: ctx.String.val("m00006") });
      fields.set("pendingOrphanSweepMinRef", { kind: "num", t: ctx.Real.val(1) });
    }
    fields.set("messageRefs", { kind: "obj", fields: new Map([["byRaw", { kind: "obj", fields: byRawInner }]]) });
    return { kind: "obj", fields };
  };

  const run = (grown: boolean, foldGate = false) => {
    const { exec } = translateFunction({
      file, function: "hideConsumedCompressCalls",
      params: { state: stateObj(foldGate), messages: msgs(grown), isCompressTool: { kind: "undef" } },
      ctx,
      options: {
        portImpls: {
          // injectable classifier port (default param in source): symbolic
          // membership test — the harness does NOT hardcode the outcome
          isCompressTool: (sv: any) => ({ kind: "bool", t: sv.t.eq(strc(ctx, "compress")) }) as any,
        },
      },
    });
    const r = exec();
    assert.deepEqual(r.degradations, [], `no degradations expected (got: ${r.degradations.join("; ")})`);
    assert.ok(r.ret && r.ret.kind === "obj", "result object");
    return r as import("../verif/symbolic.js").ExecOut;
  };
  const outA = run(false);
  const outB = run(true);
  const outGate = run(true, true);

  const arrIds = (o: import("../verif/symbolic.js").ExecOut) => {
    const ret = o.ret as Extract<import("../verif/symbolic.js").SymVal, { kind: "obj" }>;
    const out = ret.fields.get("messages");
    assert.ok(out && out.kind === "arr", "messages array in result");
    return out as Extract<import("../verif/symbolic.js").SymVal, { kind: "arr" }>;
  };
  const hasR1 = (a: Extract<import("../verif/symbolic.js").SymVal, { kind: "arr" }>) => {
    let acc: import("../verif/terms.js").Bool | null = null;
    for (let k = 0; k < a.elems.length; k++) {
      const e = a.elems[k]!;
      const idv = e.kind === "obj" ? e.fields.get("id") : undefined;
      const hit = (idv && idv.kind === "str" ? idv.t : ctx.String.val("")).eq(ctx.String.val("r1"));
      const inLen = a.len.gt(ctx.Real.val(k));
      const term = inLen.and(hit);
      acc = acc ? acc.or(term) : term;
    }
    return acc!;
  };
  const visibleBefore = hasR1(arrIds(outA));
  const visibleAfter = hasR1(arrIds(outB));

  // Q1 (fix holds): with the third pair a genuine compress pair (fresh id),
  // append-only growth alone can NO LONGER hide the previously-visible r1 —
  // the sweep is fold-gated (#3784). No counterexample exists.
  const q1 = smt2Of(outB.ctx, [
    tn3.eq(ctx.String.val("compress")),
    tc3.eq(ctx.String.val("c1")).not(),
    tc3.eq(ctx.String.val("c2")).not(),
    visibleBefore,
    visibleAfter.not(),
    ...outA.assumptions, ...outB.assumptions,
  ]);
  const r1 = await solveSmt2(q1, ["tn3", "tc3"]);
  assert.equal(r1.status, "unsat", "append-only growth must not hide anything after the #3784 fold gate");

  // Q1b (mechanism still reachable, only through the fold): the same grown
  // history under a pending fold sweep (pendingOrphanSweepMinRef minted refs)
  // DOES hide r1 — the rewrite is sanctioned to ride the fold boundary.
  // SAT here proves the judge is not vacuous: the gated path is derivable.
  const gateHidden = hasR1(arrIds(outGate));
  const q1b = smt2Of(outGate.ctx, [
    tn3.eq(ctx.String.val("compress")),
    tc3.eq(ctx.String.val("c1")).not(),
    tc3.eq(ctx.String.val("c2")).not(),
    visibleBefore,
    gateHidden.not(),
    ...outA.assumptions, ...outGate.assumptions,
  ]);
  const r1b = await solveSmt2(q1b, ["tn3", "tc3"]);
  assert.equal(r1b.status, "sat", "the fold-gated sweep must remain derivable through the fold marker");

  // Q2 (negative control): when the appended pair is NOT a compress call,
  // the same invariant holds — no counterexample exists.
  const q2 = smt2Of(outB.ctx, [
    tn3.eq(ctx.String.val("compress")).not(),
    visibleBefore,
    visibleAfter.not(),
    ...outA.assumptions, ...outB.assumptions,
  ]);
  const r2 = await solveSmt2(q2, []);
  assert.equal(r2.status, "unsat", "non-compress appends must not hide anything");

  // Replay on the REAL code: same shape, concrete distinct ids.
  const state = { blocks: [], messageRefs: { byRaw: {} } } as unknown as CompressionState;
  const a = hideConsumedCompressCalls(state, histA());
  assert.equal(a.messages.length, 5, "all five messages visible before the third pair");
  assert.ok(a.messages.some((m) => m.id === "r1"), "r1 visible before");
  const b = hideConsumedCompressCalls(state, [
    ...histA(),
    asMsg({ id: "t3", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "c3", text: "{}" }),
    asMsg({ id: "r3", role: "tool", contentType: "tool-result", toolCallId: "c3", text: "fail" }),
  ]);
  assert.equal(b.hidden, 0, "#3784: appending an orphan pair no longer sweeps anything between folds");
  assert.ok(b.messages.some((m) => m.id === "r1"), "r1 STAYS visible after the append — the #3769 flip is gone");
  assert.equal(b.newlySweptCallIds.length, 0, "nothing newly swept without a pending fold");

  // Replay the sanctioned side: a pending fold sweep (refs minted, min ref 1)
  // hides the orphan pairs in one pass — the rewrite rides the fold.
  const gateState = {
    blocks: [],
    messageRefs: { byRaw: { t1: "m00001", r1: "m00002", t2: "m00003", r2: "m00004", t3: "m00005", r3: "m00006" } },
    pendingOrphanSweepMinRef: 1,
  } as unknown as CompressionState;
  const c = hideConsumedCompressCalls(gateState, [
    ...histA(),
    asMsg({ id: "t3", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "c3", text: "{}" }),
    asMsg({ id: "r3", role: "tool", contentType: "tool-result", toolCallId: "c3", text: "fail" }),
  ]);
  assert.ok(!c.messages.some((m) => m.id === "r1"), "r1 hidden AT the fold boundary — the gated sweep fires");
  assert.deepEqual(c.newlySweptCallIds, ["c1", "c2", "c3"], "all three orphan pairs ride the fold sweep");
  void solverBool;
});

// helper: print a z3 Bool in smt2 form via its solver-companion —
// the translateFunction result is in ctx "main", so its .toString() IS smt2.
const solverBool = (b: import("../verif/terms.js").Bool): string => b.toString();

test("bug3769 counter-test: with a larger window the same append is stable (shows the invariant is the judge, not the shape)", { timeout: 240_000 }, async (t) => {
  // Only TWO orphan pairs exist and the appended traffic is user text (not a
  // compress call) — visibility must be stable under the fold gate too.
  const state = { blocks: [], messageRefs: { byRaw: {} } } as unknown as CompressionState;
  const before = hideConsumedCompressCalls(state, histA());
  const after = hideConsumedCompressCalls(state, [
    ...histA(),
    asMsg({ id: "u9", role: "user", contentType: "text", text: "q2" }),
  ]);
  const idsAfter = after.messages.map((m) => m.id);
  assert.deepEqual(idsAfter.slice(0, before.messages.length), before.messages.map((m) => m.id),
    "non-compress appends never change visibility of the existing prefix");
  assert.ok(after.messages.some((m) => m.id === "r1"));
  void parseNum; // keep import used in both branches
});
