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
    "src/claude-native-bootstrap.ts",
    "src/agent/pi.ts",
    "src/agent/pi-native.ts",
    "src/agent/omp.ts",
    "src/agent/omp-native.ts",
    "src/agent/opencode.ts",
    "src/agent/opencode-native.ts",
    "src/agent/dsh-acp.ts",
    "src/agent/dsh-native.ts",
    "src/kimi/native-mcp.ts",
    "src/kimi/bootstrap-hook.ts",
    "src/zcode/mcp-entry.ts",
    "src/zcode/bootstrap-hook.ts",
]);

const files = execFileSync("git", ["ls-files", "src/", "tests/", "scripts/", "*.ts", "*.mjs", "*.cjs"], {
    cwd: root,
    encoding: "utf8",
}).split("\n").filter(Boolean);

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

if (findings.length > 0) {
    console.error(`✗ ${findings.length} unused export(s):\n`);
    for (const f of findings) console.error(`  ${f.kind.padEnd(13)} ${f.file}: ${f.name}`);
    console.error("\nFix: delete the declaration (DEAD) or drop the leading `export` (INTERNAL_ONLY).");
    console.error("Entry files (tsup.config.ts) are exempt — they are external API surface.");
    process.exit(1);
}
console.log("✓ unused-export gate: clean");
