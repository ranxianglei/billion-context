// Regression tests for scripts/kernel-guard-declare.mjs — the kernel-guard
// declaration check (CI arm of the Kernel Boundary human gate, #7542).
//
// The gate must require a STANDALONE 'kernel-change: <reason>' line in the PR
// body, not merely a MENTION of the marker. The old substring grep
// (grep -q 'kernel-change:') let a pending-authorization note that quoted the
// marker through as a false green — PR #7536's body said the declaration was
// "intentionally NOT added until the owner approves" yet kernel-guard reported
// green. #3617: both gate directions asserted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { hasKernelDeclaration } from "../scripts/kernel-guard-declare.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/kernel-guard-declare.mjs");

// CLI verdict: run the real script the way ci.yml does (body piped to stdin),
// exit 0 = declared (gate passes), 1 = not declared (gate fails).
function cliDeclared(body: string): boolean {
  try {
    execFileSync("node", [SCRIPT], { input: body, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// --- unit: the exported predicate (both gate directions) ---

test("a standalone 'kernel-change: <reason>' line satisfies the gate", () => {
  assert.equal(hasKernelDeclaration("kernel-change: fix the fold seam\n"), true);
});

test("a declaration with leading whitespace still satisfies the gate", () => {
  assert.equal(hasKernelDeclaration("  kernel-change: fix the fold seam\n"), true);
});

test("a declaration with a tab after the colon still satisfies the gate", () => {
  assert.equal(hasKernelDeclaration("kernel-change:\tfix the fold seam\n"), true);
});

test("a declaration among other body lines satisfies the gate", () => {
  const body = "## Summary\n\nkernel-change: widen the ref space\n\n## Tests\n...";
  assert.equal(hasKernelDeclaration(body), true);
});

test("a MENTION of the marker in a pending-authorization note does NOT satisfy the gate", () => {
  // PR #7536's actual phrasing: the body quotes the marker while saying the
  // declaration is intentionally absent.
  const body =
    "Kernel authorization pending. The `kernel-change:` declaration is the second element of approval and is intentionally NOT added until the owner approves.\n";
  assert.equal(hasKernelDeclaration(body), false, "a mention must not turn the gate green");
});

test("a mid-sentence mention does NOT satisfy the gate", () => {
  assert.equal(hasKernelDeclaration("we add kernel-change: inline here\n"), false);
});

test("no mention of the marker does NOT satisfy the gate", () => {
  assert.equal(hasKernelDeclaration("This PR fixes the fold seam.\n"), false);
});

test("a declaration without a reason does NOT satisfy the gate", () => {
  assert.equal(hasKernelDeclaration("kernel-change:\n"), false);
  assert.equal(hasKernelDeclaration("kernel-change:   \n"), false);
});

test("empty / null body does NOT satisfy the gate", () => {
  assert.equal(hasKernelDeclaration(""), false);
  assert.equal(hasKernelDeclaration(null), false);
  assert.equal(hasKernelDeclaration(undefined), false);
});

// --- integration: the CLI entry ci.yml actually invokes (both directions) ---

test("CLI: standalone declaration => exit 0 (gate passes)", () => {
  assert.equal(cliDeclared("kernel-change: fix the fold seam\n"), true);
});

test("CLI: mention-only pending note => exit 1 (gate fails) — the #7536 false green", () => {
  const body = "The `kernel-change:` declaration is intentionally NOT added until the owner approves.\n";
  assert.equal(cliDeclared(body), false, "the live #7536 instance must now fail the gate");
});

test("CLI: no mention => exit 1 (gate fails)", () => {
  assert.equal(cliDeclared("This PR fixes the fold seam.\n"), false);
});
