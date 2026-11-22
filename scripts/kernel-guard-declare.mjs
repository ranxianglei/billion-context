#!/usr/bin/env node
// #7542 — kernel-guard declaration check (the CI arm of the Kernel Boundary
// human gate, AGENTS.md rule 1). A PR touching kernel/** must carry a
// STANDALONE 'kernel-change: <reason>' line in its body.
//
// The old inline check was a plain substring grep (`grep -q 'kernel-change:'`),
// so any body that merely MENTIONED the marker — a pending-authorization note,
// a quote, docs — satisfied the human gate as a false green (live instance:
// PR #7536's body said the declaration was "intentionally NOT added until the
// owner approves" yet kernel-guard reported green).
//
// A declaration is a line that starts (after optional leading whitespace) with
// the literal 'kernel-change:' followed by whitespace and a non-empty reason.
// A mid-sentence mention or a backticked reference cannot satisfy it.
//
// Zero-dep: plain node, no npm install (same posture as config-surface-guard.mjs).
//
// Usage:
//   printf '%s' "$PR_BODY" | node scripts/kernel-guard-declare.mjs   # exit 0 = declared
//   node scripts/kernel-guard-declare.mjs body.txt                   # body from a file
//   import { hasKernelDeclaration } from "../scripts/kernel-guard-declare.mjs"

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Anchored to line start (multiline) so a mention mid-sentence or a backticked
// reference cannot match; a non-empty reason (\S) is required after the colon.
const DECLARATION_RE = /^[ \t]*kernel-change:[ \t]*\S/m;

export function hasKernelDeclaration(body) {
  return DECLARATION_RE.test(body ?? "");
}

// CLI entry: runs only when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const body = process.argv[2]
    ? readFileSync(process.argv[2], "utf8")
    : readFileSync(0, "utf8"); // stdin
  process.exit(hasKernelDeclaration(body) ? 0 : 1);
}
