import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { translateFunction, UnsupportedShape } from "../verif/symbolic.js";
import { replay } from "../verif/replay.js";

// The first end-to-end proof target (#3853): refs.ts indexToRef bounds
// behavior. Paths are repo-relative for source reading; the replay import
// specifier is relative to THIS test file (tsx resolves .js → .ts).
const REFS = "kernel/src/refs.ts";
const REFS_IMPORT = "../kernel/src/refs.js";

test("indexToRef: module constants are collected from the real source", async () => {
  const f = await translateFunction(REFS, "indexToRef");
  assert.equal(f.constants.get("MIN_INDEX"), 1n);
  assert.equal(f.constants.get("MAX_INDEX"), 9_999_999n);
  assert.equal(f.constants.get("REF_WIDTH"), 5n);
});

test("indexToRef: in-bounds [MIN_INDEX, MAX_INDEX] never throws (UNSAT)", async () => {
  const f = await translateFunction(REFS, "indexToRef");
  assert.ok(f.throwSites.length > 0, "the RangeError site must be visible to the translator");
  assert.equal(f.throwSites[0]!.ctor, "RangeError");
  const lo = Number(f.constants.get("MIN_INDEX")!);
  const hi = Number(f.constants.get("MAX_INDEX")!);
  const safe = await f.noThrowUnder({ index: [lo, hi] });
  assert.ok(safe, "solver must prove no throw reachable for every in-bounds index");
});

test("indexToRef: out-of-bounds witness replays as RangeError on the real code", async () => {
  const f = await translateFunction(REFS, "indexToRef");
  const w = await f.throwWitness({ index: [-1_000_000, 100_000_000] });
  assert.ok(w, "solver must find an out-of-bounds witness");
  const idx = w!.index;
  assert.ok(idx < 1 || idx > 9_999_999, `witness ${idx} must violate the real bounds`);
  const r = await replay(REFS_IMPORT, "indexToRef", [{ args: [idx], expect: { throws: "RangeError" } }]);
  assert.ok(r[0]!.ok, r[0]!.detail);
});

test("drift control: a skewed boundary lens produces a witness the real code rejects", async () => {
  // Corrupt the spec boundary the translator sees (MAX_INDEX off by one).
  // The skewed lens then "proves" 9999999 throws — the real code does not.
  const f = await translateFunction(REFS, "indexToRef", {
    constantOverrides: { MAX_INDEX: 9_999_998 },
  });
  const w = await f.throwWitness({ index: [9_999_999, 9_999_999] });
  assert.ok(w && w.index === 9_999_999, "skewed lens must still emit its phantom witness");
  const r = await replay(REFS_IMPORT, "indexToRef", [{ args: [9_999_999], expect: { throws: "RangeError" } }]);
  assert.equal(r[0]!.ok, false, "the replay lock must expose the skew");
  assert.match(r[0]!.detail, /REPLAY MISMATCH/);
});

test("replay sanity: in-bound values really return refs on the real code", async () => {
  const r = await replay(REFS_IMPORT, "indexToRef", [
    { args: [1], expect: { returns: true } },
    { args: [9_999_999], expect: { returns: true } },
    { args: [12_345], expect: { returns: true } },
  ]);
  for (const x of r) assert.ok(x.ok, x.detail);
});

test("unmodeled shapes fail loudly instead of approximating", async () => {
  // A function with a loop is outside the MVP subset: the translator must
  // refuse it (stop-the-line), never guess at loop semantics.
  const tmp = ".tmp/symex-refuse-loop.ts";
  fs.mkdirSync(".tmp", { recursive: true });
  fs.writeFileSync(
    tmp,
    "export function sum(n: number): number {\n  let t = 0;\n  for (let i = 0; i < n; i++) t += i;\n  return t;\n}\n",
  );
  await assert.rejects(
    translateFunction(tmp, "sum"),
    (e: unknown) => e instanceof UnsupportedShape && /loop/.test(e.message),
  );
});
