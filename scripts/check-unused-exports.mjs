#!/usr/bin/env node
// Unused-export gate (#1440 P6): fails when a non-entry source file exports a
// symbol nobody references. Two categories, both failures:
//   DEAD          — exactly one repo-wide reference: the definition line itself
//   INTERNAL_ONLY — every reference sits inside the declaring file
// Reference counting is textual (word-boundary) over all tracked .ts/.mjs/.cjs
// in src/, tests/, scripts/ and root *.ts — deliberately conservative: a name
// mentioned in a comment or string counts as used, so false POSITIVES require
// purely dynamic out-of-corpus dispatch (none exists here); misses are possible
// for same-named symbols across modules (counting merges them) — safe direction.
// Entry files are skipped entirely: their exports are external API surface
// consumed by hosts outside this repo (opencode/pi/dsh/kimi/zcode loaders).
// Zero dependencies — runs as plain `node`, no install step in CI.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

// Keep in sync with tsup.config.ts `entry`. Drift is asymmetrically safe:
// a missing entry here gets over-gated (loud, fixed in seconds); a stale
// entry here escapes the gate quietly (minor miss).
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

// `--others --exclude-standard` pulls in NEW, not-yet-committed files too:
// a brand-new module is exactly where INTERNAL_ONLY leaks happen, and a
// tracked-only scan would pass locally right before CI fails on the same
// tree (hit on #3273: the fresh src/agent/incremental-client.ts was
// untracked at the local gate run).
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src/", "tests/", "scripts/", "*.ts", "*.mjs", "*.cjs"], {
    cwd: root,
    encoding: "utf8",
}).split("\n").filter(f => f && !f.startsWith("kernel/") && !f.startsWith("pi-subagents/") && f !== "scripts/check-unused-exports.mjs");

// One token-frequency pass per file (word-boundary counting == identifier
// token counting here — both split on non-[\w$]).
const texts = new Map();
const freqs = new Map();
for (const f of files) {
    const text = readFileSync(path.join(root, f), "utf8");
    texts.set(f, text);
    const freq = new Map();
    for (const m of text.matchAll(/[\w$]+/g)) {
        freq.set(m[0], (freq.get(m[0]) ?? 0) + 1);
    }
    freqs.set(f, freq);
}

const DECL_RE = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;

// Waivers: exports intentionally kept public although nothing outside their
// file references them today. This list is the ONLY hole in the gate — every
// entry must carry its reason here and stay reviewable.
const WAIVERS = new Map([
    // #2170 lane-guard: ANY hunk in src/server/side-request.ts forces a paired
    // update of the pinned side-lane suites. These type demotions are
    // behavior-neutral, so we keep the exports rather than churn suites that
    // are truth-table-pinned for reasons unrelated to export hygiene.
    // Remove this waiver when the symbols gain external use or move files.
    ["src/server/side-request.ts", new Set(["DemoteGateSignals", "SideLaneSignals", "SideLaneDecision"])],
    // #R3 memory diagnostics: the two payload interfaces are referenced only
    // inside src/session.ts (callers use them structurally); the functions
    // themselves have cross-file refs (admin.ts, tests/) and need none.
    ["src/session.ts", new Set(["ResidentFieldBreakdown", "MemoryReport"])],
    // #3754 install attribution: the /__bili/status lastInstall payload
    // interface is referenced only inside src/update.ts (admin.ts consumes it
    // structurally via Awaited<ReturnType<typeof getLastInstall>>); keep the
    // export so the wire shape stays named at its definition site.
    ["src/update.ts", new Set(["LastInstallRecord"])],
    // #3962 gate telemetry: the coverage record crosses the gate/dsh-native
    // BUNDLE boundary on the globalThis channel — consumers use it
    // structurally through dshCompactionGateTelemetry()'s return type; keep
    // the export so the channel payload stays named at its definition site.
    ["src/agent/dsh-compaction-disable.ts", new Set(["DshCompactionGateTelemetry"])],
]);

const findings = [];
for (const [file, freq] of freqs) {
    if (ENTRY_FILES.has(file)) continue;
    const names = new Set();
    for (const line of texts.get(file).split("\n")) {
        const m = DECL_RE.exec(line.trimStart());
        if (!m) continue;
        names.add(m[1]); // same-name merge (interface decls etc.)
    }
    for (const name of names) {
        let total = 0;
        for (const f of freqs.values()) total += f.get(name) ?? 0;
        const own = freq.get(name) ?? 0;
        if (total === 1) findings.push({ file, name, kind: "DEAD" });
        else if (total === own) findings.push({ file, name, kind: "INTERNAL_ONLY" });
    }
}

const waived = findings.filter(f => WAIVERS.get(f.file)?.has(f.name));
const failures = findings.filter(f => !WAIVERS.get(f.file)?.has(f.name));
for (const f of waived) console.log(`~ waived         ${f.file}: ${f.name} (see WAIVERS above)`);
if (failures.length > 0) {
    console.error(`✗ ${failures.length} unused export(s):\n`);
    for (const f of failures) console.error(`  ${f.kind.padEnd(13)} ${f.file}: ${f.name}`);
    console.error("\nFix: delete the declaration (DEAD) or drop the leading `export` (INTERNAL_ONLY). Or add a reasoned entry to WAIVERS.");
    console.error("Entry files (tsup.config.ts) are exempt — they are external API surface.");
    process.exit(1);
}
console.log("✓ unused-export gate: clean" + (waived.length ? ` (${waived.length} waived)` : ""));
