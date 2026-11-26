#!/usr/bin/env node
// Test-import-graph gate (#2989): fails when a TEST file imports a src module
// that is UNREACHABLE from the production import graph (the tsup entries) —
// i.e. the suite pins a module production no longer calls. A green test over
// a retired module guarantees nothing about the wired path (#2988 finding ①:
// the post-restart persona race shipped while every suite pinned the retired
// persona-anchor ladder stayed green). After a wiring swap, regression
// protection must track the live implementation (dual-run twins), not its
// retired ancestor.
//
// Two escape hatches, both explicit so the debt stays greppable:
//   - WHITELIST below: modules that are INTENTIONALLY test-only (coverage
//     registries) or build-time-only (esbuild alias stubs). Each entry must
//     carry its reason and stay reviewable — same discipline as the
//     check-unused-exports waivers.
//   - retired-pin marker: a test file may import an unreachable module ONLY
//     if the file carries a comment line containing
//         // retired-module pin: <module-basename>
//     naming THAT module (e.g. "// retired-module pin: persona-anchor").
//     Characterization pins of a retired implementation must be labeled at
//     the import site — an unlabeled import of dead code fails the build.
//
// Zero dependencies — runs as plain `node`, no install step in CI.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

// Keep in sync with tsup.config.ts `entry`. Drift is asymmetrically safe:
// a missing entry here makes more modules look unreachable (loud); a stale
// entry here makes one look reachable (minor miss). Same list as
// scripts/check-unused-exports.mjs.
const ENTRY_FILES = new Set([
    "src/index.ts",
    "src/mcp.ts",
    "src/claude-mcp-entry.ts",
    "src/claude-native-bootstrap.ts",
    "src/claude-subagent-hook.ts",
    "src/agent/pi.ts",
    "src/agent/pi-native.ts",
    "src/agent/omp.ts",
    "src/agent/omp-native.ts",
    "src/agent/opencode.ts",
    "src/agent/opencode-native.ts",
    "src/agent/dsh-acp.ts",
    "src/agent/dsh-native.ts",
    "src/agent/dsh-compaction-gate.ts",
    "src/kimi/native-mcp.ts",
    "src/kimi/bootstrap-hook.ts",
    "src/zcode/mcp-entry.ts",
    "src/zcode/bootstrap-hook.ts",
    "src/agent/dsh-native-client.ts",
]);

// Intentionally-unreachable modules a test MAY import without a marker.
const WHITELIST = new Map([
    ["src/marker/spec.ts", "test-only registry: marker-lane coverage contract (tests/marker-lane-coverage.test.ts); no runtime behavior is routed through it"],
    ["src/exit-matrix.ts", "test-only registry: wire exit-code truth table (tests/wire-exit-matrix.test.ts); header says 'registry only: no runtime behavior is routed through it'"],
    ["src/agent/pi-host-stub.ts", "build-time-only: esbuild alias target for @earendil-works/pi-coding-agent (tsup.config.ts), unreachable by static imports; pinned by tests/pi-host-stub.test.ts (#3936)"],
]);

function trackedFiles(dir) {
    const out = [];
    const walk = (d) => {
        for (const name of execFileSync("git", ["ls-files", "--", d], { encoding: "utf8" }).split("\n")) {
            if (!name) continue;
            if (name.startsWith(d.endsWith("/") ? d : d + "/") && name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(name);
        }
    };
    walk(dir);
    return out;
}

const SRC_FILES = trackedFiles("src");
const TEST_FILES = trackedFiles("tests");

// Relative import specifiers in a TS source: static `from "..."`, side-effect
// `import "..."`, and dynamic `import("...")`. Textual on purpose (same
// conservative stance as check-unused-exports).
const SPEC_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)\s*["']([^"']+)["']/g;

function localSpecifiers(text) {
    const out = [];
    for (const m of text.matchAll(SPEC_RE)) {
        if (m[1].startsWith(".")) out.push(m[1]);
    }
    return out;
}

function resolveSpec(fromFile, spec) {
    let p = path.resolve(root, path.dirname(fromFile), spec);
    if (!p.endsWith(".ts") && !p.endsWith(".js")) p += ".ts";
    if (p.endsWith(".js")) p = p.slice(0, -3) + ".ts";
    const rel = path.relative(root, p);
    return SRC_FILES.includes(rel) ? rel : null;
}

// BFS from the production entries over relative imports.
const reachable = new Set();
const queue = [...ENTRY_FILES];
while (queue.length > 0) {
    const f = queue.shift();
    if (reachable.has(f) || !SRC_FILES.includes(f)) continue;
    reachable.add(f);
    let text;
    try { text = readFileSync(path.join(root, f), "utf8"); } catch { continue; }
    for (const spec of localSpecifiers(text)) {
        const dep = resolveSpec(f, spec);
        if (dep && !reachable.has(dep)) queue.push(dep);
    }
}

const unreachable = SRC_FILES.filter((f) => !reachable.has(f));
const violations = [];
const noted = [];

for (const testFile of TEST_FILES) {
    let text;
    try { text = readFileSync(path.join(root, testFile), "utf8"); } catch { continue; }
    for (const spec of localSpecifiers(text)) {
        const target = resolveSpec(testFile, spec);
        if (!target || !target.startsWith("src/") || reachable.has(target)) continue;
        const base = path.basename(target, ".ts");
        if (WHITELIST.has(target)) {
            noted.push(`${testFile} → ${target} (whitelisted)`);
            continue;
        }
        if (new RegExp(`retired-module pin:[^\\n]*${base.replace(/[-[\]{}()*+?.^$|]/g, "\\$&")}`).test(text)) {
            noted.push(`${testFile} → ${target} (retired-module pin labeled)`);
            continue;
        }
        violations.push(`${testFile} → ${target}`);
    }
}

console.log(`production entries: ${ENTRY_FILES.size}; src modules: ${SRC_FILES.length}; reachable: ${reachable.size}`);
console.log(`\nunreachable from the production import graph:`);
for (const f of unreachable) console.log(`  ${f}${WHITELIST.has(f) ? `  [whitelisted: ${WHITELIST.get(f)}]` : ""}`);
if (noted.length > 0) {
    console.log("\ntest imports of unreachable modules (permitted):");
    for (const n of noted) console.log(`  ${n}`);
}

if (violations.length > 0) {
    console.error("\nFAIL: test files importing modules absent from the production import graph:");
    for (const v of violations) console.error(`  ${v}`);
    console.error("\nFix: dual-run the pinned behavior against the LIVE implementation (pattern: tests/issue2944-neutral-skeleton.test.ts),");
    console.error("or label the characterization pin with a comment line:  // retired-module pin: <module-basename>");
    process.exit(1);
}
console.log("\nok: every test import of an unreachable module is whitelisted or labeled.");
