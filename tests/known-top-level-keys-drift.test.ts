import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    stripComments,
    objectBody,
    parseObjectMembers,
    extractStringSet,
} from "../scripts/config-surface-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const readRel = (p: string) => readFileSync(path.join(root, p), "utf8");

// #7483 — KNOWN_TOP_LEVEL_KEYS is the runtime mirror of the FileConfig type that
// drives the "ignoring unknown top-level config key(s)" warning. A FileConfig
// field added without its mirror entry makes a VALID, consumed config warn as
// unknown (#7483: modelEndpointPatterns and snapshot were both live-consumed yet
// warned). This guard fails on that drift so the mirror stays in lockstep.
//
// Only the FileConfig ⊆ KNOWN direction is asserted: KNOWN may intentionally
// recognize keys outside FileConfig (the established pattern for removed keys,
// which live in the explicit warnUnknownTopLevelKeys filters, not here).

function topLevelFileConfigKeys(src: string): string[] {
    const clean = stripComments(src);
    const fcIdx = clean.indexOf("type FileConfig");
    if (fcIdx < 0) throw new Error("FileConfig not found in config source");
    const body = objectBody(clean, clean.indexOf("{", fcIdx));
    return parseObjectMembers(body).map((m) => m.name);
}

function knownTopLevelKeys(src: string): string[] {
    return extractStringSet(stripComments(src), "KNOWN_TOP_LEVEL_KEYS");
}

function missingFromKnown(src: string): string[] {
    const known = new Set(knownTopLevelKeys(src));
    return topLevelFileConfigKeys(src).filter((k) => !known.has(k)).sort();
}

test("#7483: every FileConfig top-level key is mirrored in KNOWN_TOP_LEVEL_KEYS", () => {
    const src = readRel("src/config.ts");
    const top = topLevelFileConfigKeys(src);
    const known = knownTopLevelKeys(src);
    // Sanity: the extractors really see the surface (not silently empty).
    assert.ok(top.length >= 60, `expected ~65 FileConfig top-level keys, got ${top.length}`);
    assert.ok(known.length >= 60, `expected ~65 KNOWN_TOP_LEVEL_KEYS entries, got ${known.length}`);
    const missing = missingFromKnown(src);
    assert.deepEqual(
        missing,
        [],
        `FileConfig top-level key(s) missing from KNOWN_TOP_LEVEL_KEYS (a valid config would warn as unknown): ${missing.join(", ")}`,
    );
});

test("#7483: the guard is not vacuous — a planted unmapped FileConfig key is caught", () => {
    const src =
        "type FileConfig = {\n" +
        "    port?: number;\n" +
        "    rogueNewKey?: boolean;\n" +
        "}\n" +
        "const KNOWN_TOP_LEVEL_KEYS = new Set([\n" +
        '    "port",\n' +
        "]);\n";
    assert.deepEqual(missingFromKnown(src), ["rogueNewKey"], "planted unmapped key must be flagged");
});

test("#7483: a fully-mapped tree passes (no false positive)", () => {
    const src =
        "type FileConfig = {\n" +
        "    port?: number;\n" +
        "    host?: string;\n" +
        "}\n" +
        "const KNOWN_TOP_LEVEL_KEYS = new Set([\n" +
        '    "port", "host",\n' +
        "]);\n";
    assert.deepEqual(missingFromKnown(src), [], "fully-mapped tree must not flag");
});
