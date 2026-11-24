/**
 * Verif translator: JS `in` operator support (#7627).
 *
 * The translator's `applyBinop` had no `InKeyword` case, so `key in obj`
 * degraded to `{ kind: "any" }` and `truthy(any)` → null → the if-condition
 * degraded. The gap was latent (masked in the #3769 test, whose degradation
 * landed in a discarded sub-context). This fixture puts `in` in a
 * NON-discarded path, so a missing case propagates to `r.degradations` and
 * the test goes red.
 *
 * Semantics: the obj model only tracks own properties via `fields` (not the
 * prototype chain), so a concrete key `l` is "in" `r` iff `r.fields` has
 * `l`. Symbolic keys / non-obj receivers still degrade (documented limit).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { translateFunction } from "../verif/symbolic.js";
import type { SymVal } from "../verif/symbolic.js";
import { newCtx } from "../verif/terms.js";

const file = resolve(import.meta.dirname, "./fixtures/verif-in-op.ts");

/** Constant side-channel: a z3 Bool built from a JS constant carries `.c`. */
const boolVal = (t: unknown): boolean | undefined =>
  t && typeof (t as { c?: unknown }).c === "boolean" ? (t as { c: boolean }).c : undefined;

test("verif: `in` on a concrete object folds to the own-property fact, no degradation (#7627)", () => {
  const ctx = newCtx();

  // value HAS a "range" field → `"range" in value` is true.
  const withRange = new Map<string, SymVal>();
  withRange.set("range", { kind: "str", t: ctx.String.val("1-2") });
  const r1 = translateFunction({
    file, function: "hasRange",
    params: { value: { kind: "obj", fields: withRange } },
    ctx,
  }).exec();
  assert.deepEqual(r1.degradations, [], `no degradations expected (got: ${r1.degradations.join("; ")})`);
  assert.ok(r1.ret && r1.ret.kind === "bool", "result is a bool");
  assert.equal(boolVal((r1.ret as { t: unknown }).t), true, `"range" in value must fold to true`);

  // value does NOT have a "range" field → `"range" in value` is false.
  const noRange = new Map<string, SymVal>();
  noRange.set("other", { kind: "str", t: ctx.String.val("x") });
  const r2 = translateFunction({
    file, function: "hasRange",
    params: { value: { kind: "obj", fields: noRange } },
    ctx,
  }).exec();
  assert.deepEqual(r2.degradations, [], `no degradations expected (got: ${r2.degradations.join("; ")})`);
  assert.ok(r2.ret && r2.ret.kind === "bool", "result is a bool");
  assert.equal(boolVal((r2.ret as { t: unknown }).t), false, `"range" in value must fold to false`);
});

test("verif: symbolic key in `in` degrades (documented limit, not a silent any)", () => {
  const ctx = newCtx();
  // A symbolic key cannot be resolved against the obj's concrete fields —
  // the translator must degrade the if-condition (the documented limit),
  // not guess.
  const key = ctx.String.const("key");
  const fields = new Map<string, SymVal>();
  fields.set("range", { kind: "str", t: ctx.String.val("1-2") });
  const r = translateFunction({
    file, function: "hasKey",
    params: { value: { kind: "obj", fields }, key: { kind: "str", t: key } },
    ctx,
  }).exec();
  assert.ok(r.degradations.length > 0, `symbolic key must degrade the if-condition (got: ${r.degradations.join("; ")})`);
});
