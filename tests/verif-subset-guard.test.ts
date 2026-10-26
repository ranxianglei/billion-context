/**
 * CI guard: every file in verif/guarded-files.ts must stay inside the
 * translatable subset (verif/subset-guard.ts). Violations and stale
 * exceptions both fail — there is no silent escape hatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runGuard } from "../verif/subset-guard.js";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

test("guarded kernel files stay inside the verifiable subset", () => {
  const { violations, stale } = runGuard(repoRoot);
  const summary =
    violations.length === 0
      ? ""
      : "\\n" +
        violations
          .map((v) => `  ${v.file}:${v.line} [${v.code}] ${v.detail} (fn ${v.fn ?? "<module>"})`)
          .join("\\n");
  assert.deepEqual(
    violations,
    [],
    `guarded files contain constructs outside the verifiable subset.\\n` +
      `Fix the code, or add a reviewed exception in verif/exceptions.ts:\\n${summary}`,
  );
  assert.deepEqual(
    stale,
    [],
    "exceptions/entries that no longer match anything must be deleted " +
      "(they are an audited inventory):\\n" +
      stale.map((s) => `  ${s.kind}: ${s.label}`).join("\\n"),
  );
});

test("guard actually detects a violation (negative control)", async () => {
  const { checkGuardedFile } = await import("../verif/subset-guard.js");
  const bad = `import fs from "node:fs";\nasync function f(){ return await fs.readFile("x"); }\n`;
  const out = checkGuardedFile({
    file: "kernel/src/refs.ts",
    source: bad,
    excludedFunctions: new Set(),
  });
  const codes = new Set(out.map((v) => v.code));
  assert.ok(codes.has("NODE_BUILTIN_IMPORT"), `expected NODE_BUILTIN_IMPORT, got ${[...codes]}`);
  assert.ok(codes.has("ASYNC"), `expected ASYNC, got ${[...codes]}`);
});
