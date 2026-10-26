// Conflict-watch discipline judge (#3806 family / #2709 / #3815).
//
// Two properties, solver-checked over the REAL translated code of
// src/conflict-watch.ts:
//
//  J1 — witness gate (dshNativeCompactionWitness): the #2709 attribution
//       ("this rewrite is the client's own native compaction") may fire with a
//       non-zero refusal counter ONLY when the rewrite evidence shows a
//       SHRINKING history (incoming < 0.75 × knownBefore). A restart re-key
//       (#3806: 2793/2814 = 99%, 395/389 = 101% GREW) must stay in the quiet
//       unannounced-rewrite tier even with a stale refusal counter. This is
//       "attribution must accompany shrinkage" as a solver-certified absence:
//       NO session shape fires the witness while the fingerprint is flat.
//       Non-vacuity is pinned too: real #2709 landings (320/771, 427/875) DO
//       fire, boundary 749/1000 fires / 750/1000 does not, and without a
//       fingerprint (the fold-reconcile call site) the counter alone decides.
//
//  J2 — banner tier discipline (formatConflictSection): the one-compressor
//       command ("Keep exactly ONE compressor ...") may appear ONLY when a
//       CONFIRMED foreign third-party event exists (non-suspected,
//       non-sibling, non-display-only) AND it is within the active window.
//       Arbitrary symbolic kinds/timestamps over concrete detail shapes; the
//       #3806 regression shape (only unannounced-rewrite + inferred landing
//       absent) must produce the softer "cause not identified"/host-side
//       framing, never the removal command.
//
// No-cheat rules per verif/README.md: real entry functions only, general
// invariants only, replay mandatory, ports only at public seams, negative
// controls mandatory.

import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { translateFunction, type SymVal } from "../verif/symbolic.ts";
import { newCtx, smt2Of, type Context, type Term } from "../verif/terms.ts";
import { solveSmt2 } from "../verif/solve.ts";
import { dshNativeCompactionWitness } from "../src/conflict-watch.ts";

const CW = fileURLToPath(new URL("../src/conflict-watch.ts", import.meta.url));

// ---------------------------------------------------------------- helpers --
function haveSolver(): boolean {
  try {
    const r = solveSmt2("(check-sat)", []);
    return r.status === "sat" || r.status === "unsat";
  } catch {
    return false;
  }
}

const numv = (t: Term): SymVal => ({ kind: "num", t }) as SymVal;
const strv = (t: Term): SymVal => ({ kind: "str", t }) as SymVal;
const objv = (f: [string, SymVal][]): SymVal =>
  ({ kind: "obj", fields: new Map(f) }) as SymVal;

type ExecOut = { ret: SymVal | null; thrown: { kind: string } | null; assumptions: unknown[]; degradations: string[]; ctx: Context };

function runWitness(ctx: Context, session: SymVal, fingerprint: SymVal): ExecOut {
  const out = translateFunction({
    file: CW, function: "dshNativeCompactionWitness",
    params: { session, fingerprint }, ctx: ctx as never, options: {},
  }).exec();
  return out as unknown as ExecOut;
}

// ret may be undefined on guard paths — undefUnder carries the union.
function firedGT(ctx: Context, ret: SymVal | null, x: number): Term {
  if (!ret || ret.kind !== "num") return ctx.Bool.val(false) as never;
  const uu = (ret as { undefUnder?: Term }).undefUnder;
  const gt = (ret as unknown as { t: Term }).t.gt(ctx.Real.val(x)) as unknown as Term;
  return (uu ? (uu.not() as unknown as Term).and(gt) : gt) as never;
}

// session shape: { metadata: { pluginAgent, dshCompactionRefusals } }
function mkSession(ctx: Context, pa: Term, ref: Term): SymVal {
  return objv([["metadata", objv([
    ["pluginAgent", strv(pa)],
    ["dshCompactionRefusals", numv(ref)],
  ])]]);
}

test("conflict-watch J1: witness fires only on shrinking history (arbitrary sessions)", { timeout: 240_000 }, (t) => {
  if (!haveSolver()) return t.skip("no solver (set VERIF_PYTHON)");

  const ctx = newCtx();
  const PA = ctx.String.const("PA"), REF = ctx.Real.const("REF");
  const INC = ctx.Real.const("INC"), KN = ctx.Real.const("KN");
  const out = runWitness(ctx, mkSession(ctx, PA, REF), objv([
    ["incomingTotal", numv(INC)], ["knownBefore", numv(KN)],
  ]));
  assert.deepEqual(out.degradations, []);
  assert.equal(out.ret!.kind, "num", "witness returns a counter (symbolic ite of num/undef merged)");

  const fired = firedGT(ctx, out.ret, 0);
  const flat = INC.ge(KN.mul(ctx.Real.val(0.75))); // incoming >= 75% of known
  const known = KN.gt(ctx.Real.val(0));

  // Q1 discipline: firing with a flat-or-grown fingerprint is unreachable.
  const q1 = solveSmt2(smt2Of(ctx, [...(out.assumptions as Term[]), fired, known, flat] as never[], [] as never), []);
  assert.equal(q1.status, "unsat", "witness must not attribute a flat resend to native compaction (#3806 restart re-key)");

  // Q2 non-vacuity: a real landing shape fires (and returns the counter).
  const q2 = solveSmt2(smt2Of(ctx, [...(out.assumptions as Term[]), fired,
    PA.eq(ctx.String.val("dsh")), REF.eq(ctx.Real.val(17)), KN.eq(ctx.Real.val(771)), INC.eq(ctx.Real.val(320))] as never[], [] as never), []);
  assert.equal(q2.status, "sat", "#2709 landing 320/771 must fire");

  // Q3 gate: never fires for non-dsh agents or zero/negative refusals.
  const q3 = solveSmt2(smt2Of(ctx, [...(out.assumptions as Term[]), fired,
    PA.neq(ctx.String.val("dsh")).or(REF.le(ctx.Real.val(0)))] as never[], [] as never), []);
  assert.equal(q3.status, "unsat", "witness gated on pluginAgent=dsh AND refusals>0");

  // Q4 no-fingerprint call site (fold-reconcile): counter alone decides.
  const outNF = runWitness(ctx, mkSession(ctx, PA, REF), { kind: "undef" } as SymVal);
  const firedNF = firedGT(ctx, outNF.ret, 0);
  const q4 = solveSmt2(smt2Of(ctx, [...(outNF.assumptions as Term[]), firedNF,
    PA.eq(ctx.String.val("dsh")), REF.eq(ctx.Real.val(3))] as never[], [] as never), []);
  assert.equal(q4.status, "sat", "without fingerprint the counter alone decides (documented call-site contract)");
});

test("conflict-watch J1 replay: real code on the #2709/#3806 calibration shapes", () => {

  const md = (agent: string, refusals: number) => ({ pluginAgent: agent, dshCompactionRefusals: refusals });
  const fp = (i: number, k: number) => ({ incomingTotal: i, knownBefore: k });

  // #2709 real landings — shrinking, MUST attribute (returns the counter).
  assert.equal(dshNativeCompactionWitness({ metadata: md("dsh", 17) } as never, fp(320, 771)), 17);
  assert.equal(dshNativeCompactionWitness({ metadata: md("dsh", 17) } as never, fp(427, 875)), 17);
  // boundary: 74.9% fires, 75.0% does not.
  assert.equal(dshNativeCompactionWitness({ metadata: md("dsh", 5) } as never, fp(749, 1000)), 5);
  assert.equal(dshNativeCompactionWitness({ metadata: md("dsh", 5) } as never, fp(750, 1000)), undefined);
  // #3806 restart re-keys — flat/grown, MUST NOT attribute.
  assert.equal(dshNativeCompactionWitness({ metadata: md("dsh", 375) } as never, fp(2793, 2814)), undefined);
  assert.equal(dshNativeCompactionWitness({ metadata: md("dsh", 31) } as never, fp(395, 389)), undefined);
  // gates: wrong agent / zero counter / missing fingerprint.
  assert.equal(dshNativeCompactionWitness({ metadata: md("pi", 9) } as never, fp(100, 800)), undefined);
  assert.equal(dshNativeCompactionWitness({ metadata: md("dsh", 0) } as never, fp(100, 800)), undefined);
  assert.equal(dshNativeCompactionWitness({ metadata: md("dsh", 4) } as never, undefined), 4);
});

// ------------------------------------------------------------------- J2 ----
import { isSiblingConflictDetail, isDisplayOnlyConflictDetail } from "../src/thirdparty-scan.ts";
import { formatConflictSection, CONFLICT_ACTIVE_WINDOW_MS } from "../src/conflict-watch.ts";

const D_SIBLING = "dsh: billion-context-pi (native)";      // neutral: bili's own sibling
const D_SUSPECT = "x: acme-context (mcp) [suspected]";     // name-only guess
const D_FOREIGN = "m: real-comp (mcp)";                     // plain foreign compressor

function mkEvent(ctx2: Context, at: Term, kind: Term, detail: string): SymVal {
  return objv([["at", numv(at)], ["kind", strv(kind)], ["detail", strv(ctx2.String.val(detail))]]);
}

test("conflict-watch J2: one-compressor command only with confirmed ACTIVE foreign evidence (arbitrary kinds/ages)", { timeout: 240_000 }, (t) => {
  if (!haveSolver()) return t.skip("no solver (set VERIF_PYTHON)");

  const ctx = newCtx();
  const K1 = ctx.String.const("K1"), K2 = ctx.String.const("K2"), K3 = ctx.String.const("K3");
  const A1 = ctx.Real.const("A1"), A2 = ctx.Real.const("A2"), A3 = ctx.Real.const("A3");
  const NOW = ctx.Real.val(1_000_000_000_000);
  const events = { kind: "arr", elems: [
    mkEvent(ctx, A1, K1, D_SIBLING), mkEvent(ctx, A2, K2, D_SUSPECT), mkEvent(ctx, A3, K3, D_FOREIGN),
  ], len: ctx.Real.val(3) } as SymVal;

  const out = translateFunction({
    file: CW, function: "formatConflictSection",
    params: { events, now: numv(NOW) }, ctx: ctx as never,
    options: {
      portImpls: {
        // concrete-string display-tier classifiers (regex exec on symbolic
        // strings is the documented weak spot; details are concrete here)
        isSiblingConflictDetail: (sv) => ({ kind: "bool", t: ctx.Bool.val(isSiblingConflictDetail(String((sv as { t: { c?: string } }).t.c))) }),
        isDisplayOnlyConflictDetail: (sv) => ({ kind: "bool", t: ctx.Bool.val(isDisplayOnlyConflictDetail(String((sv as { t: { c?: string } }).t.c))) }),
        // timestamps are display-only — opaque strings suffice
        Date: () => ({ kind: "obj", fields: new Map() }),
        __method_toISOString: () => ({ kind: "str", t: ctx.String.val("1970-01-01T00:00:00.000Z") }),
      },
    },
  }).exec() as unknown as ExecOut;
  assert.deepEqual(out.degradations, []);
  assert.equal(out.ret!.kind, "arr");

  const lines = (out.ret as unknown as { elems: SymVal[]; len: Term }).elems;
  const lenT = (out.ret as unknown as { len: Term }).len;
  const CMD = "Keep exactly ONE compressor";
  let hasCmd = ctx.Bool.val(false) as unknown as Term;
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i]!;
    if (li.kind !== "str") continue;
    const contain = (li.t as Term).contains(ctx.String.val(CMD)) as unknown as Term;
    hasCmd = hasCmd.or(ctx.If(lenT.gt(ctx.Real.val(i)), contain, ctx.Bool.val(false))) as unknown as Term;
  }
  // domain: kind is the ConflictKind union — a free String could otherwise
  // model as containing the command phrase itself.
  const KINDS = ["third-party-plugin", "unannounced-rewrite", "orphan-reap", "native-compaction", "native-compaction-inferred", "identity-orphan"];
  const kindDomain = (k: Term): Term => KINDS.reduce((acc: Term, v: string) => acc.or(k.eq(ctx.String.val(v))) as unknown as Term, ctx.Bool.val(false) as unknown as Term);
  const dom = [kindDomain(K1), kindDomain(K2), kindDomain(K3)];

  // only the plain-detail event can be foreign-confirmed (sibling and
  // [suspected] details classify neutral/unverified by construction)
  const foreignConfirmed3 = K3.eq(ctx.String.val("third-party-plugin"));
  const active3 = NOW.sub(A3).le(ctx.Real.val(CONFLICT_ACTIVE_WINDOW_MS));

  // Q1 discipline: command without a confirmable foreign event is unreachable.
  const noForeign = K1.neq(ctx.String.val("third-party-plugin")).and(K2.neq(ctx.String.val("third-party-plugin"))).and(K3.neq(ctx.String.val("third-party-plugin")));
  const q1 = solveSmt2(smt2Of(ctx, [...(out.assumptions as Term[]), ...dom, hasCmd, noForeign] as never[], [] as never), []);
  assert.equal(q1.status, "unsat", "the removal command requires confirmed foreign evidence (#2545 tiering)");

  // Q2 active gate: a confirmed-but-historical (older than the window) event
  // must produce the softer verify-then-clear wording, not the command.
  // activeConfirmed ranges over ALL confirmed kinds (#2709 nci counts), so
  // staleness must pin every event, not just the foreign one.
  const allStale = NOW.sub(A1).gt(ctx.Real.val(CONFLICT_ACTIVE_WINDOW_MS)).and(NOW.sub(A2).gt(ctx.Real.val(CONFLICT_ACTIVE_WINDOW_MS))).and(active3.not());
  const q2 = solveSmt2(smt2Of(ctx, [...(out.assumptions as Term[]), ...dom, hasCmd, foreignConfirmed3, allStale] as never[], [] as never), []);
  assert.equal(q2.status, "unsat", "stale confirmed evidence must not command removal (#2102 active window)");

  // Q3 non-vacuity: the command IS reachable with fresh confirmed evidence.
  const q3 = solveSmt2(smt2Of(ctx, [...(out.assumptions as Term[]), ...dom, hasCmd] as never[], ["K3", "A3"] as never), ["K3", "A3"]);
  assert.equal(q3.status, "sat");
  const w: Record<string, string> = {};
  ["K3", "A3"].forEach((nm, i) => { w[nm] = q3.values[i] ?? ""; });
  assert.equal(w.K3, '"third-party-plugin"', "witness: the plain-detail event is the confirmed foreign one");
});

test("conflict-watch J2 replay: banner tiering on the #3806/#2709/#2545 ledger shapes", () => {
  const NOW = 1_000_000_000_000;
  const ev = (kind: string, detail: string, at = NOW): { at: number; kind: "third-party-plugin"; detail: string } => ({ at, kind, detail } as { at: number; kind: "third-party-plugin"; detail: string });
  const adviceOf = (events: { at: number; kind: string; detail: string }[]): string =>
    formatConflictSection(events as never, NOW).join("\n");

  // #3806 regression shape: ONLY unannounced rewrites (restart re-key) —
  // "cause not identified", never the removal command.
  const unannounced = adviceOf([ev("unannounced-rewrite", "restart re-keyed 2793/2814 ids")]);
  assert.ok(!unannounced.includes("Keep exactly ONE compressor"), "unconfirmed signals must not command removal");
  assert.ok(unannounced.includes("cause is not confirmed"), "unannounced-rewrite tier wording");

  // #2709 inferred landing: host-side explanation, no plugin hunt.
  const inferred = adviceOf([ev("native-compaction-inferred", "witness: refusals=17, 320/771")]);
  assert.ok(!inferred.includes("Keep exactly ONE compressor"));
  assert.ok(inferred.includes("do not go hunting"), "inferred landing gets the host-side branch");

  // confirmed foreign, fresh: the command IS given.
  const foreignFresh = adviceOf([ev("third-party-plugin", D_FOREIGN, NOW - 1000)]);
  assert.ok(foreignFresh.includes("Keep exactly ONE compressor"), "fresh confirmed foreign evidence commands removal");
  assert.ok(foreignFresh.includes(D_FOREIGN), "the confirmed event is shown");

  // confirmed foreign but older than the window: softer wording.
  const foreignStale = adviceOf([ev("third-party-plugin", D_FOREIGN, NOW - CONFLICT_ACTIVE_WINDOW_MS - 1)]);
  assert.ok(!foreignStale.includes("Keep exactly ONE compressor"), "stale confirmed evidence softens");

  // neutral-only ledger: stand-down wording, no command.
  const neutral = adviceOf([ev("third-party-plugin", D_SIBLING, NOW)]);
  assert.ok(!neutral.includes("Keep exactly ONE compressor"));
  assert.ok(neutral.includes("no second compressor is active"), "sibling ledger stands down");
});
