import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, guardSource } from "../verif/subset-guard.js";
import { EXCEPTIONS, EXCLUDED_FUNCTIONS } from "../verif/exceptions.js";
import { GUARDED_FILES } from "../verif/guarded-files.js";

test("Tier A guarded files are green with the registered exception stock", () => {
  const r = evaluate();
  assert.deepEqual(
    r.unregistered.map((v) => `${v.file}:${v.rule}:${v.fn}:${v.expr}`),
    [],
    "every live violation must be registered in verif/exceptions.ts",
  );
  assert.deepEqual(r.expired.map((e) => e.id), [], "no exception may outlive its violation");
  assert.deepEqual(
    r.expiredExclusions.map((e) => e.id),
    [],
    "no exclusion may point at a function that no longer exists",
  );
  // Stock audit: the exception registry is 1:1 with live violations — a count
  // mismatch means either an unregistered violation or padding in the stock.
  assert.equal(
    r.violations.length,
    EXCEPTIONS.length,
    `expected exactly ${EXCEPTIONS.length} live violations, found ${r.violations.length}: ${r.violations
      .map((v) => `${v.file}:${v.rule}@${v.fn}:${v.expr}`)
      .join("; ")}`,
  );
});

test("every registered deviation carries a substantive reason", () => {
  for (const e of EXCEPTIONS) {
    assert.ok(e.reason.trim().length >= 30, `${e.id}: reason must explain why the invariant holds`);
    assert.ok(GUARDED_FILES.includes(e.file as (typeof GUARDED_FILES)[number]), `${e.id}: file must be guarded`);
  }
  for (const e of EXCLUDED_FUNCTIONS) {
    assert.ok(e.reason.trim().length >= 30, `${e.id}: reason required`);
  }
});

// Negative controls: each construct the translator cannot model must make the
// guard fire. If any row stops firing, the guard has developed a hole.
const NEGATIVE_CASES: { rule: string; snippet: string }[] = [
  { rule: "async", snippet: "export async function f(): Promise<number> { return 1; }" },
  { rule: "unknown-global", snippet: "export function f() { return Promise.resolve(1).then((x) => x); }" },
  { rule: "generator", snippet: "export function* g(): Generator<number> { yield 1; }" },
  { rule: "class", snippet: "export class A extends B { m(): number { return 1; } }" },
  { rule: "decorator", snippet: "@dec\nexport class A {}" },
  { rule: "eval", snippet: "export function f(): number { return eval(\"1\"); }" },
  { rule: "eval", snippet: "export function f(): unknown { return new Function(\"return 1\"); }" },
  { rule: "eval", snippet: "export async function f(): Promise<unknown> { return import(\"left-pad\"); }" },
  { rule: "env-access", snippet: "export function f(): string { return process.env.X ?? \"\"; }" },
  { rule: "env-access", snippet: "export function f(): unknown { return globalThis.x; }" },
  { rule: "env-access", snippet: "export function f(): string { return import.meta.url; }" },
  { rule: "unknown-global", snippet: "export function f(): Promise<Response> { return fetch(\"http://x\"); }" },
  { rule: "unwhitelisted-method", snippet: "export function f(a: number[]): number { return a.toFixed2(); }" },
  { rule: "unwhitelisted-constructor", snippet: "export function f(): Blob { return new Blob([\"x\"]); }" },
  { rule: "closure-escape", snippet: "export function f(): () => number { return () => 1; }" },
  {
    rule: "closure-escape",
    snippet: "export function f(h: (n: number) => number): number { const c = () => 1; return h(c); }",
  },
  { rule: "import-specifier", snippet: "import { x } from \"left-pad\";\nexport function f(): number { return x; }" },
  { rule: "import-specifier", snippet: "import { log } from \"../../src/logger.js\";\nexport function f() { log(\"hi\"); }" },
];

for (const c of NEGATIVE_CASES) {
  test(`guard catches ${c.rule}: ${c.snippet.slice(0, 60)}…`, () => {
    const r = guardSource("virtual/negative.ts", c.snippet);
    assert.ok(
      r.violations.some((v) => v.rule === c.rule),
      `expected rule '${c.rule}' to fire, got: ${r.violations.map((v) => v.rule).join(", ") || "(none)"}`,
    );
  });
}

test("guard stays green on the full allowed surface", () => {
  const positive = [
    "const LIMIT = 10_000;",
    "const FLAGS = new Set<string>();",
    "const TABLE = new Map<number, string>();",
    "export function decide(n: number, items: string[]): { ok: boolean; top: string } {",
    "  const clamp = (x: number): number => (x < 1 ? 1 : Math.min(x, LIMIT));",
    "  const scored = items.map((s) => s.trim().toLowerCase());",
    "  const best = scored.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);",
    "  let total = 0;",
    "  for (const s of scored) total += s.length;",
    "  if (clamp(n) > total || total <= 0) {",
    "    throw new RangeError(`bad shape: ${n}`);",
    "  }",
    "  try {",
    "    JSON.parse(\"{}\");",
    "  } catch {",
    "    total = 0;",
    "  }",
    "  FLAGS.add(String(clamp(n)));",
    "  TABLE.set(Math.max(0, n), String(n));",
    "  if (best[0] === undefined) throw new Error(`empty: ${items.length}`);",
    "  return { ok: items.every((s) => typeof s === \"string\"), top: best[0] ?? \"\" };",
    "}",
  ].join("\n");
  const r = guardSource("virtual/positive.ts", positive);
  assert.deepEqual(
    r.violations.map((v) => `${v.rule}@${v.line}`),
    [],
    `allowed surface must not fire: ${r.violations.map((v) => v.message).join("; ")}`,
  );
});

test("an expired exception turns the guard red", () => {
  const fake = {
    id: "fake-expired",
    file: "kernel/src/truncate.ts",
    rule: "unknown-global",
    fn: "clampPrefix",
    expr: "fetch",
    reason: "deliberately stale entry for the negative control",
  };
  const r = evaluate({ exceptions: [...EXCEPTIONS, fake] });
  assert.ok(r.expired.some((e) => e.id === "fake-expired"));
});

test("an exclusion pointing at a missing function turns the guard red", () => {
  const fake = {
    id: "fake-exclusion",
    file: "kernel/src/truncate.ts",
    fn: "doesNotExist",
    reason: "deliberately stale exclusion for the negative control",
  };
  const r = evaluate({ excluded: [...EXCLUDED_FUNCTIONS, fake] });
  assert.ok(r.expiredExclusions.some((e) => e.id === "fake-exclusion"));
});
