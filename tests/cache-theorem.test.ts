/**
 * Cache-stability theorems (#2149) -- solver lane.
 *
 * Machine-checked statements (Z3, pinned z3-solver==4.9.1.0 in CI):
 *   T1 growth stability  f(H) vs f(H+[m]) byte-equal up to depth D outside the
 *                        existentially quantified declared carrier positions
 *                        (two scenarios: merge anchor flips / stationary).
 *   T2 ref monotonicity  persistent monotone cursor => no allocation reissues
 *                        an ever-issued number (kernel id-never-reused contract).
 *   Mutations            a stable-byte rewrite (T1), a post-archive cursor
 *                        reset (T2, the #421 residual) and a claim-state-coupled
 *                        ref presentation (T2, #3198 hardening) MUST be found by
 *                        the solver as counterexamples -- the proofs are not vacuous.
 *
 * Trust boundary: theorems are proven over proof/spec/*.smt2 (the assembly
 * CONTRACT). The [grounding:*] subtests below pin each spec axiom to the real
 * code (serializer escaping, tag rendering, ref-cursor mechanics); the #2144
 * billing suite pins the whole-body behavior empirically. See proof/README.md.
 *
 * Solver availability: a `z3` CLI on PATH or python3 with the `z3` module.
 * Without either, solver subtests skip individually (grounding always runs) so
 * the main suite stays green on boxes without a solver; the CI theorem lane
 * guarantees execution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "node:url";
import type { CoreMessage } from "../kernel/src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIR = path.join(repoRoot, "proof", "spec");
const SOLVER_TIMEOUT_MS = 120_000;

type SolverKind = "cli" | "py" | null;

function detectSolver(): SolverKind {
  const cli = spawnSync("z3", ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (!cli.error && cli.status === 0) return "cli";
  const py = spawnSync(
    "python3",
    ["-c", "import z3"],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (!py.error && py.status === 0) return "py";
  return null;
}

const PY_SHIM = `
import re, sys
import z3

src = open(sys.argv[1], "r").read()
want_model = sys.argv[2] == "1"
names = [n for n in sys.argv[3].split(",") if n]
if want_model:
    src += "\\n(set-option :model true)\\n(get-model)\\n"
s = z3.Solver()
s.from_string(src)
r = s.check()
print("VERDICT:" + ("sat" if r == z3.sat else ("unsat" if r == z3.unsat else "unknown")))
if want_model and r == z3.sat:
    m = s.model()
    # new bindings expose to_smt2(); 4.9.x only has the internal str() form
    txt = m.to_smt2() if hasattr(m, "to_smt2") else str(m)
    for name in names:
        val = None
        hit = re.search(r"\\(define-fun " + re.escape(name) + r" \\(\\)[^\\n]*? ([^)\\n]+)\\)", txt)
        if hit:
            val = hit.group(1)
        else:
            hit = re.search(r"(?:^|[\\s,\\[])" + re.escape(name) + r" = ([^\\s,\\]\\]]+)", txt)
            if hit:
                val = hit.group(1)
        print("MODEL:%s=%s" % (name, val if val is not None else "?"))
`;

interface Check {
  name: string;
  parts: string[];
  expect: "sat" | "unsat";
  modelVars?: string[];
}

const CHECKS: Check[] = [
  { name: "t1-s1-context-consistent", parts: ["preamble.smt2", "t1-s1.smt2"], expect: "sat" },
  {
    name: "t1-s1-growth-stability",
    parts: ["preamble.smt2", "t1-s1.smt2", "t1-s1-theorem.smt2"],
    expect: "unsat",
  },
  {
    // verdict-only: the corrupted content constant is existentially hidden by
    // construction (spec-level abstraction); the byte surface is #2144's job
    name: "t1-s1-stable-byte-mutation",
    parts: ["preamble.smt2", "t1-s1.smt2", "t1-s1-mutation.smt2"],
    expect: "sat",
  },
  { name: "t1-s2-context-consistent", parts: ["preamble.smt2", "t1-s2.smt2"], expect: "sat" },
  {
    name: "t1-s2-growth-stability",
    parts: ["preamble.smt2", "t1-s2.smt2", "t1-s2-theorem.smt2"],
    expect: "unsat",
  },
  {
    // verdict-only, same rationale as the S1 mutation above
    name: "t1-s2-middle-element-mutation",
    parts: ["preamble.smt2", "t1-s2.smt2", "t1-s2-mutation.smt2"],
    expect: "sat",
  },
  { name: "t2-context-consistent", parts: ["preamble.smt2", "t2.smt2"], expect: "sat" },
  {
    name: "t2-no-reuse-under-monotone-cursor",
    parts: ["preamble.smt2", "t2.smt2", "t2-host.smt2"],
    expect: "unsat",
  },
  {
    name: "t2-archive-reset-reissues",
    parts: ["preamble.smt2", "t2.smt2", "t2-mutation.smt2"],
    expect: "sat",
    modelVars: ["hui", "creset", "n3", "n4"],
  },
  {
    // #3198 hardening: if live-ref presentation were gated on reconcile CLAIM
    // state instead of the persistent content-keyed map, byte-equal mid-history
    // messages could present under different refs across turns. Shipped code has
    // no such coupling ([grounding:g1] pins the allocator half, [grounding:g4]
    // the id-derivation half).
    name: "t2-claimcoupling-permits-ref-drift",
    parts: ["preamble.smt2", "t2.smt2", "t2-claimcoupling.smt2"],
    expect: "sat",
    modelVars: ["storedNum", "curNum", "rA", "rB"],
  },
];

function runCheck(kind: "cli" | "py", check: Check): { verdict: string; models: string[]; ms: number } {
  const src = check.parts.map((p) => readFileSync(path.join(SPEC_DIR, p), "utf8")).join("\n\n");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bili-theorem-"));
  const file = path.join(tmp, check.name + ".smt2");
  const wantModel = check.expect === "sat";
  // The spec files carry assertions only. As a z3 CLI script they execute no
  // check command and print no verdict unless (check-sat) is appended; the
  // python-API path checks programmatically and needs nothing extra.
  const trailer =
    kind === "cli"
      ? wantModel
        ? "\n(set-option :model true)\n(check-sat)\n(get-model)\n"
        : "\n(check-sat)\n"
      : wantModel
        ? "\n(set-option :model true)\n(get-model)\n"
        : "";
  writeFileSync(file, src + trailer);
  const args =
    kind === "cli"
      ? ["z3", "-smt2", file]
      : ["python3", "-c", PY_SHIM, file, wantModel ? "1" : "0", (check.modelVars ?? []).join(",")];
  const start = Date.now();
  const res = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: SOLVER_TIMEOUT_MS });
  const ms = Date.now() - start;
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  let verdict = "unknown";
  const vm = out.match(/VERDICT:(\w+)/);
  if (vm) verdict = vm[1];
  else {
    const lines = out.split("\n").map((l) => l.trim());
    verdict = lines.find((l) => l === "sat" || l === "unsat" || l === "unknown") ?? "error";
    if (res.error) verdict = `error:${String(res.error)}`;
  }
  // py path: MODEL:name=value lines from the shim. cli path: z3 prints the
  // model as (define-fun name () Int <value>) pairs, value possibly on a
  // following line.
  const models = [
    ...out.matchAll(/MODEL:(\w+)=([^\s)]+)/g),
    ...(kind === "cli" ? [...out.matchAll(/\(define-fun (\w+) \(\) Int\r?\n?\s*(-?\d+)/g)] : []),
  ].map((m) => `${m[1]}=${m[2]}`);
  return { verdict, models, ms };
}

test("cache-theorem: solver obligations", async (t) => {
  const kind = detectSolver();
  if (kind === null) {
    await t.test("solver unavailable -> skip", (st) => {
      st.skip("no z3 CLI and no python3 z3 module on this box; CI theorem lane covers execution");
    });
    return;
  }
  const timings: Array<[string, string, string[], number]> = [];
  for (const check of CHECKS) {
    await t.test(check.name, async () => {
      const { verdict, models, ms } = runCheck(kind, check);
      timings.push([check.name, verdict, models, ms]);
      assert.equal(verdict, check.expect, `expected ${check.expect}, got ${verdict}`);
      if (check.expect === "sat" && check.modelVars?.length) {
        assert.ok(models.length > 0, "SAT check should expose a model witness");
      }
    });
  }
  const report =
    timings.map(([name, verdict, models, ms]) => `${name}: ${verdict} ${models.join(" ")} ${ms}ms`)
      .join("\n") + `\ntotal: ${timings.reduce((a, [, , , ms]) => a + ms, 0)}ms`;
  process.stdout.write(report + "\n");
});

// Grounding: pins each spec axiom to the real code; runs WITHOUT a solver.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randBmpString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    // valid BMP chars only: exclude surrogates (0xD800-0xDFFF) to stay clear
    // of lone-surrogate engine edge cases
    let cp: number;
    do {
      cp = Math.floor(rng() * 0x10000);
    } while (cp >= 0xd800 && cp <= 0xdfff);
    out += String.fromCodePoint(cp);
  }
  return out;
}

test("[grounding:g3] esc homomorphism + injectivity pinned to the real serializer", () => {
  const rng = mulberry32(0x2149);
  for (let i = 0; i < 200; i++) {
    const a = randBmpString(rng, 24);
    const b = randBmpString(rng, 24);
    const inner = (s: string) => JSON.stringify(s).slice(1, -1);
    assert.equal(inner(a + b), inner(a) + inner(b), "E1 homomorphism");
    if (inner(a) === inner(b)) assert.equal(a, b, "E2 injectivity (collision case)");
  }
});

test("[grounding:g2] mktag determinism/injectivity pinned to indexToRef", async () => {
  const { indexToRef, refToIndex } = await import("../kernel/src/refs.js");
  const seen = new Set<string>();
  for (let i = 1; i <= 200_000; i++) {
    const tag = indexToRef(i);
    assert.equal(indexToRef(i), tag, "determinism");
    assert.ok(!seen.has(tag), `injectivity at ${i}`);
    seen.add(tag);
    assert.equal(refToIndex(tag), i, "round-trip");
  }
});

test("[grounding:g1] ref cursor mechanics pinned to assignRefs/allocateFreeRef", async () => {
  const { assignRefs, emptyRefMap, highestUsedIndex, BLOCKED_REF } = await import("../kernel/src/refs.js");
  const msg = (id: string): CoreMessage => ({ id, role: "user", contentType: "text" });

  const liveNumbers = (map: ReturnType<typeof emptyRefMap>): number[] =>
    Object.values(map.byRaw)
      .filter((v) => v !== BLOCKED_REF)
      .map((v) => Number(v.replace(/^m0*/, "")));

  // fresh assignment: smallest free number >= max(nextIndex, 1); cursor := n+1
  {
    const existing = emptyRefMap();
    existing.byRaw["a"] = "m00005";
    existing.byRef["m00005"] = "a";
    existing.byRaw["b"] = "m00002";
    existing.byRef["m00002"] = "b";
    existing.byRaw["c"] = "m00003";
    existing.byRef["m00003"] = "c";
    const res = assignRefs([msg("q1")], { existing, nextIndex: 6 });
    assert.equal(res.newlyAssigned, 1);
    assert.equal(res.nextIndex, 7, "cursor := allocated+1");
    assert.equal(res.map.byRaw["q1"], "m00006", "smallest free >= nextIndex");
    assert.equal(highestUsedIndex(res.map), 6);
  }
  // pre-existing binding untouched; gap below the cursor is claimable
  {
    const existing = emptyRefMap();
    existing.byRaw["a"] = "m00005";
    existing.byRef["m00005"] = "a";
    const res = assignRefs([msg("a"), msg("q")], { existing, nextIndex: 4 });
    assert.equal(res.map.byRaw["a"], "m00005", "existing untouched");
    assert.equal(res.newlyAssigned, 1, "existing message consumes no number");
    assert.equal(res.map.byRaw["q"], "m00004", "gap below cursor is the first free slot");
    assert.equal(res.nextIndex, 5);
  }
  // BLOCKED consumes no number
  {
    const res = assignRefs(
      [msg("p"), msg("q")],
      { existing: emptyRefMap(), nextIndex: 1, isProtected: (m) => m.id === "p" },
    );
    assert.equal(res.map.byRaw["p"], BLOCKED_REF);
    assert.equal(res.map.byRaw["q"], "m00001", "protected message consumes no number");
    assert.equal(res.nextIndex, 2);
  }
  // monotone: sequential appends yield strictly increasing numbers
  {
    let map = emptyRefMap();
    let cursor = 1;
    let prev = 0;
    const rng = mulberry32(0xbeef);
    for (let i = 0; i < 50; i++) {
      const id = `x${Math.floor(rng() * 1e9)}`;
      const res = assignRefs([msg(id)], { existing: map, nextIndex: cursor });
      map = res.map;
      cursor = res.nextIndex;
      const nums = liveNumbers(map);
      const newest = Number(map.byRaw[id].replace(/^m0*/, ""));
      assert.ok(newest > prev, "strictly increasing");
      prev = newest;
      assert.equal(new Set(nums).size, nums.length, "live bindings pairwise distinct");
      assert.equal(cursor, prev + 1, "cursor tracks highest allocated + 1");
    }
  }
});

test("[grounding:g4] raw-id derivation pinned: determinism + prefix-extension invariance", async () => {
  const { deriveMessageId, ClusterCounter } = await import("../kernel/src/wire/message-id.js");
  const opts = { toolCallId: "tc-1", toolName: "bash" };
  const id = deriveMessageId("tool", "tool-result", "output text", opts);
  assert.equal(deriveMessageId("tool", "tool-result", "output text", opts), id, "determinism");
  assert.notEqual(deriveMessageId("user", "tool-result", "output text", opts), id, "role participates");
  assert.notEqual(deriveMessageId("tool", "text", "output text", opts), id, "contentType participates");
  assert.notEqual(
    deriveMessageId("tool", "tool-result", "output text", { toolCallId: "tc-2", toolName: "bash" }),
    id,
    "toolCallId participates",
  );
  assert.notEqual(
    deriveMessageId("tool", "tool-result", "output text", { toolCallId: "tc-1", toolName: "cat" }),
    id,
    "toolName participates",
  );
  assert.notEqual(deriveMessageId("tool", "tool-result", "output text!", opts), id, "text participates");
  {
    const seq = ["dup", "solo", "dup", "dup"];
    const c1 = new ClusterCounter();
    const c2 = new ClusterCounter();
    const n1 = seq.map((x) => c1.next(x));
    const n2 = seq.map((x) => c2.next(x));
    assert.deepEqual(n1, n2, "two passes over the same content, same numbering");
    assert.deepEqual(n1, ["dup", "solo", "dup_1", "dup_2"]);
  }
  {
    const prefixSeq = ["dup", "solo", "dup"];
    const c1 = new ClusterCounter();
    const first = prefixSeq.map((x) => c1.next(x));
    const c2 = new ClusterCounter();
    const extended = [...prefixSeq, "other", "dup"].map((x) => c2.next(x));
    assert.deepEqual(extended.slice(0, prefixSeq.length), first, "prefix ids stable under extension");
    assert.equal(extended[extended.length - 1], "dup_2", "later duplicate continues the count");
  }
});
