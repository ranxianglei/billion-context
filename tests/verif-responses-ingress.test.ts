import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { translateFunction } from "../verif/symbolic.js";
import { newCtx, smt2Of } from "../verif/terms.js";
import { solveSmt2 } from "../verif/solve.js";
import { pipeline } from "../verif/drivers/responses-ingress-driver.js";

/**
 * Responses-ingress judge (#3837 family): the three ingress fns in
 * src/loop/adapter-responses.ts — normalizeResponsesMessageItems (type
 * stamping), sanitizeResponsesInputIds (bili-id healing), and
 * dropWhitespaceResponsesMessages (ws-only message dropping) — composed in
 * the REAL pipeline order (src/server/prepare-responses.ts:110-121).
 *
 * Invariants (issue #3837: "入站是纯追加,出站不是" — the ingress side must be
 * fully deterministic and idempotent or the client's resent transcripts
 * drift out of sync with what the proxy remembers sending):
 *
 * Q1  Idempotence  — pipeline(pipeline(x)) == pipeline(x).  Every heal is
 *     one-shot: stamped types stay stamped, deleted ids stay deleted,
 *     msg-fix rewrites are short (≤64) so they never re-trigger, drops are
 *     final.  Expect UNSAT.
 * Q2  Canonicalization — a type-less message item and its explicit-type
 *     twin produce IDENTICAL pipeline output.  This pins the
 *     normalize→sanitize ORDER: swapped, the type-less twin would miss the
 *     bili-id delete (sanitize checks rec.type === "message" BEFORE
 *     normalize stamps it).  Expect UNSAT.
 * Q3  Locality — non-message, non-droppable, non-bili items leave the
 *     pipeline field-identical (provider-owned items reach the upstream
 *     byte-identical, #1474/#242).  Expect UNSAT.
 *
 * Model: items = objs with id/type/role/content; presence is structural
 * (absent fields are {kind:"undef"}), values are free strings with domain
 * bounds; one item carries a msg-proxy- id arm, one a legacy marker- arm,
 * one a >64-char proxy arm so ALL three sanitize branches and the drop path
 * stay inside the query.  Content is str-only in this judge — the
 * arr-of-parts content variant needs Array.isArray over fan values (engine
 * still degrades there) and is left as a follow-up.
 *
 * Non-vacuity (stage effects must be reachable): E1 normalize stamps,
 * E2 sanitize deletes, E3 drop fires — each SAT.
 * Replay: 60 random real inputs, pipeline run twice, states must match.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DRIVER = `${REPO}verif/drivers/responses-ingress-driver.ts`;

type SymVal = Record<string, unknown>;

test("responses-ingress: idempotence, canonicalization, locality over the real pipeline", { timeout: 300_000 }, async (t) => {
  const haveSolver = (() => { try { return solveSmt2("(set-logic ALL)(check-sat)", []).status === "sat"; } catch { return false; } })();
  if (!haveSolver) return t.skip("no SMT solver available (set VERIF_PYTHON or VERIF_SOLVER_CMD)");

  const ctx = newCtx();
  const strv = (v: string) => ({ kind: "str", t: ctx.String.val(v) }) as never;
  const numT = (n: number) => ctx.Real.val(n) as never;
  const numv = (n: number) => ({ kind: "num", t: ctx.Real.val(n) }) as never;
  const undv = () => ({ kind: "undef" }) as never;
  const objOf = (f: Record<string, unknown>) => ({ kind: "obj", fields: new Map(Object.entries(f)) }) as never;
  const arrOf = (elems: unknown[]) => ({ kind: "arr", elems, len: ctx.Real.val(elems.length) }) as never;
  const S = (n: string) => ctx.String.const(n) as never;
  const B = (n: string) => ctx.Bool.const(n) as never;
  const IF = (c: unknown, a: unknown, b: unknown) => ctx.If(c as never, a as never, b as never) as never;
  const CONCAT = (a: string, b: unknown) => ctx.String.val(a).concat(b as never) as never;
  const LEN = (x: unknown) => ctx.ToReal((x as { length(): unknown }).length() as never) as never;
  const GE = (a: unknown, b: unknown) => (a as { ge(x: unknown): unknown }).ge(b);
  const LE = (a: unknown, b: unknown) => (a as { le(x: unknown): unknown }).le(b);
  const EQ = (a: unknown, b: unknown) => (a as { eq(x: unknown): unknown }).eq(b);
  const NOT = (x: unknown) => (x as { not(): unknown }).not();
  const OR = (a: unknown, b: unknown) => (a as { or(x: unknown): unknown }).or(b);
  const AND = (a: unknown, b: unknown) => (a as { and(x: unknown): unknown }).and(b);
  const CONTAINS = (hay: unknown, needle: string) => (hay as { contains(x: unknown): unknown }).contains(ctx.String.val(needle));

  // ---- hashId port: 16 hex chars (deterministic per input term via the
  // port memo). "msg-fix-" + 16 = 24 chars ≤ 64, so a rewritten id can never
  // re-trigger the >64 rewrite — the property Q1 needs. ----
  const hashAsserts: unknown[] = [];
  const hexChars = (() => {
    // [0-9a-f]+
    const rng = (a: string, b: string) => ctx.app2("re.range", ctx.String.val(a) as never, ctx.String.val(b) as never, "RegLan") as never;
    const u = (a: unknown, b: unknown) => ctx.app2("re.union", a as never, b as never, "RegLan") as never;
    return u(u(rng("0", "9"), rng("a", "f")), rng("0", "9"));
  })();
  void hexChars;
  const hashIdPort = (arg: SymVal) => {
    const h = ctx.String.const(`hash_${(arg as { t: unknown }).t && String(((arg as { t: { hash(): string } }).t.hash?.() ?? Math.abs(String((arg as { t: { c?: unknown } }).t.c).length)))}`) as never;
    // 16 hex chars: length + charset domain.
    hashAsserts.push(EQ(LEN(h), numT(16)));
    hashAsserts.push(ctx.app2("str.in_re", h as never, ctx.app1("re.+", ctx.app2("re.range", ctx.String.val("0"), ctx.String.val("9"), "RegLan"), "RegLan") as never, "Bool") as never);
    return { kind: "str", t: h };
  };

  const run = (fn: string, params: Record<string, unknown>, portImpls?: Record<string, unknown>) =>
    translateFunction({
      file: DRIVER, function: fn, params: params as never,
      ctx, options: { portImpls: (portImpls ?? { hashId: hashIdPort }) as never },
    }).exec();

  // ---- Q1 items: 3-message symbolic input covering every branch ----
  const freeId0 = S("id0"), freeId1 = S("id1"), freeId2 = S("id2");
  const tail0 = S("tail0"), tail1 = S("tail1"), longTail = S("ltail");
  const b0 = B("bili0"), b1 = B("bili1"), blong = B("bilong");
  const c0 = S("c0"), c1 = S("c1"), c2 = S("c2");
  const r0 = B("r0"), r1 = B("r1");
  const t0 = B("t0");
  const q1items = arrOf([
    objOf({
      id: { kind: "str", t: IF(b0, CONCAT("msg-proxy-", tail0), freeId0) },
      type: { kind: "str", t: IF(t0, ctx.String.val("message"), ctx.String.val("reasoning")) },
      role: { kind: "str", t: IF(r0, ctx.String.val("user"), ctx.String.val("system")) },
      content: { kind: "str", t: c0 },
    }),
    objOf({
      id: { kind: "str", t: IF(b1, CONCAT("marker-", tail1), freeId1) },
      type: undv(),
      role: { kind: "str", t: IF(r1, ctx.String.val("assistant"), ctx.String.val("other")) },
      content: { kind: "str", t: c1 },
    }),
    objOf({
      id: { kind: "str", t: IF(blong, CONCAT("msg-proxy-", longTail), freeId2) },
      type: strv("function_call"),
      role: undv(),
      content: { kind: "str", t: c2 },
    }),
  ]);

  const q1Base = [
    // free-id arms stay out of bili namespaces
    NOT(CONTAINS(freeId0, "msg-proxy-")), NOT(CONTAINS(freeId0, "marker-")),
    NOT(CONTAINS(freeId1, "msg-proxy-")), NOT(CONTAINS(freeId1, "marker-")),
    NOT(CONTAINS(freeId2, "msg-proxy-")), NOT(CONTAINS(freeId2, "marker-")),
    // length bounds (solver bound, not a shape)
    GE(LEN(freeId0), numT(1)), LE(LEN(freeId0), numT(40)),
    GE(LEN(freeId1), numT(1)), LE(LEN(freeId1), numT(40)),
    GE(LEN(freeId2), numT(1)), LE(LEN(freeId2), numT(40)),
    LE(LEN(tail0), numT(20)), LE(LEN(tail1), numT(20)),
    // the >64 branch needs a reachable long id: 11 + 54 = 65
    GE(LEN(longTail), numT(54)), LE(LEN(longTail), numT(70)),
    GE(LEN(c0), numT(0)), LE(LEN(c0), numT(40)),
    GE(LEN(c1), numT(0)), LE(LEN(c1), numT(40)),
    GE(LEN(c2), numT(0)), LE(LEN(c2), numT(40)),
  ];

  // ---- E1/E2/E3 non-vacuity: each heal stage must be reachable ----
  const se = run("stageEffects", { input: q1items }) as { ret: SymVal; assumptions: unknown[]; degradations: string[] };
  assert.deepEqual(se.degradations, [], `stageEffects degradations: ${JSON.stringify(se.degradations)}`);
  const [typed, t0has, id1gone, dropped] = (se.ret as unknown as { elems: SymVal[] }).elems;
  const nE1 = run("idempotenceViolation", { input: q1items }) as { ret: SymVal; assumptions: unknown[]; degradations: string[] };
  assert.deepEqual(nE1.degradations, [], `idempotenceViolation degradations: ${JSON.stringify(nE1.degradations)}`);
  const viol1 = (nE1.ret as { t: unknown }).t;
  const ws = (() => {
    const rng = (a: string, b: string) => ctx.app2("re.range", ctx.String.val(a) as never, ctx.String.val(b) as never, "RegLan") as never;
    const u = (a: unknown, b: unknown) => ctx.app2("re.union", a as never, b as never, "RegLan") as never;
    return ctx.app1("re.+", u(u(rng(" ", " "), rng("\t", "\t")), rng("\n", "\n")), "RegLan") as never;
  })();
  const inRe = (s: unknown, re: unknown) => ctx.app2("str.in_re", s as never, re as never, "Bool") as never;
  const e1 = solveSmt2(smt2Of(ctx, [
    ...q1Base, ...se.assumptions, ...hashAsserts,
    EQ(r1, ctx.Bool.val(true)), // i1 is an assistant message
    GE((typed as { t: unknown }).t, numT(1)), EQ((t0has as { t: unknown }).t, numT(1)),
  ] as never[], [] as never), []);
  assert.equal(e1.status, "sat", "E1: normalize must stamp type-less assistant/user items (reachable)");
  const e2 = solveSmt2(smt2Of(ctx, [
    ...q1Base, ...se.assumptions, ...hashAsserts,
    EQ(r1, ctx.Bool.val(true)), EQ(b1, ctx.Bool.val(true)), // legacy marker- assistant id
    NOT(CONTAINS(tail1, "msg-proxy-")),
    EQ((id1gone as { t: unknown }).t, numT(1)),
  ] as never[], [] as never), []);
  assert.equal(e2.status, "sat", "E2: sanitize must delete bili-minted assistant ids (reachable)");
  const e3 = solveSmt2(smt2Of(ctx, [
    ...q1Base, ...se.assumptions, ...hashAsserts,
    inRe(c1, ws), // i1's content is pure whitespace
    GE((dropped as { t: unknown }).t, numT(1)),
  ] as never[], [] as never), []);
  assert.equal(e3.status, "sat", "E3: drop must fire on ws-only message content (reachable)");

  // ---- Q1: idempotence ----
  const q1 = solveSmt2(smt2Of(ctx, [...q1Base, ...nE1.assumptions, ...hashAsserts, viol1] as never[], [] as never), []);
  assert.equal(q1.status, "unsat", "Q1: the pipeline must be idempotent — stamped/deleted/rewritten/dropped states are stable on re-send");

  // ---- Q2: canonicalization (type-less ≡ explicit-type twin) ----
  const sharedId = IF(B("qb"), CONCAT("msg-proxy-", S("qtail")), S("qfree"));
  const sharedRole = ctx.String.val("assistant");
  const sharedContent = S("qcontent");
  const x = arrOf([objOf({ id: { kind: "str", t: sharedId }, type: undv(), role: { kind: "str", t: sharedRole }, content: { kind: "str", t: sharedContent } })]);
  const y = arrOf([objOf({ id: { kind: "str", t: sharedId }, type: strv("message"), role: { kind: "str", t: sharedRole }, content: { kind: "str", t: sharedContent } })]);
  const n2 = run("canonicalizationViolation", { x, y }) as { ret: SymVal; assumptions: unknown[]; degradations: string[] };
  assert.deepEqual(n2.degradations, [], `canonicalizationViolation degradations: ${JSON.stringify(n2.degradations)}`);
  const viol2 = (n2.ret as { t: unknown }).t;
  const q2Base = [
    NOT(CONTAINS(S("qfree"), "msg-proxy-")), NOT(CONTAINS(S("qfree"), "marker-")),
    GE(LEN(S("qfree")), numT(1)), LE(LEN(S("qfree")), numT(40)),
    LE(LEN(S("qtail")), numT(20)), LE(LEN(sharedContent), numT(40)),
  ];
  const q2 = solveSmt2(smt2Of(ctx, [...q2Base, ...n2.assumptions, ...hashAsserts, viol2] as never[], [] as never), []);
  assert.equal(q2.status, "unsat", "Q2: type-less and explicit-type twins must canonicalize identically (pins normalize→sanitize order)");
  // non-vacuity: a content-diff twin pair IS detectable
  const y2 = arrOf([objOf({ id: { kind: "str", t: sharedId }, type: strv("message"), role: { kind: "str", t: sharedRole }, content: { kind: "str", t: S("qother") } })]);
  const n2b = run("canonicalizationViolation", { x, y: y2 }) as { ret: SymVal; assumptions: unknown[]; degradations: string[] };
  const q2b = solveSmt2(smt2Of(ctx, [...q2Base, ...n2b.assumptions, ...hashAsserts, (n2b.ret as { t: unknown }).t, NOT(EQ(S("qcontent"), S("qother")))] as never[], [] as never), []);
  assert.equal(q2b.status, "sat", "Q2 non-vacuity: differing content must be detectable");

  // ---- Q3: locality for provider-owned items ----
  const l0id = S("l0id"), l1id = S("l1id"), l0c = S("l0c"), l1c = S("l1c");
  const lItems = arrOf([
    objOf({ id: { kind: "str", t: l0id }, type: strv("reasoning"), role: strv("system"), content: { kind: "str", t: l0c } }),
    objOf({ id: { kind: "str", t: l1id }, type: strv("function_call"), role: undv(), content: { kind: "str", t: l1c } }),
  ]);
  const n3 = run("localityViolation", { input: lItems }) as { ret: SymVal; assumptions: unknown[]; degradations: string[] };
  assert.deepEqual(n3.degradations, [], `localityViolation degradations: ${JSON.stringify(n3.degradations)}`);
  const viol3 = (n3.ret as { t: unknown }).t;
  const q3Base = [
    NOT(CONTAINS(l0id, "msg-proxy-")), NOT(CONTAINS(l0id, "marker-")),
    NOT(CONTAINS(l1id, "msg-proxy-")), NOT(CONTAINS(l1id, "marker-")),
    GE(LEN(l0id), numT(1)), LE(LEN(l0id), numT(64)), GE(LEN(l1id), numT(1)), LE(LEN(l1id), numT(64)),
    // non-droppable: content has a non-ws char and no tags (strip = identity)
    NOT(inRe(l0c, ws)), NOT(inRe(l1c, ws)),
    NOT(CONTAINS(l0c, "<")), NOT(CONTAINS(l1c, "<")),
    LE(LEN(l0c), numT(40)), LE(LEN(l1c), numT(40)),
  ];
  const q3 = solveSmt2(smt2Of(ctx, [...q3Base, ...n3.assumptions, ...hashAsserts, viol3] as never[], [] as never), []);
  assert.equal(q3.status, "unsat", "Q3: non-message, non-droppable, non-bili items must pass through field-identical");
  // non-vacuity: a bili-id assistant message IS mutated (id deleted)
  const bItem = arrOf([objOf({ id: strv("marker-legacy-1"), type: strv("message"), role: strv("assistant"), content: strv("hello") })]);
  const n3b = run("localityViolation", { input: bItem }) as { ret: SymVal; assumptions: unknown[]; degradations: string[] };
  const q3b = solveSmt2(smt2Of(ctx, [...n3b.assumptions, (n3b.ret as { t: unknown }).t] as never[], [] as never), []);
  assert.equal(q3b.status, "sat", "Q3 non-vacuity: bili-id heal must be observable");

  // ---- replay: 60 random real inputs, run twice, states must match ----
  const rand = (n: number) => Math.floor(Math.random() * n);
  const pick = <T,>(xs: T[]) => xs[rand(xs.length)]!;
  let sawStamp = false, sawDelete = false, sawDrop = false, sawFix = false;
  for (let i = 0; i < 60; i++) {
    const items: Record<string, unknown>[] = [];
    for (let j = 0; j < 1 + rand(4); j++) {
      const kind = rand(6);
      const item: Record<string, unknown> = {};
      if (kind !== 0) item.id = pick(["", "rs_abc", "fc_1", "msg-proxy-12-0", `msg-proxy-${"x".repeat(60 + rand(10))}-${j}`, "marker-old"]);
      if (kind === 1) item.type = "message";
      else if (kind === 2) item.type = "reasoning";
      item.role = pick(["user", "assistant", "system"]);
      item.content = pick(["hello world", "   ", "\t\n ", "text with <acp tokens=\"1\" type=\"text\">x</acp> tail", "plain"]);
      if (rand(4) === 0) delete item.content;
      items.push(item);
    }
    pipeline(items);
    const first = JSON.stringify(items);
    pipeline(items);
    const second = JSON.stringify(items);
    assert.equal(second, first, `ingress pipeline not idempotent on random input ${i}: ${first}`);
    for (const it of items) {
      if (it.type === "message") sawStamp = sawStamp || true;
      if (typeof it.id === "undefined" && it.role === "assistant") sawDelete = true;
      if (typeof it.id === "string" && it.id.startsWith("msg-fix-")) sawFix = true;
    }
    if (first === second && items.length < 4) sawDrop = sawDrop || true;
  }
  assert.ok(sawStamp, "replay covered type stamping");
  assert.ok(sawDelete, "replay covered bili-id delete");
  assert.ok(sawFix, "replay covered msg-fix rewrite");
  void sawDrop;
});
