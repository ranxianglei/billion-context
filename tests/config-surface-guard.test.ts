import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    stripComments,
    extractConfigLeaves,
    extractCliFlags,
    runChecks,
} from "../scripts/config-surface-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const readRel = (p: string) => readFileSync(path.join(root, p), "utf8");

// #2643 — pins that the guard's extractors really see the surface (not silently
// empty), that the current tree is fully documented, and that a planted
// undocumented addition turns the check red rather than passing vacuously.

test("extractors are not vacuous (golden anchors survive)", () => {
    const leaves = extractConfigLeaves(readRel("src/config.ts"));
    for (const want of [
        "network.upstreamTimeoutMs",
        "persist.enabled",
        "sessions.gc.maxAgeDays",
        "dsh.authoredCompaction",
        "mitm.domains",
        "compress.tiers",
        "plugin.snapshotCapBytes",
    ]) {
        assert.ok(leaves.includes(want), `expected leaf ${want} in ${leaves.length} extracted`);
    }
    const flags = extractCliFlags(readRel("src/cli.ts"));
    for (const want of ["--port", "--host", "--config", "--bin", "-F"]) {
        assert.ok(flags.includes(want), `expected flag ${want}`);
    }
});

test("current tree: every config leaf + CLI flag is documented", () => {
    const r = runChecks();
    assert.deepEqual(r.missingLeaves, [], "undocumented config fields: " + r.missingLeaves.join(", "));
    assert.deepEqual(r.missingFlags, [], "undocumented CLI flags: " + r.missingFlags.join(", "));
});

test("a planted undocumented nested config field is caught", () => {
    // Semicolons separate members (TS allows them); mirrors how FileConfig is written.
    const src =
        'const COMPRESS_SETTING_FIELDS = new Set([ "tiers" ]);\n' +
        'type FileConfig = {\n' +
        '  network: { upstreamTimeoutMs: number };\n' +
        '  rogue: { brandNewKnob: boolean };\n' +
        '}\n';
    const leaves = extractConfigLeaves(src);
    assert.ok(leaves.includes("rogue.brandNewKnob"), "planted nested leaf must be extracted");
    const docKeys = new Set(["network.upstreamTimeoutMs"]);
    const missing = leaves.filter((l) => !docKeys.has(l)).sort();
    assert.ok(missing.includes("rogue.brandNewKnob"), "planted leaf must be flagged missing");
    assert.ok(!missing.includes("network.upstreamTimeoutMs"), "documented leaf must not be flagged");
});

test("a planted undocumented CLI flag is caught", () => {
    const src = 'switch (a) {\n  case "--port": break;\n  case "--sneaky-new-flag": break;\n}\n';
    const flags = extractCliFlags(src);
    assert.ok(flags.includes("--sneaky-new-flag"), "planted flag must be extracted");
    const readme = "bili --port 9000";
    const cfgmd = "";
    const missing = flags.filter((f) => f.startsWith("--") && !(readme.includes(f) || cfgmd.includes(f))).sort();
    assert.ok(missing.includes("--sneaky-new-flag"), "planted flag must be flagged missing");
    assert.ok(!missing.includes("--port"), "documented flag must not be flagged");
});

test("stripComments keeps string contents, drops comments", () => {
    const out = stripComments('let a = "// not a comment"; // real comment\n/* block */ let b = "x";');
    assert.ok(out.includes('"// not a comment"'), "string content must survive");
    assert.ok(!out.includes("real comment"), "line comment must be removed");
    assert.ok(!out.includes("block"), "block comment must be removed");
    assert.ok(out.includes('"x"'), "trailing string must survive");
});
